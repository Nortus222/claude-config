use serde::{Deserialize, Serialize};
use std::{future::Future, path::PathBuf, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::sync::Notify;

pub const ENDPOINT: &str = "https://github.com/Nortus222/claude-config/releases/download/desktop-stable-channel/latest.json";
pub const MAX_DOWNLOAD: u64 = 536_870_912;
pub type FutureResult<'a,T> = Pin<Box<dyn Future<Output=Result<T,String>> + Send + 'a>>;
pub type Progress = Arc<dyn Fn(usize,Option<u64>) + Send + Sync>;
#[derive(Clone)]
pub struct Release { pub version: String, pub notes: Option<String>, pub url: String, pub target: String }
pub trait Artifact: Send + Sync {
    fn release(&self) -> Release;
    fn download(&self, progress: Progress) -> FutureResult<'_,Vec<u8>>;
    fn install(&self, bytes: &[u8]) -> Result<(),String>;
}
pub trait UpdateSource: Send + Sync { fn check(&self) -> FutureResult<'_,Option<Arc<dyn Artifact>>>; }
pub trait Handoff: Send {
    fn begin_install(&mut self) -> Result<(),String>;
    fn commit(&mut self) -> Result<(),String>;
    fn abort(&mut self) -> Result<(),String>;
}
pub trait Maintenance: Send + Sync {
    fn prepare(&self, from: &str, to: &str, cancel: Arc<AtomicBool>) -> Result<Box<dyn Handoff>,String>;
}
#[derive(Clone,Serialize,Debug)]
#[serde(rename_all="camelCase")]
pub struct Snapshot {
    pub installed_version: String, pub enabled: bool, pub automatic_checks: bool, pub phase: String,
    pub available_version: Option<String>, pub notes: Option<String>, pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>, pub diagnostic: Option<String>,
}
#[derive(Default,Serialize,Deserialize)]
#[serde(deny_unknown_fields,rename_all="camelCase")]
struct Preferences { automatic_checks: bool, last_check_ms: Option<u64> }
struct Cancellation { stopped: Arc<AtomicBool>, changed: Notify }
impl Cancellation { fn new() -> Self { Self { stopped:Arc::new(AtomicBool::new(false)), changed:Notify::new() } } }
struct Inner { snapshot: Snapshot, candidate: Option<Arc<dyn Artifact>>, verified: Option<Vec<u8>>, operation: Option<Arc<Cancellation>>, last_check_ms: Option<u64> }
pub struct Coordinator { inner: Mutex<Inner>, source: Option<Arc<dyn UpdateSource>>, service: Arc<dyn Maintenance>, preferences: Option<PathBuf>, check_timeout: Duration, download_timeout: Duration }
impl Coordinator {
    pub fn new(version: &str, source: Option<Arc<dyn UpdateSource>>, service: Arc<dyn Maintenance>, preferences: Option<PathBuf>) -> Self {
        let enabled = source.is_some();
        let read = preferences.as_ref().map(|path|std::fs::read(path));
        let (prefs,invalid) = match read {
            Some(Ok(bytes)) if bytes.len() <= 4096 => match serde_json::from_slice(&bytes) { Ok(value) => (value,false), Err(_) => (Preferences::default(),true) },
            Some(Err(error)) if error.kind()==std::io::ErrorKind::NotFound => (Preferences { automatic_checks:true,last_check_ms:None },false),
            None => (Preferences { automatic_checks:true,last_check_ms:None },false),
            _ => (Preferences::default(),true),
        };
        let diagnostic = if invalid { Some("Update settings are unreadable; automatic checks are disabled".into()) } else if !enabled { Some("Signed updates are unavailable in this build. Production release configuration is not provisioned.".into()) } else { None };
        Self { inner:Mutex::new(Inner { snapshot:Snapshot { installed_version:version.into(),enabled,automatic_checks:prefs.automatic_checks,phase:"idle".into(),available_version:None,notes:None,downloaded_bytes:0,total_bytes:None,diagnostic },candidate:None,verified:None,operation:None,last_check_ms:prefs.last_check_ms }),source,service,preferences,check_timeout:Duration::from_secs(15),download_timeout:Duration::from_secs(300) }
    }
    pub fn snapshot(&self) -> Snapshot { self.inner.lock().unwrap().snapshot.clone() }
    pub fn recovery(&self, detail: &str) { let mut i=self.inner.lock().unwrap(); i.snapshot.phase="recovery".into(); i.snapshot.diagnostic=Some(bounded(detail,512)); }
    pub fn recovered(&self) {
        let mut i=self.inner.lock().unwrap();
        if i.snapshot.phase=="recovery" {
            i.snapshot.phase="idle".into();
            i.snapshot.diagnostic=Some("Interrupted update recovery completed; machine state was preserved.".into());
        }
    }
    fn save(&self, i: &Inner) -> Result<(),String> {
        let Some(path)=&self.preferences else { return Ok(()); };
        let parent=path.parent().ok_or("Invalid update settings path")?;
        std::fs::create_dir_all(parent).map_err(|_|"Cannot save update settings")?;
        let bytes=serde_json::to_vec(&Preferences { automatic_checks:i.snapshot.automatic_checks,last_check_ms:i.last_check_ms }).unwrap();
        // Settings are user intent; preserve their previous contents before replacing them.
        if path.exists() {
            let root=parent.parent().ok_or("Invalid update settings root")?;
            let backups=root.join("backups");
            std::fs::create_dir_all(&backups).map_err(|_|"Cannot back up update settings")?;
            let stamp=now_ms();
            let backup=(0..1000).find_map(|sequence| {
                let path=backups.join(format!("desktop-settings-{stamp}-{}-{sequence}",std::process::id()));
                match std::fs::create_dir(&path) {
                    Ok(())=>Some(Ok(path)),
                    Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists=>None,
                    Err(_)=>Some(Err("Cannot back up update settings")),
                }
            }).ok_or("Cannot allocate update settings backup")??;
            std::fs::copy(path,backup.join("update-settings.json")).map_err(|_|"Cannot back up update settings")?;
        }
        let temp=parent.join(format!(".update-settings-{}.tmp",std::process::id()));
        std::fs::write(&temp,bytes).map_err(|_|"Cannot save update settings")?;
        std::fs::rename(temp,path).map_err(|_|"Cannot save update settings".to_string())
    }
    pub fn preferences(&self, automatic: bool) -> Snapshot {
        let mut i=self.inner.lock().unwrap(); if i.operation.is_some() { return i.snapshot.clone(); }
        let previous=i.snapshot.automatic_checks; i.snapshot.automatic_checks=automatic;
        if self.save(&i).is_err() { i.snapshot.automatic_checks=previous; i.snapshot.diagnostic=Some("Cannot save update settings; previous choice retained".into()); }
        i.snapshot.clone()
    }
    fn reserve(i: &mut Inner, phase: &str) -> Option<Arc<Cancellation>> {
        if !i.snapshot.enabled || i.operation.is_some() { return None; }
        let cancel=Arc::new(Cancellation::new()); i.operation=Some(cancel.clone()); i.snapshot.phase=phase.into(); i.snapshot.diagnostic=None; Some(cancel)
    }
    fn finish(&self, result: Result<&str,String>) -> Snapshot {
        let mut i=self.inner.lock().unwrap(); i.operation=None;
        match result { Ok(phase)=>i.snapshot.phase=phase.into(), Err(detail)=> { i.snapshot.phase="error".into(); i.snapshot.diagnostic=Some(bounded(&detail,512)); } }
        i.snapshot.clone()
    }
    pub fn cancel(&self) -> Snapshot {
        let i=self.inner.lock().unwrap();
        if matches!(i.snapshot.phase.as_str(),"downloading"|"waiting") {
            if let Some(c)=&i.operation { c.stopped.store(true,Ordering::SeqCst); c.changed.notify_one(); }
        }
        i.snapshot.clone()
    }
    pub async fn check(&self, automatic: bool, now: u64) -> Snapshot {
        let _cancel={
            let mut i=self.inner.lock().unwrap();
            if !i.snapshot.enabled || i.operation.is_some() || (automatic && (i.snapshot.phase=="recovery" || !i.snapshot.automatic_checks || i.last_check_ms.is_some_and(|last|now.saturating_sub(last)<86_400_000))) { return i.snapshot.clone(); }
            i.last_check_ms=Some(now);
            if self.save(&i).is_err() { i.snapshot.phase="error".into(); i.snapshot.diagnostic=Some("Cannot save update check time; check deferred".into()); return i.snapshot.clone(); }
            Self::reserve(&mut i,"checking").unwrap()
        };
        let result=async {
            let candidate=tokio::time::timeout(self.check_timeout,self.source.as_ref().unwrap().check()).await.map_err(|_|"Update check timed out")?.map_err(|_|"Update check failed; retry later")?;
            let mut i=self.inner.lock().unwrap(); i.verified=None; i.candidate=None; i.snapshot.available_version=None; i.snapshot.notes=None; i.snapshot.downloaded_bytes=0; i.snapshot.total_bytes=None;
            if let Some(candidate)=candidate {
                let release=candidate.release(); release_policy(&i.snapshot.installed_version,&release.version,&release.url,&release.target)?;
                i.snapshot.available_version=Some(release.version); i.snapshot.notes=release.notes.map(|v|bounded(&v,8192)); i.candidate=Some(candidate);
                Ok("available")
            } else { Ok("current") }
        }.await;
        self.finish(result)
    }
    pub async fn download(self: &Arc<Self>) -> Snapshot {
        let (candidate,cancel)={
            let mut i=self.inner.lock().unwrap();
            if i.operation.is_some() || i.verified.is_some() || i.candidate.is_none() {return i.snapshot.clone();}
            let candidate=i.candidate.clone().unwrap();
            let Some(cancel)=Self::reserve(&mut i,"downloading") else {return i.snapshot.clone();};
            (candidate,cancel)
        };
        {let mut i=self.inner.lock().unwrap();i.snapshot.downloaded_bytes=0;i.snapshot.total_bytes=None;}
        let weak=Arc::downgrade(self); let progress_cancel=cancel.clone();
        let progress=Arc::new(move |chunk:usize,total:Option<u64>| {
            if let Some(c)=weak.upgrade() {
                let mut i=c.inner.lock().unwrap();
                i.snapshot.downloaded_bytes=i.snapshot.downloaded_bytes.saturating_add(chunk as u64);
                i.snapshot.total_bytes=total.filter(|n|*n>=i.snapshot.downloaded_bytes && *n<=MAX_DOWNLOAD);
                if i.snapshot.downloaded_bytes>MAX_DOWNLOAD || total.is_some_and(|n|n>MAX_DOWNLOAD) {progress_cancel.stopped.store(true,Ordering::SeqCst);progress_cancel.changed.notify_one();}
            }
        }) as Progress;
        let result=tokio::select! {
            biased;
            _=cancel.changed.notified()=>Err("Download cancelled; partial bytes discarded".into()),
            result=tokio::time::timeout(self.download_timeout,candidate.download(progress))=>match result {Ok(value)=>value.map_err(|_|"Update download or verification failed; retry later".into()),Err(_)=>Err("Update download timed out; partial bytes discarded".into())},
        };
        let result=match result {
            Ok(bytes) if !cancel.stopped.load(Ordering::SeqCst) && bytes.len() as u64<=MAX_DOWNLOAD => {self.inner.lock().unwrap().verified=Some(bytes);Ok("verified")},
            Ok(_)=>Err("Download cancelled or exceeded the app size limit".into()),
            Err(detail)=>Err(detail),
        };
        self.finish(result)
    }
    pub fn install(&self) -> Snapshot {
        let (candidate,bytes,from,cancel)={
            let mut i=self.inner.lock().unwrap(); if i.operation.is_some() || i.verified.is_none() {return i.snapshot.clone();}
            let Some(cancel)=Self::reserve(&mut i,"waiting") else {return i.snapshot.clone();};
            (i.candidate.clone().unwrap(),i.verified.take().unwrap(),i.snapshot.installed_version.clone(),cancel)
        };
        let result=(|| {
            let release=candidate.release(); release_policy(&from,&release.version,&release.url,&release.target)?;
            let mut handoff=self.service.prepare(&from,&release.version,cancel.stopped.clone()).map_err(|_|"Cannot prepare app maintenance. Check the existing setup and app-owned agent, or restart the app for pending recovery")?;
            let stopped={let mut i=self.inner.lock().unwrap(); let stopped=cancel.stopped.load(Ordering::SeqCst); if !stopped {i.snapshot.phase="installing".into();} stopped};
            if stopped {handoff.abort().map_err(|_|"Maintenance cancellation needs recovery; restart the app")?;return Err("Installation deferred; existing app retained".into());}
            handoff.begin_install().map_err(|_|"Maintenance could not acknowledge installation; restart the app for recovery")?;
            if candidate.install(&bytes).is_err() {
                let _=handoff.abort();
                return Err("App installation failed. Pending recovery and the app backup are retained; restart the app to recover".into());
            }
            handoff.commit().map_err(|_|"App replaced, but maintenance commit failed. Restart the app for recovery")?;
            Ok("restarting")
        })();
        if result.is_err() {self.inner.lock().unwrap().verified=Some(bytes);}
        self.finish(result)
    }
}
pub fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64 }
pub fn bounded(value: &str, limit: usize) -> String {
    let mut used=0;
    value.chars().take_while(|c| {used+=c.len_utf16();used<=limit})
        .map(|c|if c.is_control() && c!='\n' && c!='\t' {' '} else {c}).collect()
}
pub fn release_policy(current: &str, version: &str, url: &str, target: &str) -> Result<(),String> {
    let current=semver::Version::parse(current).map_err(|_|"Invalid installed app version")?;
    let next=semver::Version::parse(version).map_err(|_|"Invalid available app version")?;
    if next<=current || !next.pre.is_empty() || !next.build.is_empty() || next.to_string()!=version || target!="darwin-aarch64" || url!=format!("https://github.com/Nortus222/claude-config/releases/download/desktop-v{version}/Nortuscc.app.tar.gz") { return Err("Update version, architecture or artifact URL is not accepted".into()); } Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake { events:Arc<Mutex<Vec<&'static str>>>, fail:bool }
    impl Artifact for Fake {
        fn release(&self)->Release {Release {version:"0.2.0".into(),notes:Some("<script>plain notes</script>".into()),url:"https://github.com/Nortus222/claude-config/releases/download/desktop-v0.2.0/Nortuscc.app.tar.gz".into(),target:"darwin-aarch64".into()}}
        fn download(&self, progress:Progress)->FutureResult<'_,Vec<u8>> {Box::pin(async move {self.events.lock().unwrap().push("download");progress(3,None); if self.fail {Err("Signature verification failed".into())} else {Ok(vec![1,2,3])}})}
        fn install(&self, bytes:&[u8])->Result<(),String> {assert_eq!(bytes,[1,2,3]);self.events.lock().unwrap().push("install");Ok(())}
    }
    impl UpdateSource for Fake {fn check(&self)->FutureResult<'_,Option<Arc<dyn Artifact>>> {Box::pin(async {self.events.lock().unwrap().push("check");Ok(Some(Arc::new(Fake {events:self.events.clone(),fail:self.fail}) as Arc<dyn Artifact>))})}}
    impl Maintenance for Fake {fn prepare(&self,_:&str,_:&str,_:Arc<AtomicBool>)->Result<Box<dyn Handoff>,String> {self.events.lock().unwrap().push("prepare");Ok(Box::new(Fake {events:self.events.clone(),fail:false}))}}
    impl Handoff for Fake {
        fn begin_install(&mut self)->Result<(),String> {self.events.lock().unwrap().push("begin");Ok(())}
        fn commit(&mut self)->Result<(),String> {self.events.lock().unwrap().push("commit");Ok(())}
        fn abort(&mut self)->Result<(),String> {self.events.lock().unwrap().push("abort");Ok(())}
    }
    fn coordinator(fail:bool)->(Arc<Coordinator>,Arc<Mutex<Vec<&'static str>>>) {let events=Arc::new(Mutex::new(Vec::new()));let fake=Arc::new(Fake {events:events.clone(),fail});(Arc::new(Coordinator::new("0.1.0",Some(fake.clone()),fake,None)),events)}
    #[tokio::test]
    async fn verified_bytes_require_explicit_install_and_fenced_handoff() {
        let (c,e)=coordinator(false);assert_eq!(c.install().phase,"idle");
        assert_eq!(c.check(false,1).await.phase,"available");assert_eq!(c.download().await.phase,"verified");
        assert_eq!(*e.lock().unwrap(),vec!["check","download"]);assert_eq!(c.snapshot().total_bytes,None);
        assert_eq!(c.install().phase,"restarting");assert_eq!(*e.lock().unwrap(),vec!["check","download","prepare","begin","install","commit"]);
    }
    #[tokio::test]
    async fn verification_failure_never_stops_service_or_installs() {
        let (c,e)=coordinator(true);c.check(false,1).await;assert_eq!(c.download().await.phase,"error");c.install();
        assert_eq!(*e.lock().unwrap(),vec!["check","download"]);
    }
    #[tokio::test]
    async fn automatic_checks_are_rate_limited_and_optional() {
        let (c,e)=coordinator(false);c.check(true,100).await;c.check(true,101).await;
        assert_eq!(*e.lock().unwrap(),vec!["check"]);c.preferences(false);c.check(true,100_000_000).await;assert_eq!(e.lock().unwrap().len(),1);
    }
    struct Waiting { events: Arc<Mutex<Vec<&'static str>>>, entered: Arc<Notify>, checking: bool }
    impl Artifact for Waiting {
        fn release(&self) -> Release { Fake {events:self.events.clone(),fail:false}.release() }
        fn download(&self, progress: Progress) -> FutureResult<'_,Vec<u8>> {
            Box::pin(async move { self.events.lock().unwrap().push("download"); progress(3,None); self.entered.notify_one(); std::future::pending().await })
        }
        fn install(&self,_:&[u8])->Result<(),String> { panic!("Partial download must never install") }
    }
    impl UpdateSource for Waiting {
        fn check(&self)->FutureResult<'_,Option<Arc<dyn Artifact>>> {
            Box::pin(async move {self.events.lock().unwrap().push("check"); if self.checking {std::future::pending().await} else {Ok(Some(Arc::new(Waiting {events:self.events.clone(),entered:self.entered.clone(),checking:false}) as Arc<dyn Artifact>))} })
        }
    }
    #[tokio::test]
    async fn recovery_completion_keeps_available_and_verified_update_intent() {
        let (c,events)=coordinator(false);
        c.recovery("Pending health"); c.recovered();
        assert_eq!(c.snapshot().phase,"idle");
        assert_eq!(c.check(false,1).await.phase,"available");
        c.recovered(); assert_eq!(c.snapshot().phase,"available");
        assert_eq!(c.download().await.phase,"verified");
        c.recovered(); assert_eq!(c.snapshot().phase,"verified");
        assert_eq!(c.install().phase,"restarting");
        assert_eq!(*events.lock().unwrap(),vec!["check","download","prepare","begin","install","commit"]);
    }
    #[tokio::test]
    async fn recovery_completion_preserves_active_download_progress_and_cancellation() {
        let events=Arc::new(Mutex::new(Vec::new())); let entered=Arc::new(Notify::new());
        let source=Arc::new(Waiting {events:events.clone(),entered:entered.clone(),checking:false});
        let service=Arc::new(Fake {events:events.clone(),fail:false});
        let c=Arc::new(Coordinator::new("0.1.0",Some(source),service,None));
        c.recovery("Pending health"); c.check(false,1).await;
        let downloading=c.clone();let job=tokio::spawn(async move {downloading.download().await});
        entered.notified().await;
        c.recovered();
        assert_eq!(c.snapshot().phase,"downloading","Health completion must not replace an active operation");
        assert_eq!(c.snapshot().downloaded_bytes,3);
        c.cancel();
        assert_eq!(tokio::time::timeout(Duration::from_secs(1),job).await.unwrap().unwrap().phase,"error");
        assert_eq!(*events.lock().unwrap(),vec!["check","download"]);
    }
    #[tokio::test]
    async fn cancel_discards_partial_bytes_and_fences_concurrent_commands() {
        let events=Arc::new(Mutex::new(Vec::new())); let entered=Arc::new(Notify::new());
        let source=Arc::new(Waiting {events:events.clone(),entered:entered.clone(),checking:false});
        let service=Arc::new(Fake {events:events.clone(),fail:false});
        let c=Arc::new(Coordinator::new("0.1.0",Some(source),service,None)); c.check(false,1).await;
        let pending=c.clone(); let job=tokio::spawn(async move {pending.download().await}); entered.notified().await;
        assert_eq!(c.snapshot().downloaded_bytes,3); assert_eq!(c.snapshot().total_bytes,None);
        assert_eq!(c.install().phase,"downloading"); assert_eq!(c.check(false,2).await.phase,"downloading");
        c.cancel(); assert_eq!(job.await.unwrap().phase,"error"); c.install();
        assert_eq!(*events.lock().unwrap(),vec!["check","download"]);
    }
    #[tokio::test]
    async fn checks_and_downloads_timeout_without_service_handoff() {
        for checking in [true,false] {
            let events=Arc::new(Mutex::new(Vec::new()));
            let source=Arc::new(Waiting {events:events.clone(),entered:Arc::new(Notify::new()),checking});
            let service=Arc::new(Fake {events:events.clone(),fail:false});
            let mut c=Coordinator::new("0.1.0",Some(source),service,None);
            c.check_timeout=Duration::from_millis(5); c.download_timeout=Duration::from_millis(5);
            let c=Arc::new(c); let checked=c.check(false,1).await;
            let result=if checking {checked} else {c.download().await};
            assert_eq!(result.phase,"error"); assert!(result.diagnostic.unwrap().contains("timed out")); c.install();
            assert!(!events.lock().unwrap().iter().any(|e|*e=="prepare"||*e=="install"));
        }
    }
    struct Failure {events:Arc<Mutex<Vec<&'static str>>>,stage:&'static str}
    impl Failure {fn step(&self,step:&'static str)->Result<(),String> {self.events.lock().unwrap().push(step);if self.stage==step {Err("secret token and private /owner/path".into())} else {Ok(())}}}
    impl Artifact for Failure {
        fn release(&self)->Release {Fake {events:self.events.clone(),fail:false}.release()}
        fn download(&self,_:Progress)->FutureResult<'_,Vec<u8>> {Box::pin(async {Ok(vec![1,2,3])})}
        fn install(&self,bytes:&[u8])->Result<(),String> {assert_eq!(bytes,[1,2,3]);self.step("install")}
    }
    impl UpdateSource for Failure {fn check(&self)->FutureResult<'_,Option<Arc<dyn Artifact>>> {Box::pin(async {Ok(Some(Arc::new(Failure {events:self.events.clone(),stage:self.stage}) as Arc<dyn Artifact>))})}}
    impl Maintenance for Failure {fn prepare(&self,_:&str,_:&str,_:Arc<AtomicBool>)->Result<Box<dyn Handoff>,String> {self.step("prepare")?;Ok(Box::new(Failure {events:self.events.clone(),stage:self.stage}))}}
    impl Handoff for Failure {
        fn begin_install(&mut self)->Result<(),String> {self.step("begin")}
        fn commit(&mut self)->Result<(),String> {self.step("commit")}
        fn abort(&mut self)->Result<(),String> {self.step("abort")}
    }
    struct WaitingMaintenance { events:Arc<Mutex<Vec<&'static str>>>, entered:std::sync::mpsc::Sender<()>, release:Mutex<std::sync::mpsc::Receiver<()>> }
    impl Maintenance for WaitingMaintenance {
        fn prepare(&self,_:&str,_:&str,_:Arc<AtomicBool>)->Result<Box<dyn Handoff>,String> {
            self.events.lock().unwrap().push("prepare");self.entered.send(()).unwrap();self.release.lock().unwrap().recv().unwrap();
            Ok(Box::new(Failure {events:self.events.clone(),stage:""}))
        }
    }
    #[tokio::test]
    async fn cancellation_while_waiting_aborts_before_installation_acknowledgement() {
        let events=Arc::new(Mutex::new(Vec::new()));let fake=Arc::new(Failure {events:events.clone(),stage:""});
        let (entered,ready)=std::sync::mpsc::channel();let (release,held)=std::sync::mpsc::channel();
        let service=Arc::new(WaitingMaintenance {events:events.clone(),entered,release:Mutex::new(held)});
        let c=Arc::new(Coordinator::new("0.1.0",Some(fake),service,None));c.check(false,1).await;c.download().await;
        let pending=c.clone();let job=std::thread::spawn(move || pending.install());ready.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(c.snapshot().phase,"waiting");c.cancel();release.send(()).unwrap();
        assert_eq!(job.join().unwrap().phase,"error");assert_eq!(*events.lock().unwrap(),vec!["prepare","abort"]);
    }
    #[tokio::test]
    async fn each_handoff_failure_is_redacted_and_never_claims_restart() {
        for (stage,expected) in [("prepare",vec!["prepare"]),("begin",vec!["prepare","begin"]),("install",vec!["prepare","begin","install","abort"]),("commit",vec!["prepare","begin","install","commit"])] {
            let events=Arc::new(Mutex::new(Vec::new()));let fake=Arc::new(Failure {events:events.clone(),stage});
            let c=Arc::new(Coordinator::new("0.1.0",Some(fake.clone()),fake,None));c.check(false,1).await;c.download().await;
            let result=c.install();assert_eq!(result.phase,"error");let diagnostic=result.diagnostic.unwrap();
            assert!(!diagnostic.contains("secret"));assert!(!diagnostic.contains("/owner/path"));assert_eq!(*events.lock().unwrap(),expected);
        }
    }
    #[tokio::test]
    async fn preferences_and_check_budget_survive_restart_with_distinct_backups() {
        let root=crate::host::fixtures::scratch();let path=root.join("agent/update-settings.json");
        let events=Arc::new(Mutex::new(Vec::new()));let fake=Arc::new(Fake {events:events.clone(),fail:false});
        let c=Coordinator::new("0.1.0",Some(fake.clone()),fake.clone(),Some(path.clone()));
        c.check(true,100).await;
        for choice in [false,true,false,true,false,true] { assert_eq!(c.preferences(choice).automatic_checks,choice); }
        let count=std::fs::read_dir(root.join("backups")).unwrap().count();assert_eq!(count,6,"Every overwritten settings value must have a distinct backup");
        let next=Coordinator::new("0.1.0",Some(fake.clone()),fake,Some(path));next.check(true,101).await;
        assert!(next.snapshot().automatic_checks);assert_eq!(*events.lock().unwrap(),vec!["check"]);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_text_limits_match_renderer_utf16_limits() {
        assert_eq!(bounded(&"😀".repeat(5000),8192).encode_utf16().count(),8192);
        assert_eq!(bounded("hello\u{0}world",20),"hello world");
    }
    #[test]
    fn rejects_downgrades_prereleases_and_wrong_release_urls() {
        for (version,url) in [("0.0.9","https://github.com/Nortus222/claude-config/releases/download/desktop-v0.0.9/Nortuscc.app.tar.gz"),("0.2.0-beta.1","https://github.com/Nortus222/claude-config/releases/download/desktop-v0.2.0-beta.1/Nortuscc.app.tar.gz"),("0.2.0","http://github.com/Nortus222/claude-config/releases/download/desktop-v0.2.0/Nortuscc.app.tar.gz"),("0.2.0","https://example.com/Nortuscc.app.tar.gz"),("malformed","https://github.com/Nortus222/claude-config/releases/download/desktop-vmalformed/Nortuscc.app.tar.gz")] {assert!(release_policy("0.1.0",version,url,"darwin-aarch64").is_err());}
        assert!(release_policy("0.1.0","0.2.0","https://github.com/Nortus222/claude-config/releases/download/desktop-v0.2.0/Nortuscc.app.tar.gz","darwin-x86_64").is_err());
    }
}
