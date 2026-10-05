use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_RECORD: usize = 16_384;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
type Pending = HashMap<String, mpsc::Sender<Result<Value, String>>>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Progress {
    version: u8,
    event: String,
    #[serde(rename = "operationId")]
    operation_id: String,
    state: String,
    percent: u8,
    detail: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Success {
    version: u8,
    id: String,
    ok: bool,
    result: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Failure {
    version: u8,
    id: String,
    ok: bool,
    error: ProtocolError,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolError {
    code: String,
    message: String,
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 100
}
fn validate(message: &Value) -> Result<(), String> {
    if message.get("event").is_some() {
        let m: Progress =
            serde_json::from_value(message.clone()).map_err(|_| "Invalid progress")?;
        if m.version != 1
            || m.event != "progress"
            || !valid_id(&m.operation_id)
            || !["running", "completed", "cancelled", "failed"].contains(&m.state.as_str())
            || m.percent > 100
            || m.detail.encode_utf16().count() > 500
        {
            return Err("Invalid progress contract".into());
        }
    } else if message.get("ok") == Some(&Value::Bool(true)) {
        let m: Success = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 1 || !m.ok || !valid_id(&m.id) {
            return Err("Invalid success response".into());
        }
        let _ = m.result;
    } else {
        let m: Failure = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 1
            || m.ok
            || !valid_id(&m.id)
            || !valid_id(&m.error.code)
            || m.error.message.encode_utf16().count() > 500
        {
            return Err("Invalid failure response".into());
        }
    }
    Ok(())
}
fn bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut result = Vec::new();
    loop {
        let part = reader.fill_buf().map_err(|e| e.to_string())?;
        if part.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Err("Truncated backend record".into())
            };
        }
        let end = part.iter().position(|byte| *byte == b'\n');
        let count = end.unwrap_or(part.len());
        if result.len() + count > MAX_RECORD {
            return Err("Oversized backend record".into());
        }
        result.extend_from_slice(&part[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            return Ok(Some(result));
        }
    }
}
// Own the directory before a backend can create any operation resources.
struct SessionDirectory(PathBuf);
impl SessionDirectory {
    fn create() -> Result<Self, String> {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        for attempt in 0..16 {
            let path = std::env::temp_dir().join(format!(
                "nortuscc-fixture-session-{}-{timestamp}-{attempt}",
                std::process::id()
            ));
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("Unable to create a fresh fixture session".into())
    }
}
impl Drop for SessionDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<Pending>,
    alive: AtomicBool,
    stopped: AtomicBool,
    next_id: AtomicU64,
    emit: Emit,
    session: SessionDirectory,
    // Shutdown waits for any monitor cleanup already in flight.
    cleanup: Mutex<()>,
}
impl Inner {
    fn disconnect(&self, reason: &str) {
        if self.alive.swap(false, Ordering::SeqCst) {
            for (_, sender) in self.pending.lock().unwrap().drain() {
                let _ = sender.send(Err(reason.into()));
            }
            (self.emit)(json!({"event":"disconnected", "detail":reason}));
        }
    }
    fn force_stop(&self) {
        let _cleanup = self.cleanup.lock().unwrap();
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut child = self.child.lock().unwrap();
        #[cfg(unix)]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        drop(child);
        let _ = std::fs::remove_dir_all(&self.session.0);
    }
}
pub struct Backend {
    inner: Arc<Inner>,
}
impl Backend {
    pub fn spawn(resources: &Path, emit: Emit) -> Result<Self, String> {
        let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
        let script = resources.join("backend.mjs");
        if !node.is_absolute() || !node.is_file() || !script.is_file() {
            return Err(format!(
                "Missing bundled runtime at {}",
                resources.display()
            ));
        }
        let session = SessionDirectory::create()?;
        let mut command = Command::new(node);
        command
            .arg(script)
            .current_dir(resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env("NORTUSCC_FIXTURE_SESSION", &session.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take();
        let inner = Arc::new(Inner {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            stopped: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            emit,
            session,
            cleanup: Mutex::new(()),
        });
        eprintln!(
            "host: {}",
            json!({"event":"session", "directory":inner.session.0})
        );
        let read = inner.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let result = (|| -> Result<(), String> {
                while let Some(line) = bounded_line(&mut reader)? {
                    let value: Value =
                        serde_json::from_slice(&line).map_err(|_| "Malformed backend JSON")?;
                    validate(&value)?;
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        if let Some(sender) = read.pending.lock().unwrap().remove(id) {
                            let result = if value["ok"] == true {
                                Ok(value["result"].clone())
                            } else {
                                Err(format!(
                                    "{}: {}",
                                    value["error"]["code"].as_str().unwrap_or("ERROR"),
                                    value["error"]["message"]
                                        .as_str()
                                        .unwrap_or("Request failed")
                                ))
                            };
                            let _ = sender.send(result);
                        }
                    } else {
                        (read.emit)(value);
                    }
                }
                Err("Backend exited; restart explicitly".into())
            })();
            read.disconnect(&result.unwrap_err());
            read.stdin.lock().unwrap().take();
            // Closing the pipe gives the backend its cleanup window, even for invalid output.
        });
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            while let Ok(Some(line)) = bounded_line(&mut reader) {
                eprintln!("backend: {}", String::from_utf8_lossy(&line));
            }
        });
        let monitor = inner.clone();
        thread::spawn(move || loop {
            if monitor
                .child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .is_some()
            {
                monitor.disconnect("Backend exited; restart explicitly");
                thread::sleep(Duration::from_millis(1200));
                monitor.force_stop();
                break;
            }
            if !monitor.alive.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1200));
                monitor.force_stop();
                break;
            }
            thread::sleep(Duration::from_millis(20));
        });
        Ok(Self { inner })
    }
    pub fn request(&self, command: &str) -> Result<Value, String> {
        self.request_timeout(command, REQUEST_TIMEOUT)
    }
    fn request_timeout(&self, command: &str, timeout: Duration) -> Result<Value, String> {
        if !["inspect", "start", "cancel", "shutdown", "crash"].contains(&command) {
            return Err("Unknown fixture command".into());
        }
        let id = self
            .inner
            .next_id
            .fetch_add(1, Ordering::SeqCst)
            .to_string();
        let (sender, receiver) = mpsc::channel();
        // Register while holding the same lock disconnect drains, so exit cannot strand a new request.
        {
            let mut pending = self.inner.pending.lock().unwrap();
            if !self.inner.alive.load(Ordering::SeqCst) {
                return Err("Backend disconnected; restart explicitly".into());
            }
            pending.insert(id.clone(), sender);
        }
        let record = format!("{}\n", json!({"version":1,"id":id,"command":command}));
        let written = self
            .inner
            .stdin
            .lock()
            .unwrap()
            .as_mut()
            .ok_or("Backend input closed")
            .and_then(|stdin| {
                stdin
                    .write_all(record.as_bytes())
                    .map_err(|_| "Backend write failed")
            });
        if let Err(error) = written {
            self.inner.disconnect(error);
            return Err(error.into());
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.inner.pending.lock().unwrap().remove(&id);
                self.inner.disconnect("Backend request timed out");
                self.inner.stdin.lock().unwrap().take();
                Err("Backend request timed out; restart explicitly".into())
            }
        }
    }
    pub fn shutdown(&self) {
        if self.inner.alive.load(Ordering::SeqCst) {
            let _ = self.request_timeout("shutdown", Duration::from_millis(1200));
        }
        self.inner.stdin.lock().unwrap().take();
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if self
                .inner
                .child
                .lock()
                .unwrap()
                .try_wait()
                .ok()
                .flatten()
                .is_some()
            {
                self.inner.disconnect("Backend stopped");
                self.inner.force_stop();
                return;
            }
            thread::sleep(Duration::from_millis(15));
        }
        self.inner.disconnect("Backend forced to stop");
        self.inner.force_stop();
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_progress_and_response() {
        for value in [
            json!({"version":2,"id":"x","ok":true,"result":null}),
            json!({"version":1,"id":"😀".repeat(60),"ok":true,"result":null}),
            json!({"version":1,"event":"progress","operationId":"x","state":"running","percent":101,"detail":"bad"}),
            json!({"version":1,"id":"x","ok":true,"result":null,"extra":true}),
        ] {
            assert!(validate(&value).is_err());
        }
        assert!(validate(&json!({"version":1,"id":"x","ok":true,"result":null})).is_ok());
    }
    #[test]
    fn records_are_bounded_and_truncation_fails() {
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(vec![
            b'x';
            MAX_RECORD
                + 1
        ])))
        .is_err());
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(b"{}"))).is_err());
        assert_eq!(
            bounded_line(&mut BufReader::new(std::io::Cursor::new(b"{}\n")))
                .unwrap()
                .unwrap(),
            b"{}"
        );
    }
    fn runtime() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(format!(
                "{}-{}",
                std::env::consts::OS.replace("macos", "darwin"),
                std::env::consts::ARCH.replace("aarch64", "arm64")
            ))
    }
    #[test]
    fn real_backend_correlation_cancellation_crash_and_fresh_restart() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let owner = Backend::spawn(
            &runtime(),
            Arc::new(move |event| captured.lock().unwrap().push(event)),
        )
        .unwrap();
        let session = owner.inner.session.0.clone();
        assert_eq!(
            owner.request("inspect").unwrap()["diff"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(owner.request("start").unwrap()["operationId"].is_string());
        assert!(owner.request("start").unwrap_err().starts_with("BUSY"));
        owner.request("cancel").unwrap();
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["state"] == "cancelled"));
        owner.request("crash").unwrap();
        thread::sleep(Duration::from_millis(80));
        assert!(owner.request("inspect").is_err());
        drop(owner);
        assert!(!session.exists());
        let fresh = Backend::spawn(&runtime(), Arc::new(|_| {})).unwrap();
        assert_eq!(
            fresh.request("inspect").unwrap()["diff"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    fn fake_backend(source: &str) -> (Backend, PathBuf) {
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
        let directory = std::env::temp_dir().join(format!(
            "fixture-host-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&directory).unwrap();
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64/node");
        #[cfg(unix)]
        std::os::unix::fs::symlink(runtime, directory.join("node")).unwrap();
        std::fs::write(directory.join("backend.mjs"), source).unwrap();
        (
            Backend::spawn(&directory, Arc::new(|_| {})).unwrap(),
            directory,
        )
    }
    #[test]
    fn abrupt_death_before_child_spawn_removes_operation_directory() {
        let bundle =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64/backend.mjs");
        let source = format!(
            r#"
            import fs from 'node:fs';
            import promises from 'node:fs/promises';
            import {{ syncBuiltinESMExports }} from 'node:module';
            const original = promises.mkdtemp;
            promises.mkdtemp = async prefix => {{
                const directory = await original(prefix);
                fs.writeFileSync(new URL('./created.txt', import.meta.url), directory);
                process.kill(process.pid, 'SIGSTOP');
                return directory;
            }};
            syncBuiltinESMExports();
            await import({});
        "#,
            serde_json::to_string(bundle.to_str().unwrap()).unwrap()
        );
        let (backend, resources) = fake_backend(&source);
        backend.request("start").unwrap();
        let marker = resources.join("created.txt");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !marker.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let operation = PathBuf::from(std::fs::read_to_string(&marker).unwrap());
        assert!(operation.is_dir());
        let session = backend.inner.session.0.clone();
        assert_eq!(operation.parent(), Some(session.as_path()));
        let pid = backend.inner.child.lock().unwrap().id();
        backend.inner.child.lock().unwrap().kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while (operation.exists() || session.exists()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let cleaned = !operation.exists() && !session.exists();
        if operation.exists() {
            std::fs::remove_dir_all(&operation).unwrap();
        }
        drop(backend);
        std::fs::remove_dir_all(resources).unwrap();
        assert!(
            cleaned,
            "Pre-child crash leaked an operation directory without a resource diagnostic"
        );
        #[cfg(unix)]
        {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(unsafe { libc::kill(-(pid as i32), 0) }, -1);
        }
    }
    #[test]
    fn timeout_disconnects_owner_and_no_request_is_retried() {
        let (backend, directory) =
            fake_backend("process.stdin.resume(); setInterval(() => {}, 1000)");
        assert!(backend
            .request_timeout("inspect", Duration::from_millis(60))
            .unwrap_err()
            .contains("timed out"));
        assert!(backend
            .request("start")
            .unwrap_err()
            .contains("disconnected"));
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn malformed_oversized_output_rejects_pending_requests() {
        for output in ["{broken", &"x".repeat(MAX_RECORD + 1)] {
            let source = format!("process.stdin.once('data', () => process.stdout.write({} + '\\n')); process.stdin.resume(); setInterval(() => {{}}, 1000)", serde_json::to_string(output).unwrap());
            let (backend, directory) = fake_backend(&source);
            let started = Instant::now();
            assert!(backend.request("inspect").is_err());
            assert!(started.elapsed() < Duration::from_secs(2));
            drop(backend);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn child_death_rejects_every_pending_request() {
        let (backend, directory) =
            fake_backend("process.stdin.resume(); setInterval(() => {}, 1000)");
        let backend = Arc::new(backend);
        let mut requests = Vec::new();
        for _ in 0..3 {
            let backend = backend.clone();
            requests.push(thread::spawn(move || backend.request("inspect")));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while backend.inner.pending.lock().unwrap().len() < 3 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(backend.inner.pending.lock().unwrap().len(), 3);
        backend.inner.child.lock().unwrap().kill().unwrap();
        for request in requests {
            assert!(request.join().unwrap().unwrap_err().contains("exited"));
        }
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn unexpected_child_death_removes_the_entire_owned_session() {
        let (backend, resources) =
            fake_backend("process.stdin.resume(); setInterval(() => {}, 1000)");
        let session = backend.inner.session.0.clone();
        std::fs::create_dir(session.join("unregistered-operation")).unwrap();
        backend.inner.child.lock().unwrap().kill().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while session.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            !session.exists(),
            "Unexpected backend death leaked its session"
        );
        drop(backend);
        std::fs::remove_dir_all(resources).unwrap();
    }
    #[test]
    fn forced_shutdown_removes_session_before_returning() {
        let (backend, resources) =
            fake_backend("process.stdin.resume(); setInterval(() => {}, 1000)");
        let session = backend.inner.session.0.clone();
        std::fs::create_dir(session.join("unregistered-operation")).unwrap();
        backend.shutdown();
        assert!(!session.exists());
        drop(backend);
        std::fs::remove_dir_all(resources).unwrap();
    }
    #[test]
    fn session_directory_is_private_and_removed_when_spawn_setup_is_abandoned() {
        let session = SessionDirectory::create().unwrap();
        let path = session.0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(session);
        assert!(!path.exists());
    }
}
