#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
use host::Backend;
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
            Arc::new(move |mut event| {
                event["generation"] = json!(generation);
                let _ = app.emit("fixture-backend", event);
            }),
        )
    }
    fn request(&self, command: &str) -> Result<Value, String> {
        let session = self.session.lock().unwrap();
        let data = session
            .backend
            .as_ref()
            .ok_or("Backend unavailable; restart explicitly")?
            .request(command)?;
        Ok(json!({"generation":session.generation,"data":data}))
    }
}
async fn dispatch(
    owner: tauri::State<'_, Arc<Owner>>,
    command: &'static str,
) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || owner.request(command))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn inspect_fixture(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, "inspect").await
}
#[tauri::command]
async fn start_fixture(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, "start").await
}
#[tauri::command]
async fn cancel_fixture(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, "cancel").await
}
#[tauri::command]
async fn crash_probe(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, "crash").await
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
        let data = session.backend.as_ref().unwrap().request("inspect")?;
        Ok(json!({"generation":session.generation,"data":data}))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn smoke(resources: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let backend = Backend::spawn(
        &resources,
        Arc::new(move |event| captured.lock().unwrap().push(event)),
    )?;
    if backend.request("inspect")?["diff"].as_array().map(Vec::len) != Some(2) {
        return Err("Unexpected initial fixture".into());
    }
    backend.request("start")?;
    if !backend.request("start").unwrap_err().starts_with("BUSY") {
        return Err("Expected busy rejection".into());
    }
    backend.request("cancel")?;
    if !events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event["state"] == "cancelled")
    {
        return Err("Missing cancellation event".into());
    }
    backend.request("crash")?;
    std::thread::sleep(std::time::Duration::from_millis(100));
    if backend.request("inspect").is_ok() {
        return Err("Crashed backend accepted a request".into());
    }
    drop(backend);
    let fresh = Backend::spawn(&resources, Arc::new(|_| {}))?;
    if fresh.request("inspect")?["diff"].as_array().map(Vec::len) != Some(2) {
        return Err("Restart retained mutation state".into());
    }
    fresh.request("start")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if fresh.request("inspect")?["diff"]
            .as_array()
            .is_some_and(Vec::is_empty)
        {
            fresh.shutdown();
            println!("Packaged Rust owner smoke passed");
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Err("Fixture did not complete".into())
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
                    .join("../Resources/fixture-runtime")
            });
        if let Err(error) = smoke(resources) {
            eprintln!("Smoke failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("fixture-runtime");
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
            inspect_fixture,
            start_fixture,
            cancel_fixture,
            restart_backend,
            crash_probe
        ])
        .build(tauri::generate_context!())
        .expect("Unable to build fixture app")
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
