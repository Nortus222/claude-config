//! Windows has no login service: the app owns its agent as a child in a kill-on-close Job Object.
use crate::host::{Agent, Request, CREATE_NO_WINDOW};
use std::{
    fs::OpenOptions,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    ptr::null,
    sync::Mutex,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long stopping may wait for a graceful shutdown before it kills the agent.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(2);

/// A Job Object that kills every process in it when its last handle closes.
struct Job(HANDLE);
// The handle is only closed, never shared mutably.
unsafe impl Send for Job {}
impl Job {
    fn new() -> Result<Self, String> {
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() { return Err(format!("Agent job: {}", std::io::Error::last_os_error())); }
        let job = Self(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        if unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size) } == 0 {
            return Err(format!("Agent job limits: {}", std::io::Error::last_os_error()));
        }
        Ok(job)
    }
    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) } == 0 {
            return Err(format!("Agent job assignment: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
}
impl Drop for Job { fn drop(&mut self) { unsafe { CloseHandle(self.0) }; } }

/// A running agent child; dropping it kills the agent, then its job closes over any descendants.
struct Owned { child: Child, _job: Job, state_root: PathBuf }
impl Drop for Owned {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
impl Owned {
    /// Stops the agent so its own cleanup removes `agent.pipe` and `agent.token` and releases `agent.lock`:
    /// a bounded `shutdown` request, then the kill in `drop` if it has not exited. A child that already
    /// exited (e.g. on a lock held by a CLI agent) asks nothing, so that agent is left alone.
    fn retire(mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let state_root = self.state_root.clone();
            shut_down_within(Instant::now() + RETIRE_TIMEOUT, |deadline| ask_shutdown(&state_root, deadline), || !matches!(self.child.try_wait(), Ok(None)));
        }
    }
}
/// Hello with the agent's token, then `shutdown`, both before `deadline`; true once the agent accepted.
fn ask_shutdown(state_root: &Path, deadline: Instant) -> bool {
    Agent::connect_notification(state_root, deadline).and_then(|agent| agent.request_before(Request::Shutdown, deadline)).is_ok()
}
/// Asks for a shutdown, then polls `exited` until `deadline`. False when the request failed or the process
/// outlived the deadline: the caller must kill it.
fn shut_down_within(deadline: Instant, ask: impl FnOnce(Instant) -> bool, mut exited: impl FnMut() -> bool) -> bool {
    if !ask(deadline) { return false; }
    loop {
        if exited() { return true; }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(20).min(deadline.saturating_duration_since(Instant::now())));
    }
}

struct Slot<T> { owned: Option<T>, closed: bool }
/// Keeps an already reachable agent; otherwise, or on restart, replaces the owned child with a new one.
fn ensure_with<T>(slot: &mut Slot<T>, restart: bool, reachable: impl FnOnce() -> bool, spawn: impl FnOnce() -> Result<T, String>) -> Result<(), String> {
    if slot.closed { return Err("App connection closed".into()); }
    if !restart && reachable() { return Ok(()); }
    slot.owned.take();
    slot.owned = Some(spawn()?);
    Ok(())
}
/// Takes the owned child, if any, for termination; the slot stays usable.
fn stop_with<T>(slot: &mut Slot<T>) -> Option<T> { slot.owned.take() }
/// The app's agent child, if any; closing it on exit kills the agent.
pub struct AgentChild { slot: Mutex<Slot<Owned>>, log: Option<PathBuf> }
impl AgentChild {
    /// `log` receives the child's stdout and stderr; without one they are discarded.
    pub fn new(log: Option<PathBuf>) -> Self { Self { slot: Mutex::new(Slot { owned: None, closed: false }), log } }
    /// Keeps an agent already reachable at `state_root` (e.g. a foreground CLI agent); otherwise, or on
    /// restart, spawns the app's own. A restart cannot replace a CLI agent: the new child exits on the lock
    /// that agent holds, which keeps serving. Readiness is the caller's `connect_ready`.
    pub fn ensure(&self, resources: &Path, state_root: &Path, restart: bool) -> Result<(), String> {
        let reachable = || Agent::connect_notification(state_root, Instant::now() + PROBE_TIMEOUT).map(|agent| agent.disconnect()).is_ok();
        ensure_with(&mut self.slot.lock().unwrap(), restart, reachable, || spawn(resources, state_root, self.log.as_deref()))
    }
    /// Stops the owned agent (`Owned::retire`) so a helper sees its lock released; a later `ensure` spawns anew.
    pub fn stop(&self) {
        let owned = stop_with(&mut self.slot.lock().unwrap());
        if let Some(owned) = owned { owned.retire(); }
    }
    /// Stops the owned agent and refuses later spawns. Shutdown and kill both cancel an apply, which is
    /// pause-safe (ADR 0011).
    pub fn close(&self) {
        let owned = { let mut slot = self.slot.lock().unwrap(); slot.closed = true; slot.owned.take() };
        if let Some(owned) = owned { owned.retire(); }
    }
}

fn spawn(resources: &Path, state_root: &Path, log: Option<&Path>) -> Result<Owned, String> {
    let bun = resources.join("bun.exe");
    let script = resources.join("agent.mjs");
    if !resources.is_absolute() || !bun.is_file() || !script.is_file() { return Err(format!("Missing bundled agent at {}", resources.display())); }
    let (stdout, stderr) = output(log);
    let mut command = Command::new(bun);
    command.arg(script).current_dir(resources)
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env_remove("BUN_OPTIONS")
        .stdin(Stdio::null()).stdout(stdout).stderr(stderr)
        .creation_flags(CREATE_NO_WINDOW);
    let job = Job::new()?;
    // The child runs briefly outside the job until assigned; std cannot spawn it suspended.
    let mut child = command.spawn().map_err(|e| format!("Cannot start the agent: {e}"))?;
    if let Err(error) = job.assign(&child) { let _ = child.kill(); let _ = child.wait(); return Err(error); }
    Ok(Owned { child, _job: job, state_root: state_root.to_path_buf() })
}
fn output(log: Option<&Path>) -> (Stdio, Stdio) {
    let file = log.and_then(|path| {
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        let file = OpenOptions::new().create(true).append(true).open(path).ok()?;
        Some((file.try_clone().ok()?, file))
    });
    match file { Some((out, err)) => (out.into(), err.into()), None => (Stdio::null(), Stdio::null()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    struct Fake(&'static str, Rc<RefCell<Vec<String>>>);
    impl Drop for Fake { fn drop(&mut self) { self.1.borrow_mut().push(format!("terminate {}", self.0)); } }
    fn slot(owned: Option<&'static str>, log: &Rc<RefCell<Vec<String>>>) -> Slot<Fake> {
        Slot { owned: owned.map(|name| Fake(name, log.clone())), closed: false }
    }

    #[test]
    fn a_reachable_agent_is_kept_without_spawning() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut slot = slot(Some("old"), &log);
        ensure_with(&mut slot, false, || true, || panic!("No spawn while reachable")).unwrap();
        assert_eq!(slot.owned.as_ref().unwrap().0, "old");
        assert!(log.borrow().is_empty());
    }
    #[test]
    fn an_unreachable_agent_replaces_any_owned_child() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut slot = slot(None, &log);
        ensure_with(&mut slot, false, || false, || Ok(Fake("first", log.clone()))).unwrap();
        let spawned = log.clone();
        ensure_with(&mut slot, false, || false, || { spawned.borrow_mut().push("spawn second".into()); Ok(Fake("second", spawned.clone())) }).unwrap();
        assert_eq!(slot.owned.as_ref().unwrap().0, "second");
        assert_eq!(*log.borrow(), ["terminate first", "spawn second"]);
    }
    #[test]
    fn restart_terminates_then_spawns_without_probing() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut slot = slot(Some("old"), &log);
        let spawned = log.clone();
        ensure_with(&mut slot, true, || panic!("Restart never probes"), || { spawned.borrow_mut().push("spawn new".into()); Ok(Fake("new", spawned.clone())) }).unwrap();
        assert_eq!(slot.owned.as_ref().unwrap().0, "new");
        assert_eq!(*log.borrow(), ["terminate old", "spawn new"]);
    }
    #[test]
    fn a_failed_spawn_leaves_nothing_owned_and_a_closed_slot_never_spawns() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut slot = slot(Some("old"), &log);
        assert!(ensure_with(&mut slot, true, || true, || Err("boom".into())).is_err());
        assert!(slot.owned.is_none());
        slot.closed = true;
        assert!(ensure_with(&mut slot, false, || false, || panic!("Closed")).is_err());
    }
    #[test]
    fn stopping_terminates_the_owned_child_and_leaves_the_slot_open() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let mut slot = slot(Some("old"), &log);
        stop_with(&mut slot);
        assert!(slot.owned.is_none() && !slot.closed);
        assert_eq!(*log.borrow(), ["terminate old"]);
        stop_with(&mut slot);
        assert_eq!(log.borrow().len(), 1, "Stopping an empty slot is a no-op");
        let spawned = log.clone();
        ensure_with(&mut slot, true, || panic!("Restart never probes"), || { spawned.borrow_mut().push("spawn new".into()); Ok(Fake("new", spawned.clone())) }).unwrap();
        assert_eq!(slot.owned.as_ref().unwrap().0, "new");
        assert_eq!(*log.borrow(), ["terminate old", "spawn new"]);
    }
    #[test]
    fn retiring_asks_for_shutdown_then_waits_for_exit() {
        let log = RefCell::new(Vec::new());
        let deadline = Instant::now() + Duration::from_secs(5);
        let exited = shut_down_within(deadline, |given| { assert_eq!(given, deadline); log.borrow_mut().push("shutdown"); true },
            || { log.borrow_mut().push("poll"); log.borrow().len() == 3 });
        assert!(exited, "An agent that exits in time needs no kill");
        assert_eq!(*log.borrow(), ["shutdown", "poll", "poll"]);
    }
    #[test]
    fn retiring_falls_back_to_a_kill_when_refused_or_late() {
        let deadline = Instant::now() + Duration::from_secs(5);
        assert!(!shut_down_within(deadline, |_| false, || panic!("A refused shutdown is not waited for")));
        let deadline = Instant::now() + Duration::from_millis(100);
        assert!(!shut_down_within(deadline, |_| true, || false));
        assert!(Instant::now() >= deadline && Instant::now() < deadline + Duration::from_secs(1), "The wait is bounded by the deadline");
    }
    #[test]
    fn the_shutdown_request_says_hello_with_the_token_then_shutdown() {
        let fixture = crate::host::fixtures::Fixture::new(|mut wire| {
            let hello = wire.next().unwrap();
            assert_eq!((hello["command"].as_str(), hello["token"].as_str()), (Some("hello"), Some("token-a")));
            wire.reply(&hello, crate::host::fixtures::hello_result());
            let shutdown = wire.next().unwrap();
            assert_eq!(shutdown["command"], "shutdown");
            wire.reply(&shutdown, serde_json::json!({"shutdown":true}));
        });
        assert!(ask_shutdown(&fixture.root, Instant::now() + RETIRE_TIMEOUT));
        let root = fixture.root.clone();
        fixture.finish();
        assert!(!ask_shutdown(&root, Instant::now() + RETIRE_TIMEOUT), "No agent, no shutdown");
    }
    #[test]
    fn spawning_requires_the_bundled_runtime() {
        let missing = std::env::temp_dir().join(format!("nortuscc-agent-child-{}", std::process::id()));
        assert!(spawn(&missing, &missing, None).err().unwrap().starts_with("Missing bundled agent"));
        assert!(spawn(Path::new("relative"), &missing, None).err().unwrap().starts_with("Missing bundled agent"));
    }
    #[test]
    fn closing_the_job_kills_its_assigned_child() {
        let job = Job::new().unwrap();
        let mut child = Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1 > NUL"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags(CREATE_NO_WINDOW).spawn().unwrap();
        job.assign(&child).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "Job close left the child running");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
