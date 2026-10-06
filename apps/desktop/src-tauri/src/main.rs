#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
use host::{Backend, Request};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

const UNAVAILABLE: &str = "Backend unavailable; restart explicitly";
struct Session {
    backend: Option<Arc<Backend>>,
    generation: u64,
}
struct Owner {
    session: Mutex<Session>,
    resources: PathBuf,
    app: tauri::AppHandle,
}
impl Owner {
    fn spawn(&self, generation: u64) -> Result<Backend, String> {
        let app = self.app.clone();
        Backend::spawn(
            &self.resources,
            None,
            Arc::new(move |mut event| {
                event["generation"] = json!(generation);
                let _ = app.emit("machine-backend", event);
            }),
        )
    }
}
// Sends one request to the current backend, holding the session lock only to read it, so a slow
// request never delays a restart, a generation read or quitting.
fn request(session: &Mutex<Session>, request: Request) -> Result<Value, String> {
    let (backend, generation) = {
        let session = session.lock().unwrap();
        (session.backend.clone().ok_or(UNAVAILABLE)?, session.generation)
    };
    let data = backend.request(request)?;
    Ok(json!({"generation": generation, "data": data}))
}
// The current backend's generation, or an error when none is running.
fn generation(session: &Mutex<Session>) -> Result<Value, String> {
    let session = session.lock().unwrap();
    if session.backend.is_none() {
        return Err(UNAVAILABLE.into());
    }
    Ok(json!({"generation": session.generation, "data": null}))
}
async fn dispatch(
    owner: tauri::State<'_, Arc<Owner>>,
    command: Request,
) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request(&owner.session, command))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn backend_generation(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    generation(&owner.session)
}
#[tauri::command]
async fn inspect_machine(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Inspect).await
}
#[tauri::command]
async fn preview_plan(
    owner: tauri::State<'_, Arc<Owner>>,
    exclude: Vec<String>,
) -> Result<Value, String> {
    dispatch(owner, Request::Preview { exclude }).await
}
#[tauri::command]
async fn apply_plan(
    owner: tauri::State<'_, Arc<Owner>>,
    plan_id: String,
) -> Result<Value, String> {
    dispatch(owner, Request::Apply { plan_id }).await
}
#[tauri::command]
async fn cancel_apply(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Cancel).await
}
#[tauri::command]
async fn restart_backend(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut session = owner.session.lock().unwrap();
        if let Some(old) = session.backend.take() {
            old.shutdown();
        }
        session.generation += 1;
        session.backend = Some(Arc::new(owner.spawn(session.generation)?));
        Ok(json!({"generation":session.generation,"data":null}))
    })
    .await
    .map_err(|e| e.to_string())?
}
// The smoke applies a real plan, so it runs only against a throwaway HOME inside the system temp dir.
fn smoke_home(arg: Option<&str>) -> Result<PathBuf, String> {
    let arg = arg.ok_or("Usage: --smoke <temporary HOME> [resources]")?;
    let home = std::fs::canonicalize(arg).map_err(|e| format!("Smoke HOME {arg}: {e}"))?;
    let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    if home == temp || !home.starts_with(&temp) {
        return Err(format!(
            "Smoke HOME {} is not inside {}; refusing to apply to it",
            home.display(),
            temp.display()
        ));
    }
    Ok(home)
}
// Exercises the packaged owner against a temporary HOME; it refuses any other.
fn smoke(resources: PathBuf, home: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let backend = Backend::spawn(
        &resources,
        Some(&home),
        Arc::new(move |event| captured.lock().unwrap().push(event)),
    )?;
    let inspected = backend.request(Request::Inspect)?;
    if !inspected["items"].is_array() || !inspected["profile"]["repo"].is_string() {
        return Err(format!("Unexpected inspect result {inspected}"));
    }
    let preview = backend.request(Request::Preview { exclude: vec![] })?;
    let plan_id = preview["planId"]
        .as_str()
        .ok_or("Missing plan id")?
        .to_string();
    let applied = backend.request(Request::Apply { plan_id })?;
    if applied["status"] != "started" {
        return Err(format!("Unexpected apply result {applied}"));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let end = events.lock().unwrap().iter().find_map(|e| {
            let kind = e["progress"]["type"].as_str()?;
            ["done", "cancelled", "failed"]
                .contains(&kind)
                .then(|| e.clone())
        });
        if let Some(end) = end {
            if end["progress"]["type"] != "done" {
                return Err(format!("Apply did not complete: {end}"));
            }
            break;
        }
        if std::time::Instant::now() > deadline {
            return Err("Apply did not finish".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if !backend
        .request(Request::Preview {
            exclude: vec!["not-an-item".into()],
        })
        .unwrap_err()
        .starts_with("UNKNOWN_KEY")
    {
        return Err("Expected an unknown key to be refused".into());
    }
    backend.request(Request::Cancel)?;
    backend.shutdown();
    println!("Packaged Rust owner smoke passed");
    Ok(())
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--smoke") {
        let home = match smoke_home(std::env::args().nth(2).as_deref()) {
            Ok(home) => home,
            Err(error) => {
                eprintln!("Smoke failed: {error}");
                std::process::exit(1);
            }
        };
        let executable = std::env::current_exe().unwrap();
        let resources = std::env::args()
            .nth(3)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                executable
                    .parent()
                    .unwrap()
                    .join("../Resources/backend-runtime")
            });
        if let Err(error) = smoke(resources, home) {
            eprintln!("Smoke failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("backend-runtime");
            #[cfg(debug_assertions)]
            let resources = if resources.is_dir() {
                resources
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64")
            };
            let owner = Arc::new(Owner {
                session: Mutex::new(Session {
                    backend: None,
                    generation: 1,
                }),
                resources,
                app: app.handle().clone(),
            });
            match owner.spawn(1) {
                Ok(backend) => owner.session.lock().unwrap().backend = Some(Arc::new(backend)),
                Err(error) => eprintln!("Backend startup failed: {error}"),
            }
            app.manage(owner);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_generation,
            inspect_machine,
            preview_plan,
            apply_plan,
            cancel_apply,
            restart_backend
        ])
        .build(tauri::generate_context!())
        .expect("Unable to build the app")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(owner) = app.try_state::<Arc<Owner>>() {
                    let backend = owner.session.lock().unwrap().backend.take();
                    if let Some(backend) = backend {
                        backend.shutdown();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("smoke-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    #[test]
    fn smoke_home_requires_an_argument() {
        assert!(smoke_home(None).unwrap_err().contains("--smoke <temporary HOME>"));
    }
    #[test]
    fn smoke_home_accepts_a_directory_inside_temp() {
        let dir = scratch("ok");
        let home = smoke_home(dir.to_str()).unwrap();
        assert_eq!(home, std::fs::canonicalize(&dir).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn smoke_home_refuses_the_temp_dir_itself() {
        assert!(smoke_home(std::env::temp_dir().to_str()).is_err());
    }
    #[test]
    fn smoke_home_refuses_a_directory_outside_temp() {
        assert!(smoke_home(Some(env!("CARGO_MANIFEST_DIR"))).is_err());
    }
    #[test]
    fn smoke_home_refuses_a_symlink_out_of_temp() {
        let dir = scratch("link");
        let link = dir.join("escape");
        std::os::unix::fs::symlink(env!("CARGO_MANIFEST_DIR"), &link).unwrap();
        assert!(smoke_home(link.to_str()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn smoke_home_refuses_a_missing_path() {
        let missing = std::env::temp_dir().join(format!("smoke-home-missing-{}", std::process::id()));
        assert!(smoke_home(missing.to_str()).is_err());
    }
    #[test]
    fn a_request_in_flight_does_not_block_reading_the_generation() {
        // Answers inspect after a second and shutdown at once.
        let source = r#"
            import { createInterface } from 'node:readline';
            createInterface({ input: process.stdin }).on('line', (line) => {
                const { id, command } = JSON.parse(line);
                const reply = () => process.stdout.write(JSON.stringify({ version: 2, id, ok: true, result: { command } }) + '\n');
                if (command === 'shutdown') { reply(); process.exit(0); }
                setTimeout(reply, 1000);
            });
        "#;
        let (backend, directory) = host::lifecycle_tests::fake_backend(source, Arc::new(|_| {}));
        let session = Arc::new(Mutex::new(Session {
            backend: Some(Arc::new(backend)),
            generation: 7,
        }));
        let inflight = session.clone();
        let slow = std::thread::spawn(move || request(&inflight, Request::Inspect));
        std::thread::sleep(Duration::from_millis(200));
        let started = Instant::now();
        assert_eq!(generation(&session).unwrap()["generation"], 7);
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(!slow.is_finished(), "the inspect should still be in flight");
        let reply = slow.join().unwrap().unwrap();
        assert_eq!(reply["generation"], 7);
        assert_eq!(reply["data"]["command"], "inspect");
        drop(session);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
