use crate::{host::{self, Setup}, updates::{Handoff, Maintenance}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write}, os::fd::AsRawFd, path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc}, thread::{self, JoinHandle},
    time::{Duration, Instant},
};
const MAX_RECORD: usize = 16_384;
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_TIMEOUT: Duration = Duration::from_secs(180);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(5);

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all="camelCase")]
pub struct MaintenanceState {
    pub pending: bool, pub phase: Option<String>, pub from_version: Option<String>,
    pub to_version: Option<String>, pub backup_path: Option<PathBuf>, pub diagnostic: Option<String>,
}
pub struct NativeHelper { resources: PathBuf }
impl NativeHelper { pub fn new(resources: PathBuf) -> Self { Self { resources } } }
fn version(value: &str) -> Result<semver::Version, String> {
    let parsed = semver::Version::parse(value).map_err(|_| "Invalid maintenance version")?;
    if value.len() > 100 || !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed.to_string() != value {
        return Err("Invalid maintenance version".into());
    }
    Ok(parsed)
}
fn absolute(path: &Path) -> bool {
    path.is_absolute() && path.to_str().is_some_and(|p| !p.chars().any(char::is_control))
}
impl Maintenance for NativeHelper {
    fn prepare(&self, from: &str, to: &str, cancel: Arc<AtomicBool>) -> Result<Box<dyn Handoff>, String> {
        self.prepare_with_timeout(from, to, cancel, READY_TIMEOUT, SESSION_TIMEOUT)
    }
}
impl NativeHelper {
    fn prepare_with_timeout(&self, from: &str, to: &str, cancel: Arc<AtomicBool>, ready: Duration, total: Duration) -> Result<Box<dyn Handoff>, String> {
        if version(to)? <= version(from)? { return Err("Maintenance version must increase".into()); }
        if cancel.load(Ordering::SeqCst) { return Err("Update maintenance cancelled".into()); }
        let mut command = host::helper_command(&self.resources, Setup::PrepareUpdate, None)?;
        command.stdin(Stdio::piped());
        let mut session = Session::spawn(command, total)?;
        session.write(&json!({"fromVersion":from,"toVersion":to}), Some(&cancel))?;
        let value = session.record(session.deadline.min(Instant::now() + ready), Some(&cancel))?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all="camelCase")]
        struct Ready { ready: bool, backup_path: PathBuf }
        if !value.is_object() { return Err("Invalid maintenance readiness".into()); }
        let ready: Ready = serde_json::from_value(value).map_err(|_| "Invalid maintenance readiness")?;
        if !ready.ready || !absolute(&ready.backup_path) { return Err("Invalid maintenance readiness".into()); }
        Ok(Box::new(NativeHandoff { session, installing: false, terminal: false }))
    }
}
struct NativeHandoff { session: Session, installing: bool, terminal: bool }
impl NativeHandoff {
    fn action(&mut self, action: &str, expected: Value, terminal: bool) -> Result<(), String> {
        self.action_with_input(json!({"action":action}),expected,terminal)
    }
    fn action_with_input(&mut self, input: Value, expected: Value, terminal: bool) -> Result<(), String> {
        if self.terminal { return Err("Maintenance session already ended".into()); }
        let result = (|| {
            self.session.write(&input, None)?;
            if self.session.record(self.session.deadline, None)? != expected { return Err("Invalid maintenance acknowledgement".into()); }
            if terminal { self.session.finish()?; self.terminal = true; }
            Ok(())
        })();
        if result.is_err() { self.session.shutdown(); self.terminal = true; }
        result
    }
}
impl Handoff for NativeHandoff {
    fn begin_install(&mut self) -> Result<(), String> {
        if self.installing { return Err("Maintenance installation already began".into()); }
        self.action_with_input(json!({"action":"begin-install","installerPid":std::process::id()}), json!({"installing":true}), false)?;
        self.installing = true; Ok(())
    }
    fn commit(&mut self) -> Result<(), String> {
        if !self.installing { return Err("Maintenance installation has not begun".into()); }
        self.action("commit", json!({"committed":true}), true)
    }
    fn abort(&mut self) -> Result<(), String> { self.action("abort", json!({"aborted":true}), true) }
}

