#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
use host::{Backend, Request};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

struct Session {
    backend: Option<Backend>,
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
    fn request(&self, request: Request) -> Result<Value, String> {
        let session = self.session.lock().unwrap();
        let data = session
            .backend
            .as_ref()
            .ok_or("Backend unavailable; restart explicitly")?
            .request(request)?;
        Ok(json!({"generation":session.generation,"data":data}))
    }
}
async fn dispatch(
    owner: tauri::State<'_, Arc<Owner>>,
    request: Request,
) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || owner.request(request))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn backend_generation(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let session = owner.session.lock().unwrap();
    if session.backend.is_none() {
        return Err("Backend unavailable; restart explicitly".into());
    }
    Ok(json!({"generation": session.generation, "data": null}))
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
        session.backend = Some(owner.spawn(session.generation)?);
        Ok(json!({"generation":session.generation,"data":null}))
    })
    .await
    .map_err(|e| e.to_string())?
}
// Exercises the packaged owner against the machine at $HOME (the smoke script passes a temporary one).
fn smoke(resources: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let backend = Backend::spawn(
        &resources,
        None,
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
        let executable = std::env::current_exe().unwrap();
        let resources = std::env::args()
            .nth(2)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                executable
                    .parent()
                    .unwrap()
                    .join("../Resources/backend-runtime")
            });
        if let Err(error) = smoke(resources) {
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
                Ok(backend) => owner.session.lock().unwrap().backend = Some(backend),
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
                    if let Some(backend) = owner.session.lock().unwrap().backend.take() {
                        backend.shutdown();
                    }
                }
            }
        });
}
