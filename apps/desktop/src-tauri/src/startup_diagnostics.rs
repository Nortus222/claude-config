use serde::{Deserialize, Serialize};
use std::{
    fs::File, io::{self, Read, Seek, SeekFrom, Write},
    os::{fd::{AsRawFd, FromRawFd}, unix::fs::MetadataExt},
    path::{Path, Component as PathComponent},
    sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, OnceLock},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const PREFIX: &str = "[nortuscc-startup] ";
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MAX_LOG: usize = 1_048_576;
const MAX_LINE: usize = 2048;
macro_rules! closed_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }
    };
}
closed_enum!(Component { Native, Helper, Agent });
closed_enum!(Operation { AppStartup, Foreground, Ensure, Restart, Paths, SetupState, Bootstrap, InstallGit, PrepareUpdate, RecoverUpdate, MaintenanceState, Invalid });
closed_enum!(Phase { Entry, RuntimeMetadata, LoginProbe, ShellSpawn, ShellReady, EnvironmentReady, ProbeCleanup, Paths, Lifecycle, Lock, LogRotation, Services, Scheduler, Session, Ipc, Running, Shutdown, IpcClosed, Stopped, AppSetup, UpdaterSource, PreferencesPaths, MaintenanceState, SetupState, Helper, ReadyWait, RuntimeIdentity });
closed_enum!(Status { Started, Completed, Failed, TimedOut, Fallback, Cancelled });

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Record {
    v: u8,
    component: Component,
    pid: u64,
    started_at: u64,
    seq: u64,
    elapsed_ms: u64,
    phase: Phase,
    status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "duration")]
    duration_ms: Option<u64>,
    operation: Operation,
}
fn duration<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    u64::deserialize(deserializer).map(Some)
}
/// Arbitrary stderr is discarded; only this closed numeric/enum schema is reconstructed.
pub fn parse_record(line: &[u8]) -> Option<Record> {
    if line.len() > MAX_LINE { return None; }
    let record: Record = serde_json::from_slice(line.strip_prefix(PREFIX.as_bytes())?).ok()?;
    if record.v != 1 || record.pid == 0 || record.seq == 0
        || [record.pid, record.started_at, record.seq, record.elapsed_ms, record.duration_ms.unwrap_or(0)].iter().any(|n| *n > MAX_SAFE) { return None; }
    Some(record)
}

#[derive(Clone)]
pub struct Diagnostics { sink: Arc<dyn Fn(Record) + Send + Sync>, started: Instant, started_at: u64, sequence: Arc<AtomicU64> }
impl Diagnostics {
    pub fn new(sink: impl Fn(Record) + Send + Sync + 'static) -> Self {
        Self { sink: Arc::new(sink), started: Instant::now(), started_at: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(MAX_SAFE as u128) as u64, sequence: Arc::new(AtomicU64::new(1)) }
    }
    pub fn trace(&self, operation: Operation) -> Trace { Trace { diagnostics: Some(self.clone()), operation } }
    pub fn forward(&self, line: &[u8]) { if let Some(record) = parse_record(line) { self.send(record); } }
    fn send(&self, record: Record) { let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.sink)(record))); }
}
static DIAGNOSTICS: OnceLock<Diagnostics> = OnceLock::new();
/// Called only by normal GUI setup. A bounded queue keeps filesystem work off startup/helper threads.
pub fn initialize(directory: &Path) {
    let directory = directory.to_path_buf();
    let (send, receive) = mpsc::sync_channel(256);
    if DIAGNOSTICS.set(Diagnostics::new(move |record| { let _ = send.try_send(record); })).is_err() { return; }
    let _ = std::thread::Builder::new().name("startup-log".into()).spawn(move || {
        let Ok(mut log) = PrivateLog::open(&directory) else { return; };
        while let Ok(record) = receive.recv() { if log.write(&record).is_err() { return; } }
    });
}
pub fn current() -> Option<Diagnostics> { DIAGNOSTICS.get().cloned() }
pub fn trace(operation: Operation) -> Trace { Trace { diagnostics: current(), operation } }
pub struct Trace { diagnostics: Option<Diagnostics>, operation: Operation }
impl Trace {
    pub fn new(diagnostics: Option<Diagnostics>, operation: Operation) -> Self { Self { diagnostics, operation } }
    pub fn record(&self, phase: Phase, status: Status, duration: Option<std::time::Duration>) {
        if let Some(log) = &self.diagnostics {
            let seq = log.sequence.fetch_add(1, Ordering::Relaxed);
            if seq == 0 || seq > MAX_SAFE { return; }
            log.send(Record { v: 1, component: Component::Native, pid: std::process::id() as u64, started_at: log.started_at, seq,
                elapsed_ms: log.started.elapsed().as_millis().min(MAX_SAFE as u128) as u64, phase, status,
                duration_ms: duration.map(|d| d.as_millis().min(MAX_SAFE as u128) as u64), operation: self.operation });
        }
    }
    pub fn measure<T, E>(&self, phase: Phase, run: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        self.record(phase, Status::Started, None); let start = Instant::now(); let result = run();
        self.record(phase, if result.is_ok() { Status::Completed } else { Status::Failed }, Some(start.elapsed())); result
    }
}

