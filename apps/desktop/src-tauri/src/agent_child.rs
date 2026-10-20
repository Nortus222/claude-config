//! Windows has no login service: the app owns its agent as a child in a kill-on-close Job Object.
use crate::host::{Agent, CREATE_NO_WINDOW};
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
struct Owned { child: Child, _job: Job }
impl Drop for Owned {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
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

/// The app's agent child, if any; closing it on exit kills the agent.
pub struct AgentChild { slot: Mutex<Slot<Owned>>, log: Option<PathBuf> }
impl AgentChild {
    /// `log` receives the child's stdout and stderr; without one they are discarded.
    pub fn new(log: Option<PathBuf>) -> Self { Self { slot: Mutex::new(Slot { owned: None, closed: false }), log } }
    /// Makes an agent reachable at `state_root`: a reachable one (e.g. a foreground CLI agent) is kept
    /// unless restarting. Readiness is the caller's `connect_ready`.
    pub fn ensure(&self, resources: &Path, state_root: &Path, restart: bool) -> Result<(), String> {
        let reachable = || Agent::connect_notification(state_root, Instant::now() + PROBE_TIMEOUT).map(|agent| agent.disconnect()).is_ok();
        ensure_with(&mut self.slot.lock().unwrap(), restart, reachable, || spawn(resources, self.log.as_deref()))
    }
    /// Kills the owned agent and refuses later spawns. The agent's apply is pause-safe (ADR 0011).
    pub fn close(&self) {
        let owned = { let mut slot = self.slot.lock().unwrap(); slot.closed = true; slot.owned.take() };
        drop(owned);
    }
}

fn spawn(resources: &Path, log: Option<&Path>) -> Result<Owned, String> {
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
    Ok(Owned { child, _job: job })
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
    fn spawning_requires_the_bundled_runtime() {
        let missing = std::env::temp_dir().join(format!("nortuscc-agent-child-{}", std::process::id()));
        assert!(spawn(&missing, None).err().unwrap().starts_with("Missing bundled agent"));
        assert!(spawn(Path::new("relative"), None).err().unwrap().starts_with("Missing bundled agent"));
    }
    #[test]
    fn closing_the_job_kills_its_process_tree() {
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