pub fn maintenance_state(resources: &Path) -> Result<MaintenanceState, String> {
    let value = one_shot(resources, Setup::MaintenanceState, None, Duration::from_secs(10))?;
    validate_maintenance_state(value)
}
pub(crate) fn validate_maintenance_state(value: Value) -> Result<MaintenanceState, String> {
    let keys = ["pending","phase","fromVersion","toVersion","backupPath","diagnostic"];
    if value.as_object().is_none_or(|o| o.len() != keys.len() || keys.iter().any(|k| !o.contains_key(*k))) {
        return Err("Invalid maintenance state".into());
    }
    let state: MaintenanceState = serde_json::from_value(value).map_err(|_| "Invalid maintenance state")?;
    if state.phase.as_deref().is_some_and(|p| !["prepared","installing","awaiting-health"].contains(&p))
        || state.backup_path.as_ref().is_some_and(|p| !absolute(p))
        || state.from_version.as_ref().is_some_and(|v| version(v).is_err())
        || state.to_version.as_ref().is_some_and(|v| version(v).is_err()) {
        return Err("Invalid maintenance state".into());
    }
    let empty = state.phase.is_none() && state.from_version.is_none() && state.to_version.is_none() && state.backup_path.is_none();
    let increasing = match (&state.from_version, &state.to_version) {
        (Some(from), Some(to)) => version(from)? < version(to)?,
        _ => false,
    };
    let valid = if !state.pending { empty && state.diagnostic.is_none() }
        else if state.diagnostic.is_some() { empty && state.diagnostic.as_deref() == Some("Pending update journal is invalid; manual recovery is required.") }
        else { state.phase.is_some() && state.backup_path.is_some() && increasing };
    if !valid { return Err("Inconsistent maintenance state".into()); }
    Ok(state)
}
pub fn recover(resources: &Path, compiled_version: &str) -> Result<PathBuf, String> {
    version(compiled_version)?;
    let value = one_shot(resources, Setup::RecoverUpdate, Some(json!({"appVersion":compiled_version})), READY_TIMEOUT)?;
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields, rename_all="camelCase")]
    struct Recovered { recovered: bool, interrupted: bool, state_root: PathBuf }
    if !value.is_object() { return Err("Invalid maintenance recovery".into()); }
    let result: Recovered = serde_json::from_value(value).map_err(|_| "Invalid maintenance recovery")?;
    if !absolute(&result.state_root) || (!result.recovered && result.interrupted) { return Err("Invalid maintenance recovery".into()); }
    Ok(result.state_root)
}
fn one_shot(resources: &Path, setup: Setup, input: Option<Value>, timeout: Duration) -> Result<Value, String> {
    let mut command = host::helper_command(resources, setup, None)?;
    if input.is_some() { command.stdin(Stdio::piped()); }
    let mut session = Session::spawn(command, timeout)?;
    if let Some(input) = input { session.write(&input,None)?; session.input.take(); }
    let value = session.record(session.deadline, None)?;
    session.finish()?;
    Ok(value)
}
fn nonblocking(fd: i32) -> Result<(), String> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd,libc::F_SETFL,flags | libc::O_NONBLOCK) } < 0 {
        return Err("Cannot configure maintenance pipes".into());
    }
    Ok(())
}
type Record = Result<Option<Value>, String>;
/// Owns the child and bounded pipe readers until terminal exit or cooperative cancellation.
struct Session {
    child: Child, input: Option<ChildStdin>, records: mpsc::Receiver<Record>,
    readers: Vec<JoinHandle<()>>, stop: Arc<AtomicBool>, deadline: Instant, closed: bool,
}
impl Session {
    fn spawn(mut command: Command, timeout: Duration) -> Result<Self, String> {
        let child = command.spawn().map_err(|_| "Cannot start maintenance helper")?;
        let (send, records) = mpsc::sync_channel(4);
        let mut session = Self { child, input:None, records, readers:Vec::new(), stop:Arc::new(AtomicBool::new(false)), deadline:Instant::now()+timeout, closed:false };
        session.input = session.child.stdin.take();
        if let Some(input) = &session.input { nonblocking(input.as_raw_fd())?; }
        let stdout = session.child.stdout.take().ok_or("Missing maintenance stdout")?;
        let stderr = session.child.stderr.take().ok_or("Missing maintenance stderr")?;
        nonblocking(stdout.as_raw_fd())?; nonblocking(stderr.as_raw_fd())?;
        let stop = session.stop.clone();
        session.readers.push(thread::spawn(move || read_records(stdout, send, stop)));
        let stop = session.stop.clone();
        session.readers.push(thread::spawn(move || {
            let mut stderr = stderr; let mut buffer = [0u8;4096];
            while !stop.load(Ordering::SeqCst) {
                match stderr.read(&mut buffer) {
                    Ok(0) => break, Ok(_) => {},
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(POLL),
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}, Err(_) => break,
                }
            }
        }));
        Ok(session)
    }
    fn check(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<(), String> {
        if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) { return Err("Update maintenance cancelled".into()); }
        if Instant::now() >= deadline { return Err("Update maintenance timed out".into()); }
        Ok(())
    }
    fn write(&mut self, value: &Value, cancel: Option<&AtomicBool>) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "Invalid maintenance input")?; bytes.push(b'\n');
        if bytes.len() > 4096 { return Err("Maintenance input exceeds limit".into()); }
        let mut offset = 0;
        while offset < bytes.len() {
            self.check(self.deadline,cancel)?;
            match self.input.as_mut().ok_or("Maintenance input closed")?.write(&bytes[offset..]) {
                Ok(0) => return Err("Maintenance input failed".into()), Ok(n) => offset += n,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(POLL),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {},
                Err(_) => return Err("Maintenance input failed".into()),
            }
        }
        Ok(())
    }
    fn next(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Record {
        loop {
            self.check(deadline,cancel)?;
            match self.records.recv_timeout(POLL.min(deadline.saturating_duration_since(Instant::now()))) {
                Ok(record) => return record,
                Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => return Err("Maintenance output interrupted".into()),
            }
        }
    }
    fn record(&self, deadline: Instant, cancel: Option<&AtomicBool>) -> Result<Value, String> {
        self.next(deadline,cancel)?.ok_or_else(|| "Maintenance output interrupted".into())
    }
    fn finish(&mut self) -> Result<(), String> {
        self.input.take();
        if self.next(self.deadline,None)?.is_some() { return Err("Unexpected maintenance output".into()); }
        loop {
            self.check(self.deadline,None)?;
            if let Some(status) = self.child.try_wait().map_err(|_| "Maintenance wait failed")? {
                if !status.success() { return Err("Maintenance helper failed".into()); }
                if self.readers.iter().all(JoinHandle::is_finished) { break; }
            }
            thread::sleep(POLL);
        }
        for reader in self.readers.drain(..) { let _ = reader.join(); }
        self.closed = true;
        Ok(())
    }
    fn shutdown(&mut self) {
        if self.closed { return; }
        self.input.take();
        if self.child.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(self.child.id() as i32,libc::SIGTERM); }
            let deadline = Instant::now()+CANCEL_TIMEOUT;
            while Instant::now() < deadline {
                if self.child.try_wait().ok().flatten().is_some() { break; }
                thread::sleep(POLL);
            }
        }
        // The helper's group may retain pipe descriptors after the helper itself exits.
        unsafe { libc::kill(-(self.child.id() as i32),libc::SIGKILL); }
        let _ = self.child.kill(); let _ = self.child.wait();
        self.stop.store(true,Ordering::SeqCst);
        for reader in self.readers.drain(..) { let _ = reader.join(); }
        self.closed = true;
    }
}
impl Drop for Session { fn drop(&mut self) { self.shutdown(); } }
fn read_records(mut stdout: impl Read, send: mpsc::SyncSender<Record>, stop: Arc<AtomicBool>) {
    let mut buffer = [0u8;4096]; let mut line = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        match stdout.read(&mut buffer) {
            Ok(0) => { let _ = send.try_send(if line.is_empty() { Ok(None) } else { Err("Truncated maintenance output".into()) }); return; }
            Ok(count) => for byte in &buffer[..count] {
                if line.len()+1 > MAX_RECORD { let _ = send.try_send(Err("Oversized maintenance output".into())); return; }
                if *byte == b'\n' {
                    let result = serde_json::from_slice(&line).map(Some).map_err(|_| "Malformed maintenance output".into());
                    line.clear();
                    let invalid = result.is_err();
                    if send.try_send(result).is_err() || invalid { return; }
                } else { line.push(*byte); }
            },
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(POLL),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {},
            Err(_) => { let _ = send.try_send(Err("Maintenance output failed".into())); return; }
        }
    }
}

