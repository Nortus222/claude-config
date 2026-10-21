#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod host;
mod mcp;
mod startup;
mod startup_diagnostics;
mod updates;
mod update_payload;
mod update_service;
mod updater_transport;
mod display_name_categories;
mod notifications;
#[cfg(windows)]
mod pipe;
#[cfg(windows)]
mod agent_child;
use host::{Agent, Request, Setup};
use startup_diagnostics::{Operation, Phase};
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
    initial_setup: Option<Value>,
}
struct Owner {
    session: Mutex<Session>,
    lifecycle: Mutex<()>,
    resources: PathBuf,
    app: tauri::AppHandle,
    review: Arc<notifications::ReviewRoute>,
    startup: Arc<startup::Startup>,
    /// The agent state root of the last connection, so Show in Finder needs no helper while connected.
    state_root: Mutex<Option<PathBuf>>,
    /// The app-owned agent process; Windows has no login service.
    #[cfg(windows)]
    child: agent_child::AgentChild,
}
impl Owner {
    /// The agent state root: the connected one, else the fixed read-only helper's answer.
    fn state_root(&self) -> Result<PathBuf, String> {
        if let Some(root) = self.state_root.lock().unwrap().clone() { return Ok(root); }
        host::setup_agent(&self.resources, Setup::Paths)
    }
    fn connect(self: &Arc<Self>, generation: u64, setup: Setup) -> Result<(Agent, bool), String> {
        let trace = startup_diagnostics::trace(setup.operation());
        // Restart replaces the app's own agent anyway; stopping it first frees its lock for the helper's ownership check.
        #[cfg(windows)]
        if matches!(setup, Setup::Restart) { self.child.stop(); }
        let recovered=matches!(setup,Setup::Ensure|Setup::Restart) && trace.measure(Phase::MaintenanceState, || update_service::maintenance_state(&self.resources))?.pending;
        let state_root = if recovered {
            let result=update_service::recover(&self.resources,&self.app.package_info().version.to_string());
            if result.is_err() {self.startup.coordinator()?.recovery("Interrupted app update needs recovery. The existing setup and app backup are retained; repair or restart this app.");}
            result?
        } else {host::setup_agent(&self.resources, setup)?};
        #[cfg(windows)]
        self.child.ensure(&self.resources, &state_root, matches!(setup, Setup::Restart))?;
        self.connect_from_root(generation, &state_root, setup.operation()).map(|agent| (agent, recovered))
    }
    fn connect_from_root(self: &Arc<Self>, generation: u64, state_root: &std::path::Path, operation: Operation) -> Result<Agent, String> {
        self.connect_from_root_cancelled(generation,state_root,operation,None)
    }
    fn connect_from_root_cancelled(self: &Arc<Self>, generation: u64, state_root: &std::path::Path, operation: Operation, cancel: Option<Arc<std::sync::atomic::AtomicBool>>) -> Result<Agent, String> {
        let app = self.app.clone();
        let (send, receive) = std::sync::mpsc::channel();
        let live=Arc::downgrade(self);
        let agent = connect_runtime_cancelled(&self.resources, state_root, Arc::new(move |mut event| {
            let Some(owner)=live.upgrade() else {return;};
            {let current=owner.session.lock().unwrap();if current.closed || current.generation!=generation {return;}}
            if event["event"] == "notification" {
                if let Ok(delivery) = notifications::Delivery::decode(event) { let _ = send.send(delivery); }
                return;
            }
            event["generation"] = json!(generation);
            let _ = app.emit("machine-agent", event);
        }), operation, cancel)?;
        *self.state_root.lock().unwrap() = Some(state_root.to_path_buf());
        let owner = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Ok(delivery) = receive.recv() {
                let Some(owner) = owner.upgrade() else { return; };
                let _ = deliver_current(&owner.session, &owner.lifecycle, generation, delivery, &notifications::post);
            }
        });
        Ok(agent)
    }
}
#[cfg(all(test, unix))]
fn connect_runtime(resources: &std::path::Path, state_root: &std::path::Path, emit: host::Emit, operation: Operation) -> Result<Agent, String> {
    connect_runtime_cancelled(resources,state_root,emit,operation,None)
}
fn connect_runtime_cancelled(resources: &std::path::Path, state_root: &std::path::Path, emit: host::Emit, operation: Operation, cancel: Option<Arc<std::sync::atomic::AtomicBool>>) -> Result<Agent, String> {
    let agent = match cancel {Some(cancel)=>Agent::connect_ready_cancelled(state_root,emit,operation,Some(cancel)),None=>Agent::connect_ready(state_root,emit,operation)}?;
    if let Err(error) = startup_diagnostics::trace(operation).measure(Phase::RuntimeIdentity, || runtime_identity(resources, agent.hello["agentVersion"].as_str())) {
        agent.disconnect(); return Err(error);
    }
    Ok(agent)
}
fn runtime_identity(resources: &std::path::Path, agent_version: Option<&str>) -> Result<(), String> {
    let metadata: Value = serde_json::from_slice(&std::fs::read(resources.join("runtime.json")).map_err(|_| "Cannot read installed agent identity")?).map_err(|_| "Invalid installed agent identity")?;
    if metadata["agentVersion"].as_str() != agent_version { return Err("Connected agent does not match the installed app runtime".into()); }
    Ok(())
}
/// Startup events wait for publication; posting and ACK never run on the socket reader.
fn deliver_current(session: &Mutex<Session>, lifecycle: &Mutex<()>, mine: u64, delivery: notifications::Delivery, post: &notifications::Poster<'_>) -> Result<bool, String> {
    let agent = {
        let _lifecycle = lifecycle.lock().unwrap();
        let current = session.lock().unwrap();
        if current.closed || current.generation != mine { return Ok(false); }
        current.agent.clone().ok_or(UNAVAILABLE)?
    };
    let deadline = delivery.received_at + std::time::Duration::from_secs(3);
    let active = || {
        let current = session.lock().unwrap();
        !current.closed && current.generation == mine && agent.is_connected() && std::time::Instant::now() < deadline
    };
    notifications::deliver(&agent, &delivery.notification, &delivery.receipt, &active, post)
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
#[cfg(all(test, unix))]
fn restart(session: &Mutex<Session>, lifecycle: &Mutex<()>, connect: impl FnOnce(u64) -> Result<Agent, String>) -> Result<Value, String> {
    restart_with_completion(session, lifecycle, |g| connect(g).map(|agent| (agent, false)), || {})
}
fn restart_with_completion(session: &Mutex<Session>, lifecycle: &Mutex<()>, connect: impl FnOnce(u64) -> Result<(Agent, bool), String>, recovered: impl FnOnce()) -> Result<Value, String> {
    let (old, mine) = {
        let mut session = session.lock().unwrap();
        if session.closed { return Err("App connection closed".into()); }
        session.generation += 1;
        session.initial_setup = None;
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
        if let Ok((agent, _)) = result {
            agent.disconnect();
        }
        return Err("Superseded by a newer restart".into());
    }
    match result {
        Ok((agent, did_recover)) => {
            let data = json!({"hello":agent.hello});
            current.agent = Some(Arc::new(agent));
            current.error = None;
            if did_recover { recovered(); }
            Ok(json!({"generation":mine,"data":data}))
        }
        Err(error) => {
            current.error = Some(error.clone());
            Err(error)
        }
    }
}
/// The fixed helper already performed the eligible lifecycle action; startup only connects.
fn initial_connection(session: &Mutex<Session>, lifecycle: &Mutex<()>, context: &host::StartupContext, connect: impl FnOnce(u64, &std::path::Path) -> Result<Agent, String>, recovered: impl FnOnce()) -> Result<Option<Value>, String> {
    use host::StartupOutcome;
    let mine = { let current=session.lock().unwrap(); if current.closed {return Err("App connection closed".into());} current.generation };
    let should_connect = matches!(context.outcome, StartupOutcome::Ready | StartupOutcome::Recovered);
    let result = if should_connect {
        restart_with_completion(session, lifecycle, |g| connect(g, &context.state_root).map(|agent| (agent, context.outcome==StartupOutcome::Recovered)), recovered).map(Some)
    } else {
        let _lifecycle=lifecycle.lock().unwrap();
        let current=session.lock().unwrap();
        if current.closed || current.generation!=mine {return Err("Superseded by a newer restart".into());}
        match context.outcome {
            StartupOutcome::NeedsSetup => Ok(None),
            StartupOutcome::SetupFailed => Err("Existing setup could not be read; it has been retained".into()),
            StartupOutcome::RuntimeFailed => Err("Installed agent runtime could not be validated".into()),
            StartupOutcome::MaintenanceFailed => Err("Maintenance state could not be read; existing setup is retained".into()),
            StartupOutcome::EnsureFailed => Err("Agent startup failed; restart explicitly".into()),
            StartupOutcome::RecoveryFailed => Err("Interrupted app update needs recovery; existing setup and backup are retained".into()),
            _ => unreachable!(),
        }
    };
    let expected=mine+u64::from(should_connect);
    let mut current=session.lock().unwrap();
    if !current.closed && current.generation==expected {current.initial_setup=context.setup.clone();}
    result
}
/// Ordinary checks need only trusted context; recovered startup publishes its final health result.
fn startup_connection(session: &Mutex<Session>, lifecycle: &Mutex<()>, startup: &startup::Startup,
    context: Result<host::StartupContext,String>, coordinator: Arc<updates::Coordinator>,
    connect: impl FnOnce(u64,&std::path::Path) -> Result<Agent,String>) -> Result<Option<Value>,String> {
    let recovered=context.as_ref().is_ok_and(|context|context.outcome==host::StartupOutcome::Recovered);
    {
        let current=session.lock().unwrap();
        if current.closed || current.generation!=1 {return Err("Superseded startup".into());}
        if !recovered {startup.publish(coordinator.clone())?;}
    }
    let result=match context {
        Ok(context)=>initial_connection(session,lifecycle,&context,connect,||coordinator.recovered()),
        Err(_)=>Err("Desktop startup helper failed; existing setup is retained. Restart explicitly".into()),
    };
    if recovered {
        let current=session.lock().unwrap();
        if current.closed || current.generation!=2 {return Err("Superseded startup".into());}
        startup.publish(coordinator)?;
    }
    result
}
/// Resolves the single trusted startup context outside the event loop.
fn run_startup(owner: Arc<Owner>, source: Result<Option<Arc<dyn updates::UpdateSource>>,String>) {
    let trace=startup_diagnostics::trace(Operation::AppStartup);
    let _=trace.measure(Phase::StartupWorker, || -> Result<(),String> {
        let cancel=owner.startup.cancellation();
        let context=trace.measure(Phase::Lifecycle, ||host::desktop_startup_cancelled(&owner.resources,&owner.app.package_info().version.to_string(),cancel.clone()));
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {return Err("App connection closed".into());}
        let preferences=startup_preferences(&context);
        let coordinator=Arc::new(updates::Coordinator::new(&owner.app.package_info().version.to_string(),source.as_ref().ok().and_then(Clone::clone).filter(|_|context.is_ok()),Arc::new(update_service::NativeHelper::new(owner.resources.clone())),preferences));
        if source.is_err() {coordinator.recovery("Updater release configuration is invalid; signed updates are disabled.");}
        match &context {
            Err(_)=>coordinator.recovery("Startup state root could not be validated; signed updates are disabled. Existing setup is retained; retry startup recovery."),
            Ok(context) if context.maintenance.as_ref().is_some_and(|state|state.pending)=>coordinator.recovery("An interrupted update is pending. Existing setup validation and agent health must succeed before applying."),
            Ok(context) if matches!(context.outcome,host::StartupOutcome::SetupFailed|host::StartupOutcome::RuntimeFailed|host::StartupOutcome::MaintenanceFailed)=>coordinator.recovery("Startup validation failed. Existing setup is retained; retry startup recovery."),
            _=>{},
        }
        let connected=startup_connection(&owner.session,&owner.lifecycle,&owner.startup,context,coordinator,
            |g,root|{
                #[cfg(windows)]
                owner.child.ensure(&owner.resources, root, false)?;
                owner.connect_from_root_cancelled(g,root,Operation::AppStartup,Some(cancel))
            });
        if let Err(error)=connected {
            let mut current=owner.session.lock().unwrap();
            if !current.closed && current.generation<=2 {current.error=Some(error);}
        }
        Ok(())
    });
}
fn startup_preferences(context: &Result<host::StartupContext,String>) -> Option<PathBuf> {
    context.as_ref().ok().map(|context|context.state_root.join("agent/update-settings.json"))
}
fn close(session: &Mutex<Session>) {
    let agent = {
        let mut session = session.lock().unwrap();
        session.closed = true;
        session.initial_setup = None;
        session.generation += 1;
        session.agent.take()
    };
    if let Some(agent) = agent {
        agent.disconnect();
    }
}
async fn dispatch(owner: tauri::State<'_, Arc<Owner>>, command: Request) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?; request(&owner.session, command)}).await.map_err(|e| e.to_string())?
}
#[tauri::command]
async fn agent_generation(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;generation(&owner.session)}).await.map_err(|_|"Startup readiness stopped".to_string())?
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
async fn restart_agent(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value, String> {
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;let updates=owner.startup.coordinator()?; restart_with_completion(&owner.session, &owner.lifecycle, |g| owner.connect(g, Setup::Restart), ||updates.recovered())}).await.map_err(|e| e.to_string())?
}
fn native_args<T: serde::de::DeserializeOwned>(request: tauri::ipc::Request<'_>) -> Result<T, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Json(value) => host::decode_args(value.clone()),
        _ => Err("Expected JSON command arguments".into()),
    }
}
#[tauri::command]
async fn operation(owner: tauri::State<'_, Arc<Owner>>, name: String, input: Value) -> Result<Value, String> {
    dispatch(owner, Request::Operation { name, input }).await
}
#[tauri::command]
async fn get_operation_run(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::OperationRunArgs = native_args(request)?;
    dispatch(owner, Request::GetOperationRun { run_id: args.run_id }).await
}
#[tauri::command]
async fn list_operation_runs(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::OperationRunsArgs = native_args(request)?;
    dispatch(owner, Request::ListOperationRuns { limit: args.limit }).await
}
#[tauri::command]
async fn hosted_state(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; dispatch(owner, Request::HostedState).await
}
#[tauri::command]
async fn sign_in(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::SignInArgs = native_args(request)?;
    dispatch(owner, Request::SignIn { name: args.name, report_status: args.report_status }).await
}
#[tauri::command]
async fn sign_out(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; dispatch(owner, Request::SignOut).await
}
#[tauri::command]
async fn sync_now(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; dispatch(owner, Request::SyncNow).await
}
#[tauri::command]
async fn trust_setup(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::TrustArgs = native_args(request)?; dispatch(owner, Request::TrustSetup { setup_id: args.setup_id }).await
}
#[tauri::command]
async fn machine_settings(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::MachineArgs = native_args(request)?; dispatch(owner, Request::MachineSettings { patch: args.patch }).await
}
#[tauri::command]
async fn set_policy(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::PolicyArgs = native_args(request)?; dispatch(owner, Request::SetPolicy { policy: args.policy }).await
}
#[tauri::command]
async fn resume_agent(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; dispatch(owner, Request::Resume).await
}
fn helper_response(session: &Mutex<Session>, lifecycle: &Mutex<()>, action: impl FnOnce() -> Result<Value,String>) -> Result<Value,String> {
    let mine = { let current=session.lock().unwrap(); if current.closed {return Err("App connection closed".into());} current.generation };
    let _lifecycle=lifecycle.lock().unwrap();
    {let current=session.lock().unwrap();if current.closed || current.generation!=mine {return Err("Superseded by a newer restart".into());}}
    let data=action()?;
    let current=session.lock().unwrap();
    if current.closed || current.generation!=mine {return Err("Superseded by a newer restart".into());}
    Ok(json!({"generation":mine,"data":data}))
}
fn setup_state_response(session: &Mutex<Session>, lifecycle: &Mutex<()>, fresh: impl FnOnce() -> Result<Value,String>) -> Result<Value,String> {
    helper_response(session,lifecycle,||{
        let snapshot=session.lock().unwrap().initial_setup.take();
        match snapshot {Some(value)=>Ok(value),None=>fresh()}
    })
}
fn mutating_helper_response(session: &Mutex<Session>, lifecycle: &Mutex<()>, action: impl FnOnce() -> Result<Value,String>) -> Result<Value,String> {
    helper_response(session,lifecycle,||{
        session.lock().unwrap().initial_setup=None;
        action()
    })
}
async fn helper_dispatch(owner: tauri::State<'_, Arc<Owner>>, action: fn(&std::path::Path) -> Result<Value, String>) -> Result<Value, String> {
    let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;helper_response(&owner.session,&owner.lifecycle,||action(&owner.resources))}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn desktop_setup_state(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;setup_state_response(&owner.session,&owner.lifecycle,||host::desktop_setup_state(&owner.resources))}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn install_git(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;mutating_helper_response(&owner.session,&owner.lifecycle,|| host::install_git(&owner.resources))}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn open_github_link(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::GitHubLinkArgs = native_args(request)?; let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;helper_response(&owner.session,&owner.lifecycle,|| host::open_github_link(args.link))}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn open_device_login(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let _: host::EmptyArgs = native_args(request)?; helper_dispatch(owner, |_| host::open_device_login()).await
}
/// Shows the agent log or the backups folder in Finder; the host resolves the path from the state root.
/// It works after a failed startup too, since the state root is known without a connection and the log
/// matters most then.
#[tauri::command]
async fn reveal_place(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::RevealArgs = native_args(request)?; let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Settled, so a connection's state root is recorded; whether startup succeeded doesn't matter here.
        let _ = owner.startup.wait();
        let generation = { let current=owner.session.lock().unwrap(); if current.closed {return Err("App connection closed".into());} current.generation };
        Ok(json!({"generation":generation,"data":host::reveal_place(|| owner.state_root(), args.place)?}))
    }).await.map_err(|e|e.to_string())?
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
struct CheckUpdateArgs { automatic: bool }
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
struct UpdatePreferencesArgs { automatic_checks: bool }
async fn update_coordinator(owner: Arc<Owner>) -> Result<Arc<updates::Coordinator>, String> {
    tauri::async_runtime::spawn_blocking(move || owner.startup.coordinator()).await.map_err(|_|"Update readiness stopped".to_string())?
}
#[tauri::command]
async fn update_state(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let _:host::EmptyArgs=native_args(request)?;Ok(update_coordinator(owner.inner().clone()).await?.snapshot())
}
#[tauri::command]
async fn check_update(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let args:CheckUpdateArgs=native_args(request)?;let coordinator=update_coordinator(owner.inner().clone()).await?;Ok(coordinator.check(args.automatic,updates::now_ms()).await)
}
#[tauri::command]
async fn download_update(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let _:host::EmptyArgs=native_args(request)?;let coordinator=update_coordinator(owner.inner().clone()).await?;Ok(coordinator.download().await)
}
#[tauri::command]
async fn cancel_update(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let _:host::EmptyArgs=native_args(request)?;Ok(update_coordinator(owner.inner().clone()).await?.cancel())
}
#[tauri::command]
async fn update_preferences(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let args:UpdatePreferencesArgs=native_args(request)?;let coordinator=update_coordinator(owner.inner().clone()).await?;
    tauri::async_runtime::spawn_blocking(move || coordinator.preferences(args.automatic_checks)).await.map_err(|_|"Update preferences stopped".to_string())
}
#[tauri::command]
async fn install_update(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<updates::Snapshot,String> {
    let _:host::EmptyArgs=native_args(request)?;let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        owner.startup.wait()?;
        let coordinator=owner.startup.coordinator()?;
        let _lifecycle=owner.lifecycle.lock().unwrap();
        if owner.session.lock().unwrap().closed {return Err("App connection closed".into());}
        let result=coordinator.install();
        if result.phase=="restarting" {close(&owner.session);owner.startup.close();owner.startup.join();owner.app.restart();}
        Ok(result)
    }).await.map_err(|_|"Native update installation stopped".to_string())?
}
/// Bootstrap and ensure share one lifecycle reservation without recursively taking its mutex.
#[cfg(all(test, unix))]
fn setup_connection(session: &Mutex<Session>, lifecycle: &Mutex<()>, bootstrap: impl FnOnce() -> Result<(), String>, connect: impl FnOnce(u64) -> Result<Agent, String>) -> Result<Value, String> {
    restart(session, lifecycle, |g| { bootstrap()?; connect(g) })
}
#[tauri::command]
async fn setup_desktop(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let args: host::SetupArgs = native_args(request)?;
    let choices = host::SetupChoices::decode(args.config_targets)?;
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {owner.startup.wait()?;let coordinator=owner.startup.coordinator()?;restart_with_completion(&owner.session, &owner.lifecycle,
        |g| {host::bootstrap_desktop(&owner.resources, choices)?; owner.connect(g, Setup::Ensure)}, ||coordinator.recovered())}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
async fn take_review_request(owner: tauri::State<'_, Arc<Owner>>) -> Result<Value,String> {
    let owner=owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        owner.startup.wait()?;
        let current=owner.session.lock().unwrap();
        if current.closed {return Err("App connection closed".into());}
        Ok(json!({"generation":current.generation,"data":{"requested":owner.review.take()}}))
    }).await.map_err(|_|"Review readiness stopped".to_string())?
}
fn show_review(app: tauri::AppHandle) {
    let dispatch = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = dispatch.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        if let Some(owner) = dispatch.try_state::<Arc<Owner>>() {
            let generation = owner.session.lock().unwrap().generation;
            let _ = dispatch.emit("machine-agent", json!({"event":"review-requested","generation":generation}));
        }
    });
}
/// Hidden delivery resolves paths through the read-only helper before a direct app connection.
fn notify_mode(id: &str) -> Result<bool, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let executable = std::env::current_exe().map_err(|e|e.to_string())?;
    #[cfg(unix)]
    let resources = executable.parent().and_then(|p|p.parent()).ok_or("Missing app resources")?.join("Resources/agent-runtime");
    #[cfg(windows)]
    let resources = executable.parent().ok_or("Missing app resources")?.join("agent-runtime");
    let state_root = host::setup_agent(&resources, Setup::Paths)?;
    notifications::notify_only(&state_root, id, deadline, notifications::post)
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
/// The smoke agent's state root under the throwaway HOME.
#[cfg(unix)]
fn smoke_state_root(home: &std::path::Path) -> Result<PathBuf, String> { Ok(home.join(".config/nortuscc")) }
#[cfg(windows)]
fn smoke_state_root(home: &std::path::Path) -> Result<PathBuf, String> { smoke_appdata_root(home, std::env::var_os("APPDATA").as_deref()) }
/// Windows keeps state under APPDATA, which must itself lie inside the smoke HOME.
#[cfg(windows)]
fn smoke_appdata_root(home: &std::path::Path, appdata: Option<&std::ffi::OsStr>) -> Result<PathBuf, String> {
    let appdata = appdata.ok_or("Smoke APPDATA is not set; refusing to apply")?;
    let appdata = std::fs::canonicalize(appdata).map_err(|e| format!("Smoke APPDATA {}: {e}", std::path::Path::new(appdata).display()))?;
    if appdata == home || !appdata.starts_with(home) || !appdata.is_dir() {
        return Err(format!("Smoke APPDATA {} is not inside {}; refusing to apply to it", appdata.display(), home.display()));
    }
    Ok(appdata.join("nortuscc"))
}
/// Connects directly to the foreground test agent supplied by the JS smoke, without registration.
fn smoke(home: PathBuf) -> Result<(), String> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let agent = Agent::connect(&smoke_state_root(&home)?, Arc::new(move |event| captured.lock().unwrap().push(event)))?;
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--mcp") {
        let result = (|| {
            if args.len() != 1 { return Err("Usage: --mcp".to_string()); }
            let executable = std::env::current_exe().map_err(|_| "Installed MCP executable is unavailable")?;
            mcp::run_mcp(&mcp::installed_resources(&executable)?)
        })();
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    }
    // Release preparation verifies files without creating a window, service or OS integration.
    if args.first().map(String::as_str)==Some("--verify-update-release") {
        let result=(|| {
            if args.len()!=5 {return Err("Expected artifact, signature, version and public key".to_string());}
            let bytes=std::fs::read(&args[1]).map_err(|_|"Cannot read release artifact")?;
            let signature=std::fs::read_to_string(&args[2]).map_err(|_|"Cannot read release signature")?;
            update_payload::verify_signature(&bytes,&signature,&args[4],&args[3])?;
            update_payload::validate_bundle(&bytes,&args[3])
        })();
        if let Err(error)=result {eprintln!("{error}");std::process::exit(1);}return;
    }
    match notifications::notify_argument(&args) {
        Ok(Some(id)) => {
            match notify_mode(&id) {
                Ok(true) => {},
                Ok(false) => std::process::exit(1),
                Err(error) => { eprintln!("Notification failed: {error}"); std::process::exit(1); }
            }
            return;
        }
        Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        Ok(None) => {},
    }
    if std::env::args().nth(1).as_deref() == Some("--smoke") {
        let result = smoke_home(std::env::args().nth(2).as_deref()).and_then(smoke);
        if let Err(error) = result { eprintln!("Smoke failed: {error}"); std::process::exit(1); }
        return;
    }
    let review = Arc::new(notifications::ReviewRoute::default());
    let handle = Arc::new(Mutex::new(None::<tauri::AppHandle>));
    let click_review = review.clone();
    let click_handle = handle.clone();
    let _delegate = notifications::install(Arc::new(move || {
        click_review.request();
        if let Some(app) = click_handle.lock().unwrap().clone() { show_review(app); }
    }));
    let startup=Arc::new(startup::Startup::default());
    let setup_startup=startup.clone();
    let builder = tauri::Builder::default();
    // Declared before the page loads, so the renderer names this PC and File Explorer (src/device.ts); macOS keeps its default wording.
    #[cfg(windows)]
    let builder = builder.plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("nortuscc-platform")
        .js_init_script("Object.defineProperty(window, '__NORTUSCC_PLATFORM__', { value: 'windows' });").build());
    let exit_code=builder
        .setup(move |app| {
            if let Ok(directory) = app.path().app_log_dir() { startup_diagnostics::initialize(&directory); }
            let trace = startup_diagnostics::trace(Operation::AppStartup);
            trace.measure(Phase::AppSetup, || {
                *handle.lock().unwrap() = Some(app.handle().clone());
                let resources = trace.measure(Phase::Paths, || app.path().resource_dir())?.join("agent-runtime");
                #[cfg(all(debug_assertions, unix))]
                let resources = if resources.is_dir() { resources } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64") };
                #[cfg(all(debug_assertions, windows))]
                let resources = if resources.is_dir() { resources } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/win32-x64") };
                let source=trace.measure(Phase::UpdaterSource, || updater_transport::source(app.handle()));
                let owner = Arc::new(Owner {
                    session: Mutex::new(Session { agent: None, generation: 1, error: Some("Checking local setup state".into()), closed: false, initial_setup: None }),
                    lifecycle: Mutex::new(()), resources, app: app.handle().clone(), review: review.clone(),startup:setup_startup.clone(),
                    state_root: Mutex::new(None),
                    #[cfg(windows)]
                    child: agent_child::AgentChild::new(app.path().app_log_dir().ok().map(|directory| directory.join("agent-child.log"))),
                });
                app.manage(owner.clone());
                trace.measure(Phase::Services, || { notifications::request_permission(); Ok::<_, std::convert::Infallible>(()) })?;
                setup_startup.start(move || run_startup(owner, source))?;
                Ok(())
            })
        })
        .invoke_handler(tauri::generate_handler![operation, get_operation_run, list_operation_runs, agent_generation, agent_status, inspect_machine, restart_agent, take_review_request, desktop_setup_state, setup_desktop, install_git, mcp_connections, hosted_state, sign_in, sign_out, sync_now, trust_setup, machine_settings, set_policy, resume_agent, open_device_login, open_github_link, reveal_place,update_state,check_update,download_update,cancel_update,install_update,update_preferences])
        .build(tauri::generate_context!()).expect("Unable to build the app")
        .run_return(|app, event| {
            if matches!(event,tauri::RunEvent::Ready) {startup_diagnostics::trace(Operation::AppStartup).record(Phase::RuntimeReady,startup_diagnostics::Status::Completed,None);}
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(owner) = app.try_state::<Arc<Owner>>() {
                    close(&owner.session);
                    owner.startup.close();
                    #[cfg(windows)]
                    owner.child.close();
                }
            }
        });
    startup.close();
    startup.join();
    std::process::exit(exit_code);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use host::fixtures::{idle_agent, Fixture};
    #[cfg(unix)]
    use std::{sync::mpsc, thread, time::{Duration, Instant}};
    #[cfg(unix)]
    fn session(generation: u64) -> Mutex<Session> { Mutex::new(Session { agent: None, generation, error: None, closed: false, initial_setup: None }) }
    #[test]
    fn update_commands_accept_only_fixed_intent_arguments() {
        assert!(host::decode_args::<CheckUpdateArgs>(json!({"automatic":false})).is_ok());
        assert!(host::decode_args::<UpdatePreferencesArgs>(json!({"automaticChecks":true})).is_ok());
        for field in ["url","path","pubkey","bytes","command","installerPid"] {
            let mut args=json!({"automatic":false});args[field]=json!("arbitrary renderer value");
            assert!(host::decode_args::<CheckUpdateArgs>(args).is_err());
            assert!(host::decode_args::<host::EmptyArgs>(json!({field:"arbitrary renderer value"})).is_err());
        }
    }
    #[cfg(unix)]
    fn startup_context(outcome: &str) -> host::StartupContext {
        host::decode_startup(json!({"stateRoot":"/tmp/login-derived-state","setup":if outcome=="setup_failed" {Value::Null} else {json!({"needsSetup":outcome=="needs_setup","repo":if outcome=="needs_setup" {Value::Null} else {json!("/tmp/repo")},"gitAvailable":true,"canInstallGit":false,"defaultRepoUrl":"https://github.com/Nortus222/claude-config.git"})},"maintenance":if outcome=="setup_failed" {Value::Null} else if matches!(outcome,"recovered"|"recovery_failed") {json!({"pending":true,"phase":"awaiting-health","fromVersion":"0.1.1","toVersion":"0.1.2","backupPath":"/tmp/backup","diagnostic":null})} else {json!({"pending":false,"phase":null,"fromVersion":null,"toVersion":null,"backupPath":null,"diagnostic":null})},"outcome":outcome})).unwrap()
    }
    #[cfg(unix)]
    #[test]
    fn initial_startup_never_ensures_a_missing_or_corrupt_setup() {
        let session = session(1); let lifecycle = Mutex::new(());
        assert!(initial_connection(&session,&lifecycle,&startup_context("needs_setup"), |_,_| panic!("New machine must await consent"),|| panic!("Not recovered")).unwrap().is_none());
        assert!(initial_connection(&session,&lifecycle,&startup_context("setup_failed"), |_,_| panic!("Corrupt setup must not be replaced"),|| panic!("Not recovered")).is_err());
        assert_eq!(session.lock().unwrap().generation,1);
        let (agent,fixture) = idle_agent();
        assert_eq!(initial_connection(&session,&lifecycle,&startup_context("ready"), |_,root| {assert_eq!(root, std::path::Path::new("/tmp/login-derived-state"));Ok(agent)},|| panic!("Not recovered")).unwrap().unwrap()["generation"],2);
        close(&session); fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn failed_startup_keeps_update_preferences_root_without_another_lifecycle_helper() {
        let context=Ok(startup_context("ensure_failed"));
        assert_eq!(startup_preferences(&context),Some(PathBuf::from("/tmp/login-derived-state/agent/update-settings.json")));
        let session=session(1);let lifecycle=Mutex::new(());
        assert!(initial_connection(&session,&lifecycle,context.as_ref().unwrap(),|_,_| panic!("No second ensure"),|| panic!("No recovery")).is_err());
        assert_eq!(session.lock().unwrap().generation,1);
        assert_eq!(startup_preferences(&Err("Invalid startup root".into())),None);
    }
    #[cfg(unix)]
    #[test]
    fn startup_connects_directly_after_one_helper_and_validates_installed_identity() {
        use std::{fs, os::unix::fs::PermissionsExt};
        for matching in [true,false] {
            let fixture=Fixture::new(|mut wire|{wire.handshake();wire.discard_until_close();});
            fs::write(fixture.root.join("agent.mjs"),"fake helper").unwrap();
            fs::write(fixture.root.join("runtime.json"),json!({"agentVersion":if matching {"fake-v1"} else {"wrong-identity"}}).to_string()).unwrap();
            let mut context=json!({"stateRoot":fixture.root,"setup":{"needsSetup":false,"repo":"/tmp/repo","gitAvailable":true,"canInstallGit":false,"defaultRepoUrl":"https://github.com/Nortus222/claude-config.git"},"maintenance":{"pending":false,"phase":null,"fromVersion":null,"toVersion":null,"backupPath":null,"diagnostic":null},"outcome":"ready"});
            context["stateRoot"]=json!(fixture.root);
            fs::write(fixture.root.join("bun"),format!("#!/bin/sh\n[ \"$2\" = --startup ] && [ \"$3\" = --app ] && [ \"$#\" = 4 ] || exit 8\nread input\nprintf '%s\\n' '{}'\nprintf '%s\\n' startup >> calls\n",context)).unwrap();
            fs::set_permissions(fixture.root.join("bun"),fs::Permissions::from_mode(0o700)).unwrap();
            let context=host::desktop_startup(&fixture.root,"0.1.2").unwrap();let session=session(1);let lifecycle=Mutex::new(());
            let result=initial_connection(&session,&lifecycle,&context,|_,root|connect_runtime(&fixture.root,root,Arc::new(|_|{}),Operation::AppStartup),||panic!("No recovery"));
            assert_eq!(fs::read_to_string(fixture.root.join("calls")).unwrap(),"startup\n");
            if matching {assert!(result.is_ok());assert!(generation(&session).is_ok());}
            else {assert!(result.unwrap_err().contains("installed app runtime"));assert!(generation(&session).is_err());}
            close(&session);fixture.finish();
        }
    }
    #[cfg(unix)]
    #[test]
    fn initial_setup_snapshot_is_consumed_once_and_restart_invalidates_it() {
        let session=session(1);let lifecycle=Mutex::new(());let context=startup_context("needs_setup");
        initial_connection(&session,&lifecycle,&context,|_,_| panic!("No ensure"),||{}).unwrap();
        let first=setup_state_response(&session,&lifecycle,|| panic!("Startup snapshot must avoid probing again")).unwrap();
        assert_eq!(first["data"]["needsSetup"],true);
        assert_eq!(setup_state_response(&session,&lifecycle,|| Ok(json!({"fresh":true}))).unwrap()["data"],json!({"fresh":true}));
        initial_connection(&session,&lifecycle,&context,|_,_| panic!("No ensure"),||{}).unwrap();
        assert!(mutating_helper_response(&session,&lifecycle,|| Err("Git installer failed".into())).is_err());
        assert_eq!(setup_state_response(&session,&lifecycle,|| Ok(json!({"freshAfterGit":true}))).unwrap()["data"],json!({"freshAfterGit":true}));
        initial_connection(&session,&lifecycle,&context,|_,_| panic!("No ensure"),||{}).unwrap();
        assert!(restart(&session,&lifecycle,|_| Err("offline".into())).is_err());
        assert_eq!(setup_state_response(&session,&lifecycle,|| Ok(json!({"fresh":true}))).unwrap()["data"],json!({"fresh":true}));
    }
    #[cfg(unix)]
    struct StartupSource;
    #[cfg(unix)]
    impl updates::UpdateSource for StartupSource {
        fn check(&self) -> updates::FutureResult<'_,Option<Arc<dyn updates::Artifact>>> {Box::pin(async {Ok(None)})}
    }
    #[cfg(unix)]
    struct StartupService;
    #[cfg(unix)]
    impl updates::Maintenance for StartupService {
        fn prepare(&self,_: &str,_: &str,_: Arc<std::sync::atomic::AtomicBool>) -> Result<Box<dyn updates::Handoff>,String> {panic!("No service maintenance in startup check test")}
    }
    #[cfg(unix)]
    fn recovery_coordinator(root: &std::path::Path) -> Arc<updates::Coordinator> {
        let coordinator=Arc::new(updates::Coordinator::new("0.1.4",Some(Arc::new(StartupSource)),Arc::new(StartupService),Some(root.join("agent/update-settings.json"))));
        coordinator.recovery("An interrupted update is pending.");coordinator
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn first_recovered_update_snapshot_waits_for_native_health_then_permits_automatic_checks() {
        let fixture=Fixture::new(|mut wire| {wire.handshake();wire.discard_until_close();});
        std::fs::write(fixture.root.join("runtime.json"),r#"{"agentVersion":"fake-v1"}"#).unwrap();
        let mut context=startup_context("recovered");context.state_root=fixture.root.clone();
        let coordinator=recovery_coordinator(&fixture.root);
        let session=Arc::new(session(1));let lifecycle=Arc::new(Mutex::new(()));let startup=Arc::new(startup::Startup::default());
        let s=session.clone();let l=lifecycle.clone();let ready=startup.clone();let resources=fixture.root.clone();
        let (entered,entry)=mpsc::channel();let(release,held)=mpsc::channel();let(done,finished)=mpsc::channel();
        startup.start(move || {
            let result=startup_connection(&s,&l,&ready,Ok(context),coordinator,|_,root| {
                entered.send(()).unwrap();held.recv().unwrap();connect_runtime(&resources,root,Arc::new(|_|{}),Operation::AppStartup)
            });done.send(result).unwrap();
        }).unwrap();
        entry.recv_timeout(Duration::from_secs(1)).unwrap();
        let waiter=startup.clone();let(observed,first)=mpsc::channel();
        let read=thread::spawn(move || {observed.send(waiter.coordinator()).unwrap();});
        let before_health=first.recv_timeout(Duration::from_millis(50));
        release.send(()).unwrap();
        let was_deferred=before_health.is_err();
        let coordinator=before_health.unwrap_or_else(|_|first.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        read.join().unwrap();assert!(finished.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());startup.join();
        let first_phase=coordinator.snapshot().phase;
        let automatic=coordinator.check(true,100).await.phase;
        let explicit=coordinator.check(false,101).await.phase;
        close(&session);fixture.finish();
        assert!(was_deferred,"The first renderer snapshot must not observe transient recovery while native health is held");
        assert_eq!(first_phase,"idle");assert_eq!(automatic,"current");assert_eq!(explicit,"current");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn ordinary_startup_checks_remain_independent_of_held_agent_health() {
        let (agent,fixture)=idle_agent();let coordinator=Arc::new(updates::Coordinator::new("0.1.4",Some(Arc::new(StartupSource)),Arc::new(StartupService),Some(fixture.root.join("agent/update-settings.json"))));
        let startup=Arc::new(startup::Startup::default());let session=Arc::new(session(1));let lifecycle=Arc::new(Mutex::new(()));
        let ready=startup.clone();let s=session.clone();let l=lifecycle.clone();
        let(entered,entry)=mpsc::channel();let(release,held)=mpsc::channel();
        startup.start(move || {
            startup_connection(&s,&l,&ready,Ok(startup_context("ready")),coordinator,|_,_|{entered.send(()).unwrap();held.recv().unwrap();Ok(agent)}).unwrap();
        }).unwrap();
        entry.recv_timeout(Duration::from_secs(1)).unwrap();
        let coordinator=startup.coordinator().unwrap();
        let check=coordinator.check(false,100).await.phase;
        release.send(()).unwrap();startup.wait().unwrap();startup.join();close(&session);fixture.finish();
        assert_eq!(check,"current");assert_eq!(coordinator.snapshot().phase,"current");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn failed_native_recovery_identity_publishes_retained_recovery_and_allows_manual_check() {
        let fixture=Fixture::new(|mut wire| {wire.handshake();wire.discard_until_close();});
        std::fs::write(fixture.root.join("runtime.json"),r#"{"agentVersion":"wrong-runtime"}"#).unwrap();
        let mut context=startup_context("recovered");context.state_root=fixture.root.clone();
        let coordinator=recovery_coordinator(&fixture.root);let startup=Arc::new(startup::Startup::default());
        let session=Arc::new(session(1));let lifecycle=Arc::new(Mutex::new(()));let ready=startup.clone();let s=session.clone();let l=lifecycle.clone();let resources=fixture.root.clone();
        let(done,finished)=mpsc::channel();startup.start(move || {
            done.send(startup_connection(&s,&l,&ready,Ok(context),coordinator,|_,root|connect_runtime(&resources,root,Arc::new(|_|{}),Operation::AppStartup))).unwrap();
        }).unwrap();
        let coordinator=startup.coordinator().unwrap();assert!(finished.recv_timeout(Duration::from_secs(1)).unwrap().is_err());startup.join();
        let first_phase=coordinator.snapshot().phase;assert!(generation(&session).is_err());
        let manual=coordinator.check(false,100).await.phase;
        close(&session);fixture.finish();assert_eq!(first_phase,"recovery");assert_eq!(manual,"current");
    }
    #[cfg(unix)]
    #[test]
    fn close_during_recovered_health_never_publishes_a_late_coordinator_or_clears_recovery() {
        let (agent,fixture)=idle_agent();let coordinator=recovery_coordinator(&fixture.root);let original=coordinator.clone();
        let startup=Arc::new(startup::Startup::default());let session=Arc::new(session(1));let lifecycle=Arc::new(Mutex::new(()));let ready=startup.clone();let s=session.clone();let l=lifecycle.clone();
        let(entered,entry)=mpsc::channel();let(release,held)=mpsc::channel();let(done,finished)=mpsc::channel();
        startup.start(move || {
            done.send(startup_connection(&s,&l,&ready,Ok(startup_context("recovered")),coordinator,|_,_|{entered.send(()).unwrap();held.recv().unwrap();Ok(agent)})).unwrap();
        }).unwrap();
        entry.recv_timeout(Duration::from_secs(1)).unwrap();close(&session);startup.close();release.send(()).unwrap();startup.join();
        assert!(finished.recv_timeout(Duration::from_secs(1)).unwrap().is_err());assert!(startup.coordinator().is_err());
        assert_eq!(original.snapshot().phase,"recovery");assert!(session.lock().unwrap().initial_setup.is_none());fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn recovery_is_cleared_only_after_successful_current_connection_publication() {
        let session=Arc::new(session(1));let lifecycle=Arc::new(Mutex::new(()));let recovered=Arc::new(std::sync::atomic::AtomicBool::new(false));
        let context=startup_context("recovered");
        assert!(initial_connection(&session,&lifecycle,&context,|_,_| Err("Wrong native runtime identity".into()),|| recovered.store(true,std::sync::atomic::Ordering::SeqCst)).is_err());
        assert!(!recovered.load(std::sync::atomic::Ordering::SeqCst));
        let (agent,fixture)=idle_agent();let (entered,received)=mpsc::channel();let(release,held)=mpsc::channel();let s=session.clone();let l=lifecycle.clone();let r=recovered.clone();
        let job=thread::spawn(move || initial_connection(&s,&l,&context,|_,_|{entered.send(()).unwrap();held.recv().unwrap();Ok(agent)},||r.store(true,std::sync::atomic::Ordering::SeqCst)));
        received.recv_timeout(Duration::from_secs(1)).unwrap();close(&session);release.send(()).unwrap();
        assert!(job.join().unwrap().is_err());assert!(!recovered.load(std::sync::atomic::Ordering::SeqCst));fixture.finish();
        assert!(setup_state_response(&session,&lifecycle,||panic!("Closed session must refuse before helper")).is_err());
        let live=self::session(1);let (agent,fixture)=idle_agent();
        initial_connection(&live,&lifecycle,&startup_context("recovered"),|_,_|Ok(agent),||recovered.store(true,std::sync::atomic::Ordering::SeqCst)).unwrap();
        assert!(recovered.load(std::sync::atomic::Ordering::SeqCst));close(&live);fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn bootstrap_then_ensure_uses_one_reservation_and_preserves_failure_for_retry() {
        let session = session(1); let lifecycle = Mutex::new(());
        let steps = Mutex::new(Vec::new());
        assert!(setup_connection(&session, &lifecycle, || { steps.lock().unwrap().push("bootstrap"); Err("Registration retry preserves clone".into()) }, |_| panic!("Failed bootstrap must not connect")).is_err());
        assert_eq!(session.lock().unwrap().generation,2);
        let (agent, fixture) = idle_agent();
        let result = setup_connection(&session, &lifecycle, || { steps.lock().unwrap().push("bootstrap retry"); assert!(lifecycle.try_lock().is_err()); Ok(()) }, |g| {
            assert_eq!(g,3); steps.lock().unwrap().push("ensure"); assert!(lifecycle.try_lock().is_err()); Ok(agent)
        }).unwrap();
        assert_eq!(result["generation"],3); assert_eq!(result["data"]["hello"]["protocol"],3);
        assert_eq!(*steps.lock().unwrap(),vec!["bootstrap","bootstrap retry","ensure"]);
        close(&session); fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn account_reply_in_flight_retains_its_original_generation_after_restart() {
        let (entered, received) = mpsc::channel(); let (release, held) = mpsc::channel();
        let fixture = Fixture::new(move |mut wire| {
            wire.handshake(); let request = wire.next().unwrap(); assert_eq!(request["command"],"signIn");
            entered.send(()).unwrap(); held.recv().unwrap(); wire.reply(&request,json!({"userCode":"ABCD"}));
            assert!(wire.next().is_none());
        });
        let session = Arc::new(session(7)); session.lock().unwrap().agent = Some(Arc::new(fixture.connect(Arc::new(|_|{}))));
        let pending = session.clone(); let job = thread::spawn(move || request(&pending,Request::SignIn {name:None,report_status:Some(false)}));
        received.recv_timeout(Duration::from_secs(1)).unwrap();
        // Reserve a newer generation while the old reply is held. The renderer can fence it.
        session.lock().unwrap().generation = 8;
        release.send(()).unwrap(); assert_eq!(job.join().unwrap().unwrap()["generation"],7);
        close(&session); fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn startup_notification_waits_for_publication_and_acks_off_reader() {
        let (sent, received) = mpsc::channel();
        let fixture = Fixture::new(|mut wire| {
            let hello = wire.next().unwrap(); wire.reply(&hello, host::fixtures::hello_result());
            let subscribe = wire.next().unwrap();
            wire.send(json!({"version":3,"event":"notification","notification":{"id":"a".repeat(64),"title":"Review","body":"Items"},"receipt":"r"}));
            wire.reply(&subscribe, json!({"subscribed":true}));
            let ack = wire.next().unwrap(); assert_eq!(ack["command"],"notificationAck"); assert_eq!(ack["delivered"],true);
            wire.reply(&ack,json!({"accepted":true})); assert!(wire.next().is_none());
        });
        let session = Arc::new(session(1)); let lifecycle = Arc::new(Mutex::new(()));
        let held = lifecycle.lock().unwrap();
        let agent = fixture.connect(Arc::new(move |event| {
            if event["event"] == "notification" { sent.send(notifications::Delivery::decode(event).unwrap()).unwrap(); }
        }));
        let delivery = received.recv_timeout(Duration::from_secs(1)).unwrap();
        let s = session.clone(); let l = lifecycle.clone();
        let worker = thread::spawn(move || deliver_current(&s,&l,1,delivery,&|_,active| active()));
        session.lock().unwrap().agent = Some(Arc::new(agent));
        drop(held);
        assert!(worker.join().unwrap().unwrap()); close(&session); fixture.finish();
    }
    #[cfg(unix)]
    #[test]
    fn superseded_notification_never_posts_and_restart_during_post_never_acks() {
        for stale_before_post in [true,false] {
            let (agent, fixture) = idle_agent(); let session = session(2); let lifecycle = Mutex::new(());
            session.lock().unwrap().agent = Some(Arc::new(agent));
            let delivery = notifications::Delivery::decode(json!({"version":3,"event":"notification","notification":{"id":"a".repeat(64),"title":"Review","body":"Items"},"receipt":"r"})).unwrap();
            let mine = if stale_before_post {1} else {2};
            let posted = std::sync::atomic::AtomicBool::new(false);
            assert!(!deliver_current(&session,&lifecycle,mine,delivery,&|_,active| {
                assert!(active()); posted.store(true,std::sync::atomic::Ordering::SeqCst);
                close(&session); assert!(!active()); true
            }).unwrap());
            assert_eq!(posted.load(std::sync::atomic::Ordering::SeqCst),!stale_before_post);
            close(&session); fixture.finish();
        }
    }
    #[cfg(unix)]
    #[test]
    fn expired_queued_notification_never_starts_posting() {
        let (agent, fixture) = idle_agent(); let session = session(1); let lifecycle = Mutex::new(());
        session.lock().unwrap().agent = Some(Arc::new(agent));
        let mut delivery = notifications::Delivery::decode(json!({"version":3,"event":"notification","notification":{"id":"a".repeat(64),"title":"Review","body":"Items"},"receipt":"r"})).unwrap();
        delivery.received_at = Instant::now() - Duration::from_secs(4);
        assert!(!deliver_current(&session,&lifecycle,1,delivery,&|_,_|panic!("Expired delivery must not post")).unwrap());
        close(&session); fixture.finish();
    }
    #[test]
    fn smoke_home_requires_a_directory_under_the_canonical_system_temporary_root() {
        assert!(smoke_home(None).is_err());
        assert!(smoke_home(std::env::temp_dir().to_str()).is_err());
        assert!(smoke_home(Some(env!("CARGO_MANIFEST_DIR"))).is_err());
        assert!(smoke_home(Some("/this/path/does/not/exist")).is_err());
        let root = std::env::temp_dir().join(format!("ncc-smoke-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(smoke_home(root.to_str()).unwrap(), std::fs::canonicalize(&root).unwrap());
        #[cfg(unix)]
        {
            let link = root.join("escape"); std::os::unix::fs::symlink(env!("CARGO_MANIFEST_DIR"), &link).unwrap();
            assert!(smoke_home(link.to_str()).is_err());
        }
        let file = root.join("file"); std::fs::write(&file, "x").unwrap(); assert!(smoke_home(file.to_str()).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_smoke_state_lives_in_appdata_inside_the_smoke_home() {
        let root = std::env::temp_dir().join(format!("ncc-smoke-appdata-{}", std::process::id()));
        let appdata = root.join("AppData/Roaming"); std::fs::create_dir_all(&appdata).unwrap();
        let home = smoke_home(root.to_str()).unwrap();
        assert_eq!(smoke_appdata_root(&home, Some(appdata.as_os_str())).unwrap(), std::fs::canonicalize(&appdata).unwrap().join("nortuscc"));
        assert!(smoke_appdata_root(&home, None).is_err());
        assert!(smoke_appdata_root(&home, Some(home.as_os_str())).unwrap_err().contains("refusing"));
        assert!(smoke_appdata_root(&home, Some(std::ffi::OsStr::new(env!("CARGO_MANIFEST_DIR")))).unwrap_err().contains("refusing"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
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
    #[cfg(unix)]
    fn wait_generation(session: &Mutex<Session>, wanted: u64) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.lock().unwrap().generation < wanted { assert!(Instant::now() < deadline); thread::sleep(Duration::from_millis(1)); }
    }
    #[cfg(unix)]
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
    #[cfg(unix)]
    #[test]
    fn restart_disconnects_the_old_socket_without_shutdown() {
        let session = session(2); let lifecycle = Mutex::new(());
        let (old, old_fixture) = idle_agent(); let (new, new_fixture) = idle_agent();
        session.lock().unwrap().agent = Some(Arc::new(old));
        assert_eq!(restart(&session, &lifecycle, |_| Ok(new)).unwrap()["generation"], 3);
        old_fixture.finish(); close(&session); new_fixture.finish();
    }
    #[cfg(unix)]
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

#[tauri::command]
async fn mcp_connections(owner: tauri::State<'_, Arc<Owner>>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let action: host::ConnectionAction = native_args(request)?;
    let owner = owner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        owner.startup.wait()?;
        helper_response(&owner.session, &owner.lifecycle, || host::mcp_connections(&owner.resources, action))
    }).await.map_err(|_| "Connection helper failed".to_string())?
}