struct PrivateLog { directory: File, file: File }
fn unsafe_storage() -> io::Error { io::Error::other("Unsafe diagnostic storage") }
fn c_name(name: &str) -> io::Result<std::ffi::CString> { std::ffi::CString::new(name).map_err(|_| unsafe_storage()) }
fn open_at(directory: &File, name: &str, flags: i32, mode: u32) -> io::Result<File> {
    let name = c_name(name)?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW, mode as libc::c_uint) };
    if fd < 0 { return Err(io::Error::last_os_error()); } Ok(unsafe { File::from_raw_fd(fd) })
}
fn private_file(file: &File) -> io::Result<()> {
    let m = file.metadata()?;
    if !m.is_file() || m.uid() != unsafe { libc::geteuid() } || m.nlink() != 1 || m.mode() & 0o077 != 0 || m.len() > MAX_LOG as u64 { return Err(unsafe_storage()); } Ok(())
}
impl PrivateLog {
    fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() { return Err(unsafe_storage()); }
        let mut directory = File::open("/")?;
        for component in path.components() {
            let PathComponent::Normal(name) = component else { if component == PathComponent::RootDir { continue; } return Err(unsafe_storage()); };
            let name = name.to_str().ok_or_else(unsafe_storage)?;
            directory = match open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                Ok(dir) => dir,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    let cname = c_name(name)?;
                    if unsafe { libc::mkdirat(directory.as_raw_fd(), cname.as_ptr(), 0o700) } < 0 { return Err(io::Error::last_os_error()); }
                    open_at(&directory, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?
                },
                Err(error) => return Err(error),
            };
        }
        let m = directory.metadata()?;
        if m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o077 != 0 { return Err(unsafe_storage()); }
        let file = open_at(&directory, "startup.log", libc::O_RDWR | libc::O_CREAT | libc::O_APPEND | libc::O_NONBLOCK, 0o600)?;
        private_file(&file)?;
        // The active inode stays open through rotation, so its nonblocking lock fences other app processes.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if file.metadata()?.len() > MAX_LOG as u64 { return Err(unsafe_storage()); }
        Ok(Self { directory, file })
    }
    fn archive(&self, name: &str) -> io::Result<Option<File>> {
        match open_at(&self.directory, name, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
            Ok(file) => { private_file(&file)?; Ok(Some(file)) },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        let from = c_name(from)?; let to = c_name(to)?;
        if unsafe { libc::renameat(self.directory.as_raw_fd(), from.as_ptr(), self.directory.as_raw_fd(), to.as_ptr()) } < 0 { return Err(io::Error::last_os_error()); } Ok(())
    }
    fn remove(&self, name: &str) -> io::Result<()> {
        let name = c_name(name)?;
        if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } < 0 { return Err(io::Error::last_os_error()); } Ok(())
    }
    fn rotate(&mut self) -> io::Result<()> {
        let archives: Vec<_> = (1..=3).map(|n| self.archive(&format!("startup.log.{n}"))).collect::<io::Result<_>>()?;
        let backup_name = ".startup.log.backup";
        let mut backup = open_at(&self.directory, backup_name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
        let result = (|| {
            let mut source = self.file.try_clone()?; source.seek(SeekFrom::Start(0))?;
            io::copy(&mut source.take(MAX_LOG as u64), &mut backup)?; backup.sync_all()?;
            if archives[2].is_some() { self.remove("startup.log.3")?; }
            if archives[1].is_some() { self.rename("startup.log.2", "startup.log.3")?; }
            if archives[0].is_some() { self.rename("startup.log.1", "startup.log.2")?; }
            self.rename(backup_name, "startup.log.1")?;
            self.directory.sync_all()?;
            self.file.set_len(0)
        })();
        if result.is_err() { let _ = self.remove(backup_name); } result
    }
    fn write(&mut self, record: &Record) -> io::Result<()> {
        let active = self.archive("startup.log")?.ok_or_else(unsafe_storage)?;
        if active.metadata()?.ino() != self.file.metadata()?.ino() || active.metadata()?.dev() != self.file.metadata()?.dev() { return Err(unsafe_storage()); }
        let line = format!("{PREFIX}{}\n", serde_json::to_string(record)?);
        if self.file.metadata()?.len() + line.len() as u64 > MAX_LOG as u64 { self.rotate()?; }
        self.file.write_all(line.as_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::fixtures::scratch;
    use std::{fs, os::unix::fs::{PermissionsExt, symlink}, sync::{Arc, Mutex}, time::Duration};

    fn record() -> Record {
        parse_record(br#"[nortuscc-startup] {"v":1,"component":"helper","pid":7,"startedAt":11,"seq":1,"elapsedMs":2,"phase":"login_probe","status":"timed_out","durationMs":2,"operation":"ensure"}"#).unwrap()
    }
    #[test]
    fn strict_forwarding_reconstructs_only_closed_safe_records() {
        let safe = record();
        assert_eq!(safe.component, Component::Helper);
        assert_eq!(safe.status, Status::TimedOut);
        let valid = format!("{PREFIX}{}", serde_json::to_string(&safe).unwrap());
        assert!(parse_record(valid.as_bytes()).is_some());
        for text in [
            "token SECRET", "[nortuscc-startup] {",
            &valid.replace("\"ensure\"", "\"https://secret.invalid\""),
            &valid.replace("\"v\":1", "\"v\":2"),
            &valid.replace("\"pid\":7", "\"pid\":9007199254740992"),
            &valid.replace("\"pid\":7", "\"pid\":-1"),
            &valid.replace("\"pid\":7", "\"pid\":0"),
            &valid.replace("\"seq\":1", "\"seq\":0"),
            &valid.replace("\"startedAt\":11", "\"startedAt\":9007199254740992"),
            &valid.replace("\"durationMs\":2", "\"durationMs\":9007199254740992"),
            &valid.replace("\"status\":\"timed_out\"", "\"status\":\"SECRET\""),
            &valid.replace("\"component\":\"helper\"", "\"component\":\"SECRET\""),
            &valid.replace("{\"v\":1", "{\"v\":1,\"v\":1"),
            &valid.replace("\"durationMs\":2", "\"durationMs\":null"),
            &valid.replace("\"elapsedMs\":2", "\"elapsedMs\":2.5"),
            &valid.replace("\"phase\":\"login_probe\"", "\"phase\":\"token SECRET\""),
            &valid.replace("{\"v\":1", "{\"secret\":\"SECRET\",\"v\":1"),
        ] { assert!(parse_record(text.as_bytes()).is_none(), "accepted {text}"); }
    }
    #[test]
    fn native_trace_records_monotonic_duration_without_errors_or_paths() {
        let events = Arc::new(Mutex::new(Vec::new())); let captured = events.clone();
        let diagnostics = Diagnostics::new(move |record| captured.lock().unwrap().push(record));
        let trace = diagnostics.trace(Operation::AppStartup);
        let result: Result<(), &str> = trace.measure(Phase::AppSetup, || { std::thread::sleep(Duration::from_millis(2)); Err("SECRET /private/path") });
        assert!(result.is_err());
        let records = events.lock().unwrap(); assert_eq!(records.len(), 2);
        assert_eq!(records[0].status, Status::Started); assert_eq!(records[1].status, Status::Failed);
        assert!(records[1].duration_ms.unwrap() >= 2); assert_eq!(records[0].started_at, records[1].started_at);
        assert_eq!(records[1].seq, records[0].seq + 1);
        assert!(!serde_json::to_string(&*records).unwrap().contains("SECRET"));
    }
    #[test]
    fn private_retention_backs_up_before_truncating_and_limits_archives() {
        let root = scratch(); let directory = root.join("logs");
        let mut storage = PrivateLog::open(&directory).unwrap();
        for _ in 0..5 { storage.write(&record()).unwrap(); storage.file.set_len(MAX_LOG as u64).unwrap(); }
        storage.write(&record()).unwrap();
        assert!(directory.join("startup.log.3").is_file()); assert!(!directory.join("startup.log.4").exists());
        assert_eq!(fs::metadata(directory.join("startup.log.1")).unwrap().len(), MAX_LOG as u64);
        assert!(fs::metadata(directory.join("startup.log")).unwrap().len() < MAX_LOG as u64);
        assert_eq!(fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(storage.file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        drop(storage); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unsafe_storage_preserves_active_file_and_foreign_targets() {
        let root = scratch(); let target = root.join("target"); fs::write(&target, "SECRET").unwrap();
        let linked = root.join("linked"); symlink(&root, &linked).unwrap(); assert!(PrivateLog::open(&linked).is_err());
        let directory = root.join("logs"); fs::create_dir(&directory).unwrap(); fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&target, directory.join("startup.log")).unwrap(); assert!(PrivateLog::open(&directory).is_err());
        fs::remove_file(directory.join("startup.log")).unwrap();
        let mut storage = PrivateLog::open(&directory).unwrap(); storage.file.set_len(MAX_LOG as u64).unwrap();
        symlink(&target, directory.join("startup.log.1")).unwrap(); assert!(storage.write(&record()).is_err());
        assert_eq!(storage.file.metadata().unwrap().len(), MAX_LOG as u64); assert_eq!(fs::read_to_string(target).unwrap(), "SECRET");
        drop(storage); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn independent_writers_refuse_concurrent_retention_without_waiting() {
        let root = scratch(); let directory = root.join("logs");
        let mut first = PrivateLog::open(&directory).unwrap(); first.write(&record()).unwrap();
        let before = fs::read(directory.join("startup.log")).unwrap();
        let started = Instant::now();
        assert!(PrivateLog::open(&directory).is_err(), "A concurrent writer must not share retention ownership");
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(fs::read(directory.join("startup.log")).unwrap(), before);
        first.file.set_len(MAX_LOG as u64).unwrap(); first.write(&record()).unwrap();
        drop(first);
        let mut next = PrivateLog::open(&directory).unwrap(); next.write(&record()).unwrap();
        assert!(next.file.metadata().unwrap().len() <= MAX_LOG as u64);
        drop(next); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hardlinked_public_and_interrupted_backup_storage_is_refused_without_truncation() {
        let root = scratch(); let public = root.join("public"); fs::create_dir(&public).unwrap();
        fs::set_permissions(&public, fs::Permissions::from_mode(0o755)).unwrap(); assert!(PrivateLog::open(&public).is_err());
        let directory = root.join("private"); let mut log = PrivateLog::open(&directory).unwrap();
        fs::hard_link(directory.join("startup.log"), root.join("hardlink")).unwrap(); assert!(log.write(&record()).is_err());
        fs::remove_file(root.join("hardlink")).unwrap(); log.file.set_len(MAX_LOG as u64).unwrap();
        fs::write(directory.join(".startup.log.backup"), "prior backup").unwrap();
        assert!(log.write(&record()).is_err()); assert_eq!(log.file.metadata().unwrap().len(), MAX_LOG as u64);
        assert_eq!(fs::read_to_string(directory.join(".startup.log.backup")).unwrap(), "prior backup");
        drop(log); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn broken_observers_never_change_the_observed_operation() {
        let diagnostics = Diagnostics::new(|_| panic!("failed diagnostic sink"));
        assert_eq!(diagnostics.trace(Operation::Ensure).measure(Phase::Helper, || Ok::<_, ()>(7)), Ok(7));
    }
}