#[cfg(test)]
mod tests {
 use super::*;
 use std::{fs, os::unix::fs::PermissionsExt, sync::atomic::Ordering, thread, time::{Duration,Instant}};
 struct Fixture {root:PathBuf}
 impl Fixture {
  fn new(body:&str)->Self {
   let root=crate::host::fixtures::scratch();
   fs::write(root.join("agent.mjs"), "test only").unwrap();
   let script=format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}/args'\necho $$ > '{}/pid'\n{}\n",root.display(),root.display(),body);
   fs::write(root.join("bun"),script).unwrap();fs::set_permissions(root.join("bun"),fs::Permissions::from_mode(0o700)).unwrap();Self {root}
  }
  fn helper(&self)->NativeHelper {NativeHelper::new(self.root.clone())}
  fn exited(&self) {
   let pid:i32=fs::read_to_string(self.root.join("pid")).unwrap().trim().parse().unwrap();
   assert_eq!(unsafe {libc::kill(pid,0)}, -1, "helper must be reaped");
  }
 }
 impl Drop for Fixture {fn drop(&mut self) {let _=fs::remove_dir_all(&self.root);}}
 const READY:&str="read initial; printf '%s\n' '{\"ready\":true,\"backupPath\":\"/tmp/test-backup\"}'";
 fn cancelled()->Arc<AtomicBool> {Arc::new(AtomicBool::new(false))}
 #[test]
 fn retains_helper_until_commit_and_uses_fixed_native_arguments() {
  let f=Fixture::new(&format!("{}\nprintf '%s\n' \"$initial\" > input\nread begin; printf '%s\n' \"$begin\" > begin\n printf '%s\n' '{{\"installing\":true}}'\nread commit; printf '%s\n' '{{\"committed\":true}}'\nsleep 0.03", READY));
  let mut handoff=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();
  handoff.begin_install().unwrap();handoff.commit().unwrap();f.exited();
  let args=fs::read_to_string(f.root.join("args")).unwrap();let args:Vec<_>=args.lines().collect();
  assert_eq!(args.len(),4);assert_eq!(args[1],"--prepare-update");assert_eq!(args[2],"--app");assert_eq!(Path::new(args[3]),std::env::current_exe().unwrap());
  assert_eq!(serde_json::from_str::<serde_json::Value>(&fs::read_to_string(f.root.join("input")).unwrap()).unwrap(),serde_json::json!({"fromVersion":"0.1.0","toVersion":"0.2.0"}));
  assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(f.root.join("begin")).unwrap()).unwrap(),json!({"action":"begin-install","installerPid":std::process::id()}));
 }
 #[test]
 fn abort_joins_the_helper_before_returning() {
  let f=Fixture::new(&format!("{}\nread abort; printf '%s\n' '{{\"aborted\":true}}'",READY));
  let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();h.abort().unwrap();f.exited();
 }
 #[test]
 fn dropping_an_installing_session_terminates_the_owned_process() {
  let f=Fixture::new(&format!("{}\nread begin; printf '%s\n' '{{\"installing\":true}}'\nread next",READY));
  let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();h.begin_install().unwrap();drop(h);f.exited();
 }
 #[test]
 fn cancellation_joins_helper_without_forwarding_stderr() {
  let f=Fixture::new("read initial; echo secret-token >&2; while :; do sleep 0.01; done");
  let stop=cancelled();let later=stop.clone();let marker=f.root.join("pid");thread::spawn(move||{let deadline=Instant::now()+Duration::from_secs(2);while !marker.exists() && Instant::now()<deadline {thread::sleep(Duration::from_millis(5));}later.store(true,Ordering::SeqCst);});
  let start=Instant::now();let error=f.helper().prepare("0.1.0","0.2.0",stop).err().unwrap();
  assert!(error.contains("cancel"));assert!(!error.contains("secret-token"));assert!(start.elapsed()<Duration::from_secs(6));f.exited();
 }
 #[test]
 fn malformed_oversized_wrong_type_and_extra_records_refuse_handoff() {
  for record in ["not-json".to_string(),"x".repeat(16_385),r#"{"ready":true,"backupPath":"relative"}"#.into(),r#"{"ready":"true","backupPath":"/tmp/x"}"#.into(),r#"{"ready":true,"backupPath":"/tmp/x","command":"evil"}"#.into()] {
   let f=Fixture::new(&format!("read initial; printf '%s\n' '{}'",record));assert!(f.helper().prepare("0.1.0","0.2.0",cancelled()).is_err());f.exited();
  }
  let f=Fixture::new(&format!("{}\nread begin; printf '%s\n' '{{\"installing\":true}}' '{{\"committed\":true}}' '{{\"committed\":true}}'",READY));
  let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();h.begin_install().unwrap();assert!(h.commit().is_err());drop(h);f.exited();
 }
 #[test]
 fn strict_state_and_recovery_work_without_prepare() {
  let f=Fixture::new(r#"printf '%s
' '{"pending":false,"phase":null,"fromVersion":null,"toVersion":null,"backupPath":null,"diagnostic":null}'"#);
  assert!(!maintenance_state(&f.root).unwrap().pending);f.exited();
  let f=Fixture::new(r#"read input; printf '%s
' "$input" > input; printf '%s
' '{"recovered":true,"interrupted":true,"stateRoot":"/tmp/state"}'"#);
  assert_eq!(recover(&f.root,"0.1.0").unwrap(),PathBuf::from("/tmp/state"));f.exited();
  assert_eq!(fs::read_to_string(f.root.join("input")).unwrap().trim(),r#"{"appVersion":"0.1.0"}"#);
  let args=fs::read_to_string(f.root.join("args")).unwrap();assert!(args.contains("--recover-update\n--app\n"));
 }
 #[test]
 fn rejects_incomplete_state_and_relative_recovery_paths() {
  for record in [r#"{"pending":false}"#,r#"{"pending":true,"phase":"bogus","fromVersion":null,"toVersion":null,"backupPath":null,"diagnostic":null}"#] {
   let f=Fixture::new(&format!("printf '%s\n' '{}'",record));assert!(maintenance_state(&f.root).is_err());f.exited();
  }
  let f=Fixture::new(r#"read input; printf '%s
' '{"recovered":true,"interrupted":false,"stateRoot":"relative"}'"#);assert!(recover(&f.root,"0.1.0").is_err());f.exited();
 }
 #[test]
 fn readiness_and_terminal_waits_have_bounded_cleanup() {
  let f=Fixture::new("read initial; while :; do sleep 0.01; done");
  let started=Instant::now();
  let error=f.helper().prepare_with_timeout("0.1.0","0.2.0",cancelled(),Duration::from_secs(1),Duration::from_secs(2)).err().unwrap();
  assert!(error.contains("timed out"));assert!(started.elapsed()<Duration::from_secs(4));f.exited();
  let f=Fixture::new(&format!("{}\nread begin; printf '%s\\n' '{{\"installing\":true}}'\nread commit; printf '%s\\n' '{{\"committed\":true}}'\nwhile :; do sleep 0.01; done",READY));
  let mut h=f.helper().prepare_with_timeout("0.1.0","0.2.0",cancelled(),Duration::from_secs(2),Duration::from_secs(2)).unwrap();
  h.begin_install().unwrap();assert!(h.commit().unwrap_err().contains("timed out"));f.exited();
 }
 #[test]
 fn rejects_missing_acknowledgements_and_nonzero_terminal_exit() {
  for body in [format!("{}\nread begin; exit 0",READY),format!("{}\nread begin; printf '%s\\n' '{{\"installing\":false}}'",READY)] {
   let f=Fixture::new(&body);let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();assert!(h.begin_install().is_err());f.exited();
  }
  let f=Fixture::new(&format!("{}\nread begin; printf '%s\\n' '{{\"installing\":true}}'\nread commit; printf '%s\\n' '{{\"committed\":true}}'; exit 1",READY));
  let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();h.begin_install().unwrap();assert!(h.commit().is_err());f.exited();
 }
 #[test]
 fn repeated_install_and_commit_before_begin_never_write_an_action() {
  let f=Fixture::new(&format!("{}\nread begin; printf '%s\\n' '{{\"installing\":true}}'\nread abort; printf '%s\\n' '{{\"aborted\":true}}'",READY));
  let mut h=f.helper().prepare("0.1.0","0.2.0",cancelled()).unwrap();assert!(h.commit().is_err());h.begin_install().unwrap();assert!(h.begin_install().is_err());h.abort().unwrap();assert!(h.abort().is_err());f.exited();
 }
 #[test]
 fn detached_inherited_pipes_cannot_block_reader_join() {
  let f=Fixture::new(&format!("{}\nread abort; sleep 5 &\nprintf '%s\\n' '{{\"aborted\":true}}'",READY));
  let started=Instant::now();let mut h=f.helper().prepare_with_timeout("0.1.0","0.2.0",cancelled(),Duration::from_secs(2),Duration::from_secs(2)).unwrap();
  assert!(h.abort().is_err());assert!(started.elapsed()<Duration::from_secs(4));f.exited();
 }

}
