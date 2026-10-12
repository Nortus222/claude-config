use crate::updates::Coordinator;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Condvar, Mutex};
use std::thread::JoinHandle;

const CLOSED: &str = "App connection closed";
#[derive(Default)]
struct State { coordinator: Option<Arc<Coordinator>>, complete: bool, closed: bool, started: bool, failed: bool }
/// Owns the single startup job and its two authority milestones.
#[derive(Default)]
pub struct Startup {
    state: Mutex<State>,
    changed: Condvar,
    cancel: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Startup {
    pub fn start(self: &Arc<Self>, job: impl FnOnce() + Send + 'static) -> Result<(), String> {
        let mut worker=self.worker.lock().unwrap();
        {
            let mut state=self.state.lock().unwrap();
            if state.closed {return Err(CLOSED.into());}
            if state.started {return Err("Startup worker already started".into());}
            state.started=true;
        }
        let owner=self.clone();
        *worker=Some(std::thread::Builder::new().name("desktop-startup".into()).spawn(move || {
            let failed=std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)).is_err();
            owner.finish(failed);
        }).map_err(|_| {self.finish(true); "Cannot schedule desktop startup".to_string()})?);
        Ok(())
    }
    pub fn cancellation(&self) -> Arc<AtomicBool> { self.cancel.clone() }
    pub fn publish(&self, coordinator: Arc<Coordinator>) -> Result<(), String> {
        let mut state=self.state.lock().unwrap();
        if state.closed {return Err(CLOSED.into());}
        if state.coordinator.is_some() {return Err("Startup coordinator already published".into());}
        state.coordinator=Some(coordinator); self.changed.notify_all(); Ok(())
    }
    pub fn coordinator(&self) -> Result<Arc<Coordinator>, String> {
        let mut state=self.state.lock().unwrap();
        loop {
            if state.closed {return Err(CLOSED.into());}
            if let Some(coordinator)=&state.coordinator {return Ok(coordinator.clone());}
            if state.complete {return Err("Startup coordinator unavailable".into());}
            state=self.changed.wait(state).unwrap();
        }
    }
    pub fn wait(&self) -> Result<(), String> {
        let mut state=self.state.lock().unwrap();
        loop {
            if state.closed {return Err(CLOSED.into());}
            if state.complete {return if state.failed {Err("Desktop startup worker failed; restart explicitly".into())} else {Ok(())};}
            state=self.changed.wait(state).unwrap();
        }
    }
    fn finish(&self, failed: bool) {let mut state=self.state.lock().unwrap();state.complete=true;state.failed=failed; self.changed.notify_all();}
    pub fn close(&self) {
        let mut state=self.state.lock().unwrap(); state.closed=true;
        self.cancel.store(true, Ordering::SeqCst); self.changed.notify_all();
    }
    /// Called after the event loop returns, never from its UI exit callback.
    pub fn join(&self) {if let Some(worker)=self.worker.lock().unwrap().take() {let _=worker.join();}}
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, thread, time::Duration};
    #[test]
    fn setup_scheduling_returns_while_startup_job_is_held() {
        let startup=Arc::new(Startup::default());
        let (entered,entry)=mpsc::channel(); let (release,held)=mpsc::channel(); let (returned,result)=mpsc::channel();
        let owner=startup.clone();
        let kickoff=thread::spawn(move || {owner.start(move || {entered.send(()).unwrap();held.recv().unwrap();}).unwrap();returned.send(()).unwrap();});
        entry.recv_timeout(Duration::from_secs(1)).unwrap();
        let scheduled=result.recv_timeout(Duration::from_millis(100)).is_ok();
        release.send(()).unwrap(); kickoff.join().unwrap(); startup.join();
        assert!(scheduled,"Tauri setup must return before helper/health completes");
    }
    struct LocalSource;
    impl crate::updates::UpdateSource for LocalSource {
        fn check(&self) -> crate::updates::FutureResult<'_,Option<Arc<dyn crate::updates::Artifact>>> {Box::pin(async {Ok(None)})}
    }
    struct NoService;
    impl crate::updates::Maintenance for NoService {
        fn prepare(&self,_: &str,_: &str,_: Arc<AtomicBool>) -> Result<Box<dyn crate::updates::Handoff>,String> {panic!("Health gate must prevent installation")}
    }
    #[tokio::test]
    async fn authenticated_checks_use_resolved_preferences_while_machine_commands_wait_for_health() {
        let root=crate::host::fixtures::scratch();let settings=root.join("agent/update-settings.json");
        std::fs::create_dir(root.join("agent")).unwrap();
        std::fs::write(&settings,r#"{"automaticChecks":false,"lastCheckMs":null}"#).unwrap();
        let startup=Arc::new(Startup::default());let owner=startup.clone();
        let (publish,published)=mpsc::channel();let (release,health)=mpsc::channel();
        startup.start(move || {
            let coordinator=Arc::new(Coordinator::new("0.1.4",Some(Arc::new(LocalSource)),Arc::new(NoService),Some(settings)));
            owner.publish(coordinator).unwrap();publish.send(()).unwrap();health.recv().unwrap();
        }).unwrap();
        published.recv_timeout(Duration::from_secs(1)).unwrap();
        let coordinator=startup.coordinator().unwrap();
        assert!(!coordinator.snapshot().automatic_checks,"Login-derived user preference must be read before publication");
        assert_eq!(coordinator.check(false,10).await.phase,"current");
        let (passed,blocked)=mpsc::channel();let waiter=startup.clone();
        let command=thread::spawn(move || {let result=waiter.wait();passed.send(result).unwrap();});
        assert!(blocked.recv_timeout(Duration::from_millis(50)).is_err(),"Machine/read-helper/install commands must remain fenced while health is pending");
        release.send(()).unwrap();assert!(blocked.recv_timeout(Duration::from_secs(1)).unwrap().is_ok());command.join().unwrap();startup.join();
        assert!(startup.start(|| panic!("Only one worker may run")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn close_wakes_both_readiness_waiters_and_refuses_late_publication_before_join() {
        let startup=Arc::new(Startup::default());let owner=startup.clone();
        let (release,held)=mpsc::channel();let (late,published)=mpsc::channel();
        startup.start(move || {
            held.recv().unwrap();
            late.send(owner.publish(Arc::new(Coordinator::new("0.1.4",None,Arc::new(NoService),None)))).unwrap();
        }).unwrap();
        let (done,waited)=mpsc::channel();let complete=startup.clone();let coordinator=startup.clone();
        let a=thread::spawn(move || done.send(complete.wait()).unwrap());
        let b=thread::spawn(move || coordinator.coordinator().map(|_|()).map_err(|e|e));
        startup.close();
        assert_eq!(waited.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),CLOSED);
        assert_eq!(b.join().unwrap().unwrap_err(),CLOSED);a.join().unwrap();
        assert!(startup.cancellation().load(Ordering::SeqCst));
        release.send(()).unwrap();startup.join();
        assert_eq!(published.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err(),CLOSED);
        assert!(startup.wait().is_err());
    }

}
