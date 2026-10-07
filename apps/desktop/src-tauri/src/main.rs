#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
use host::{Agent, Request, Setup};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

const UNAVAILABLE: &str = "Agent unavailable; restart explicitly";
struct Session {
    agent: Option<Arc<Agent>>,
    generation: u64,
    error: Option<String>,
    closed: bool,
}
struct Owner {
    session: Mutex<Session>,
    lifecycle: Mutex<()>,
    resources: PathBuf,
    app: tauri::AppHandle,
}
impl Owner {
    fn connect(&self, generation: u64, setup: Setup) -> Result<Agent, String> {
        let state_root = host::setup_agent(&self.resources, setup)?;
        let app = self.app.clone();
        Agent::connect_ready(&state_root, Arc::new(move |mut event| {
            event["generation"] = json!(generation);
            let _ = app.emit("machine-agent", event);
        }))
    }
}
/// Holds the session lock only to read the connection and generation.
fn request(session: &Mutex<Session>, request: Request) -> Result<Value, String> {
    let (agent, generation) = {
        let session = session.lock().unwrap();
        (session.agent.clone().ok_or_else(|| session.error.clone().unwrap_or(UNAVAILABLE.into()))?, session.generation)
    };
    let data = agent.request(request)?;
    Ok(json!({"generation":generation,"data":data}))
}
fn generation(session: &Mutex<Session>) -> Result<Value, String> {
    let session = session.lock().unwrap();
    let agent = session.agent.as_ref().filter(|agent| agent.is_connected()).ok_or_else(|| session.error.clone().unwrap_or(UNAVAILABLE.into()))?;
    Ok(json!({"generation":session.generation,"data":{"hello":agent.hello}}))
}
/// Serializes lifecycle helpers and skips any waiting operation superseded by a newer generation.
fn restart(session: &Mutex<Session>, lifecycle: &Mutex<()>, connect: impl FnOnce(u64) -> Result<Agent, String>) -> Result<Value, String> {
    let (old, mine) = {
        let mut session = session.lock().unwrap();
        if session.closed { return Err("App connection closed".into()); }
        session.generation += 1;
        session.error = Some("Connecting to the local agent".into());
        (session.agent.take(), session.generation)
    };
    if let Some(old) = old {
        old.disconnect();
    }
    let _lifecycle = lifecycle.lock().unwrap();
    if session.lock().unwrap().generation != mine {
        return Err("Superseded by a newer restart".into());
    }
    let result = connect(mine);
    let mut current = session.lock().unwrap();
    if current.generation != mine {
        drop(current);
        if let Ok(agent) = result {
            agent.disconnect();
        }
        return Err("Superseded by a newer restart".into());
    }
    match result {
        Ok(agent) => {
            let data = json!({"hello":agent.hello});
            current.agent = Some(Arc::new(agent));
            current.error = None;
            Ok(json!({"generation":mine,"data":data}))
        }
        Err(error) => {
            current.error = Some(error.clone());
            Err(error)
        }
    }
}
fn close(session: &Mutex<Session>) {
    let agent = {
        let mut session = session.lock().unwrap();
        session.closed = true;
        session.generation += 1;
        session.agent.take()
    };
    if let Some(agent) = agent {
        agent.disconnect();
    }
}
async fn dispatch(owner: tauri::State<'_, Arc<Owner>>, command: Request) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || request(&owner.session, command)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn agent_generation(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    generation(&owner.session)
}
#[tauri::command]
async fn agent_status(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Status).await
}
#[tauri::command]
async fn inspect_machine(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Inspect).await
}
#[tauri::command]
async fn preview_plan(owner: tauri::State<'_, Arc<Owner>>, exclude: Vec<String>) -> Result<Value, String> { dispatch(owner, Request::Preview { exclude }).await }
#[tauri::command]
async fn apply_plan(owner: tauri::State<'_, Arc<Owner>>, plan_id: String) -> Result<Value, String> { dispatch(owner, Request::Apply { plan_id }).await }
#[tauri::command]
async fn cancel_apply(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    dispatch(owner, Request::Cancel).await
}
#[tauri::command]
async fn restart_agent(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restart(&owner.session, &owner.lifecycle, |g| owner.connect(g, Setup::Restart))).await.map_err(|e| e.to_string())?
}
/// Smoke may apply only inside a canonicalized throwaway HOME under the system temporary root.
fn smoke_home(arg: Option<&str>) -> Result<PathBuf, String> {
    let arg = arg.ok_or("Usage: --smoke <temporary HOME> [resources]")?;
    let home = std::fs::canonicalize(arg).map_err(|e| format!("Smoke HOME {arg}: {e}"))?;
    let temp = std::fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    if home == temp || !home.starts_with(&temp) || !home.is_dir() {
        return Err(format!("Smoke HOME {} is not inside {}; refusing to apply to it", home.display(), temp.display()));
    }
    Ok(home)
}
/// Connects directly to the foreground test agent supplied by the JS smoke, without registration.
fn smoke(home: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let agent = Agent::connect(&home.join(".config/nortuscc"), Arc::new(move |event| captured.lock().unwrap().push(event)))?;
    let inspected = agent.request(Request::Inspect)?;
    if !inspected["items"].is_array() || !inspected["profile"]["repo"].is_string() { return Err(format!("Unexpected inspect result {inspected}")); }
    let preview = agent.request(Request::Preview { exclude: vec![] })?;
    let plan_id = preview["planId"].as_str().ok_or("Missing plan id")?.to_string();
    let applied = agent.request(Request::Apply { plan_id })?;
    if applied["status"] != "started" { return Err(format!("Unexpected apply result {applied}")); }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        let end = events.lock().unwrap().iter().find_map(|e| {
            let kind = e["progress"]["type"].as_str()?;
            ["done", "cancelled", "failed"].contains(&kind).then(|| e.clone())
        });
        if let Some(end) = end {
            if end["progress"]["type"] != "done" { return Err(format!("Apply did not complete: {end}")); }
            break;
        }
        if std::time::Instant::now() > deadline { return Err("Apply did not finish".into()); }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let error = agent.request(Request::Preview { exclude: vec!["not-an-item".into()] }).err().ok_or("Expected an unknown key to be refused")?;
    if !error.starts_with("UNKNOWN_KEY") { return Err(format!("Expected UNKNOWN_KEY, got {error}")); }
    agent.request(Request::Cancel)?;
    agent.disconnect();
    println!("Packaged Rust owner smoke passed");
    Ok(())
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--smoke") {
        let result = smoke_home(std::env::args().nth(2).as_deref()).and_then(smoke);
        if let Err(error) = result { eprintln!("Smoke failed: {error}"); std::process::exit(1); }
        return;
    }
    tauri::Builder::default()
        .setup(|app| {
            let resources = app.path().resource_dir()?.join("agent-runtime");
            #[cfg(debug_assertions)]
            let resources = if resources.is_dir() { resources } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64") };
            let owner = Arc::new(Owner {
                session: Mutex::new(Session { agent: None, generation: 0, error: None, closed: false }),
                lifecycle: Mutex::new(()), resources, app: app.handle().clone(),
            });
            if let Err(error) = restart(&owner.session, &owner.lifecycle, |g| owner.connect(g, Setup::Ensure)) { eprintln!("Agent startup failed: {error}"); }
            app.manage(owner);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![agent_generation, agent_status, inspect_machine, preview_plan, apply_plan, cancel_apply, restart_agent])
        .build(tauri::generate_context!()).expect("Unable to build the app")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(owner) = app.try_state::<Arc<Owner>>() {
                    close(&owner.session);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use host::fixtures::{idle_agent, Fixture};
    use std::{sync::mpsc, thread, time::{Duration, Instant}};
    fn session(generation: u64) -> Mutex<Session> { Mutex::new(Session { agent: None, generation, error: None, closed: false }) }
    #[test]
    fn smoke_home_requires_a_directory_under_the_canonical_system_temporary_root() {
        assert!(smoke_home(None).is_err());
        assert!(smoke_home(std::env::temp_dir().to_str()).is_err());
        assert!(smoke_home(Some(env!("CARGO_MANIFEST_DIR"))).is_err());
        assert!(smoke_home(Some("/this/path/does/not/exist")).is_err());
        let root = std::env::temp_dir().join(format!("ncc-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(smoke_home(root.to_str()).unwrap(), std::fs::canonicalize(&root).unwrap());
        let link = root.join("escape"); std::os::unix::fs::symlink(env!("CARGO_MANIFEST_DIR"), &link).unwrap();
        assert!(smoke_home(link.to_str()).is_err());
        let file = root.join("file"); std::fs::write(&file, "x").unwrap(); assert!(smoke_home(file.to_str()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_request_in_flight_does_not_block_generation_reads() {
        let (entered, received) = mpsc::channel(); let (release, held) = mpsc::channel();
        let fixture = Fixture::new(move |mut wire| {
            wire.handshake(); let request = wire.next().unwrap(); entered.send(()).unwrap(); held.recv().unwrap();
            wire.reply(&request, json!({"items":[]})); assert!(wire.next().is_none());
        });
        let session = Arc::new(session(7));
        session.lock().unwrap().agent = Some(Arc::new(fixture.connect(Arc::new(|_| {}))));
        let in_flight = session.clone(); let job = thread::spawn(move || request(&in_flight, Request::Inspect));
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        let start = Instant::now(); let snapshot = generation(&session).unwrap();
        assert_eq!(snapshot["generation"], 7); assert_eq!(snapshot["data"]["hello"]["protocol"], 3); assert!(start.elapsed() < Duration::from_millis(100));
        release.send(()).unwrap(); assert_eq!(job.join().unwrap().unwrap()["generation"], 7);
        close(&session); fixture.finish();
    }
    #[test]
    fn failed_initialization_stays_offline_and_explicit_restart_recovers() {
        let session = session(0); let lifecycle = Mutex::new(());
        assert_eq!(restart(&session, &lifecycle, |_| Err("UNAUTHORIZED: refused".into())).unwrap_err(), "UNAUTHORIZED: refused");
        assert_eq!(generation(&session).unwrap_err(), "UNAUTHORIZED: refused");
        assert_eq!(request(&session, Request::Inspect).unwrap_err(), "UNAUTHORIZED: refused");
        let (agent, fixture) = idle_agent();
        assert_eq!(restart(&session, &lifecycle, |_| Ok(agent)).unwrap()["generation"], 2);
        assert!(generation(&session).is_ok()); close(&session); fixture.finish();
    }
    #[test]
    fn restarting_does_not_hold_the_session_mutex_while_waiting() {
        let session = Arc::new(session(3)); let lifecycle = Arc::new(Mutex::new(()));
        let (entered, received) = mpsc::channel(); let (release, held) = mpsc::channel();
        let (agent, fixture) = idle_agent();
        let s = session.clone(); let l = lifecycle.clone();
        let slow = thread::spawn(move || restart(&s, &l, |_| { entered.send(()).unwrap(); held.recv().unwrap(); Ok(agent) }));
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        let start = Instant::now(); assert!(generation(&session).is_err()); assert!(start.elapsed() < Duration::from_millis(100));
        release.send(()).unwrap(); assert_eq!(slow.join().unwrap().unwrap()["generation"], 4);
        close(&session); fixture.finish();
    }
    #[test]
    fn superseded_waiting_helpers_never_run_and_newest_generation_wins() {
        let session = Arc::new(session(0)); let lifecycle = Arc::new(Mutex::new(()));
        let (entered, received) = mpsc::channel(); let (release, held) = mpsc::channel();
        let (old_agent, old_fixture) = idle_agent(); let (new_agent, new_fixture) = idle_agent();
        let s = session.clone(); let l = lifecycle.clone();
        let old = thread::spawn(move || restart(&s, &l, |_| { entered.send(()).unwrap(); held.recv().unwrap(); Ok(old_agent) }));
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        let s = session.clone(); let l = lifecycle.clone();
        let waiting = thread::spawn(move || restart(&s, &l, |_| panic!("A superseded helper must not run")));
        wait_generation(&session, 2);
        let s = session.clone(); let l = lifecycle.clone();
        let newest = thread::spawn(move || restart(&s, &l, |_| Ok(new_agent)));
        wait_generation(&session, 3); release.send(()).unwrap();
        assert!(old.join().unwrap().unwrap_err().contains("Superseded"));
        assert!(waiting.join().unwrap().unwrap_err().contains("Superseded"));
        assert_eq!(newest.join().unwrap().unwrap()["generation"], 3);
        assert_eq!(request(&session, Request::Inspect).unwrap()["data"]["command"], "inspect");
        old_fixture.finish(); close(&session); new_fixture.finish();
    }
    fn wait_generation(session: &Mutex<Session>, wanted: u64) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.lock().unwrap().generation < wanted { assert!(Instant::now() < deadline); thread::sleep(Duration::from_millis(1)); }
    }
    #[test]
    fn closing_during_a_helper_rejects_publication_without_stopping_the_service() {
        let session = Arc::new(session(0)); let lifecycle = Arc::new(Mutex::new(()));
        let (entered, received) = mpsc::channel(); let (release, held) = mpsc::channel();
        let (agent, fixture) = idle_agent();
        let s = session.clone(); let l = lifecycle.clone();
        let job = thread::spawn(move || restart(&s, &l, |_| { entered.send(()).unwrap(); held.recv().unwrap(); Ok(agent) }));
        received.recv_timeout(Duration::from_secs(1)).unwrap(); close(&session); release.send(()).unwrap();
        assert!(job.join().unwrap().unwrap_err().contains("Superseded"));
        assert!(restart(&session, &lifecycle, |_| panic!("Closed app must not invoke a helper")).is_err());
        fixture.finish();
    }
    #[test]
    fn restart_disconnects_the_old_socket_without_shutdown() {
        let session = session(2); let lifecycle = Mutex::new(());
        let (old, old_fixture) = idle_agent(); let (new, new_fixture) = idle_agent();
        session.lock().unwrap().agent = Some(Arc::new(old));
        assert_eq!(restart(&session, &lifecycle, |_| Ok(new)).unwrap()["generation"], 3);
        old_fixture.finish(); close(&session); new_fixture.finish();
    }
    #[test]
    fn smoke_connects_directly_and_never_spawns_a_registration_helper() {
        let home = std::env::temp_dir().join(format!("ncc-{:x}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap(); let home = smoke_home(home.to_str()).unwrap();
        let state = home.join(".config/nortuscc"); let directory = state.join("agent"); std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("agent.token"), "token-a").unwrap();
        let listener = std::os::unix::net::UnixListener::bind(directory.join("agent.sock")).unwrap();
        let worker = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap(); let mut wire = host::fixtures::Wire::new(socket); wire.handshake();
            let inspect = wire.next().unwrap(); assert_eq!(inspect["command"], "inspect"); wire.reply(&inspect, json!({"items":[],"profile":{"repo":"/fake"}}));
            let preview = wire.next().unwrap(); assert_eq!(preview["command"], "preview"); wire.reply(&preview, json!({"planId":"p"}));
            let apply = wire.next().unwrap(); assert_eq!(apply["command"], "apply"); wire.reply(&apply, json!({"status":"started","runId":"r"}));
            wire.send(json!({"version":3,"event":"progress","runId":"r","progress":{"type":"done","ok":0,"failed":0}}));
            let unknown = wire.next().unwrap(); assert_eq!(unknown["exclude"], json!(["not-an-item"])); wire.error(&unknown, "UNKNOWN_KEY");
            let cancel = wire.next().unwrap(); assert_eq!(cancel["command"], "cancel"); wire.reply(&cancel, json!({"cancelled":true}));
            assert!(wire.next().is_none());
        });
        smoke(home.clone()).unwrap(); worker.join().unwrap(); std::fs::remove_dir_all(home).unwrap();
    }
}
