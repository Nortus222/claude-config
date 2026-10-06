use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_RECORD: usize = 1_048_576;
const MAX_EXCLUDED: usize = 10_000;
const MAX_KEY: usize = 500;
type Pending = HashMap<String, mpsc::Sender<Result<Value, String>>>;
type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// The only requests the renderer can cause. Arguments are opaque item keys and plan ids,
/// never paths or commands.
pub enum Request {
    Inspect,
    Preview { exclude: Vec<String> },
    Apply { plan_id: String },
    Cancel,
    Shutdown,
}
impl Request {
    fn command(&self) -> &'static str {
        match self {
            Request::Inspect => "inspect",
            Request::Preview { .. } => "preview",
            Request::Apply { .. } => "apply",
            Request::Cancel => "cancel",
            Request::Shutdown => "shutdown",
        }
    }
    // Inspect and apply re-read the machine, which can take seconds; cancel waits for a step.
    fn timeout(&self) -> Duration {
        Duration::from_secs(match self {
            Request::Inspect | Request::Apply { .. } => 60,
            Request::Preview { .. } => 10,
            Request::Cancel => 30,
            Request::Shutdown => 5,
        })
    }
    fn record(&self, id: &str) -> Result<String, String> {
        let mut record = json!({"version": 2, "id": id, "command": self.command()});
        match self {
            Request::Preview { exclude } => {
                if exclude.len() > MAX_EXCLUDED
                    || exclude
                        .iter()
                        .any(|key| key.is_empty() || key.encode_utf16().count() > MAX_KEY)
                {
                    return Err("Invalid item keys".into());
                }
                record["exclude"] = json!(exclude);
            }
            Request::Apply { plan_id } => {
                if !valid_id(plan_id) {
                    return Err("Invalid plan id".into());
                }
                record["planId"] = json!(plan_id);
            }
            _ => {}
        }
        let line = format!("{record}\n");
        if line.len() > MAX_RECORD {
            return Err("Request exceeds the record limit".into());
        }
        Ok(line)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunEvent {
    version: u8,
    event: String,
    #[serde(rename = "runId")]
    run_id: String,
    progress: serde_json::Map<String, Value>,
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
        let m: RunEvent =
            serde_json::from_value(message.clone()).map_err(|_| "Invalid run event")?;
        let kind = m.progress.get("type").and_then(Value::as_str).unwrap_or("");
        if m.version != 2
            || m.event != "progress"
            || !valid_id(&m.run_id)
            || !["started", "finished", "done", "cancelled", "failed"].contains(&kind)
        {
            return Err("Invalid run event contract".into());
        }
    } else if message.get("ok") == Some(&Value::Bool(true)) {
        let m: Success = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 2 || !m.ok || !valid_id(&m.id) {
            return Err("Invalid success response".into());
        }
        let _ = m.result;
    } else {
        let m: Failure = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 2
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
struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Mutex<Pending>,
    alive: AtomicBool,
    stopped: AtomicBool,
    next_id: AtomicU64,
    emit: Emit,
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
    }
}
pub struct Backend {
    inner: Arc<Inner>,
}
// A HOME-isolated backend must not reach the real configuration through these.
const ISOLATED_CONFIG_VARS: [&str; 4] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "ZDOTDIR"];
impl Backend {
    /// Starts the bundled backend. `home`, when given, makes the child a self-contained machine at
    /// that HOME (tests and smoke): it sets HOME and drops every
    /// inherited NORTUSCC_* override and config-location variable (`ISOLATED_CONFIG_VARS`).
    pub fn spawn(resources: &Path, home: Option<&Path>, emit: Emit) -> Result<Self, String> {
        let bun = resources.join(if cfg!(windows) { "bun.exe" } else { "bun" });
        let script = resources.join("backend.mjs");
        if !bun.is_absolute() || !bun.is_file() || !script.is_file() {
            return Err(format!(
                "Missing bundled runtime at {}",
                resources.display()
            ));
        }
        let mut command = Command::new(bun);
        command
            .arg(script)
            .current_dir(resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .env_remove("BUN_OPTIONS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(home) = home {
            command.env("HOME", home);
            for key in ISOLATED_CONFIG_VARS {
                command.env_remove(key);
            }
            for (key, _) in std::env::vars_os() {
                if key.to_string_lossy().starts_with("NORTUSCC_") {
                    command.env_remove(key);
                }
            }
        }
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
            cleanup: Mutex::new(()),
        });
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
    pub fn request(&self, request: Request) -> Result<Value, String> {
        let timeout = request.timeout();
        self.request_timeout(request, timeout)
    }
    fn request_timeout(&self, request: Request, timeout: Duration) -> Result<Value, String> {
        let id = self
            .inner
            .next_id
            .fetch_add(1, Ordering::SeqCst)
            .to_string();
        let record = request.record(&id)?;
        let (sender, receiver) = mpsc::channel();
        // Register while holding the same lock disconnect drains, so exit cannot strand a new request.
        {
            let mut pending = self.inner.pending.lock().unwrap();
            if !self.inner.alive.load(Ordering::SeqCst) {
                return Err("Backend disconnected; restart explicitly".into());
            }
            pending.insert(id.clone(), sender);
        }
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
            let _ = self.request_timeout(Request::Shutdown, Duration::from_secs(5));
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
    use std::path::PathBuf;
    fn checkout() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap()
    }
    fn runtime() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64")
    }
    // A temporary HOME; with `record`, its state.json names this checkout.
    fn home(record: bool) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!("nortuscc-host-home-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        let state = dir.join(".config/nortuscc");
        std::fs::create_dir_all(&state).unwrap();
        if record {
            std::fs::write(state.join("state.json"), json!({"version":1,"repo":checkout(),"skillsOnly":false,"files":{}}).to_string()).unwrap();
        }
        dir
    }
    #[test]
    fn rejects_invalid_events_and_responses() {
        for value in [
            json!({"version":1,"id":"x","ok":true,"result":null}),
            json!({"version":2,"id":"😀".repeat(60),"ok":true,"result":null}),
            json!({"version":2,"event":"progress","runId":"r","progress":{"type":"exploded"}}),
            json!({"version":2,"event":"progress","runId":"r","progress":"done"}),
            json!({"version":1,"event":"progress","operationId":"x","state":"running","percent":1,"detail":""}),
            json!({"version":2,"id":"x","ok":true,"result":null,"extra":true}),
        ] {
            assert!(validate(&value).is_err(), "{value}");
        }
        assert!(validate(&json!({"version":2,"id":"x","ok":true,"result":null})).is_ok());
        assert!(validate(&json!({"version":2,"event":"progress","runId":"r","progress":{"type":"done","ok":1,"failed":0}})).is_ok());
    }
    #[test]
    fn records_are_bounded_at_one_mebibyte() {
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(vec![b'x'; MAX_RECORD + 1]))).is_err());
        let mut big = vec![b'x'; MAX_RECORD];
        big.push(b'\n');
        assert_eq!(bounded_line(&mut BufReader::new(std::io::Cursor::new(big))).unwrap().unwrap().len(), MAX_RECORD);
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(b"{}"))).is_err());
    }
    #[test]
    fn requests_carry_only_allow_listed_arguments() {
        let line = Request::Preview { exclude: vec!["config:a".into()] }.record("7").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"version":2,"id":"7","command":"preview","exclude":["config:a"]}));
        let line = Request::Apply { plan_id: "p".into() }.record("8").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"version":2,"id":"8","command":"apply","planId":"p"}));
        assert!(Request::Preview { exclude: vec!["k".into(); MAX_EXCLUDED + 1] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec!["x".repeat(MAX_KEY + 1)] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec![String::new()] }.record("1").is_err());
        assert!(Request::Apply { plan_id: String::new() }.record("1").is_err());
        assert!(Request::Apply { plan_id: "x".repeat(101) }.record("1").is_err());
    }
    #[test]
    fn real_backend_inspects_previews_applies_and_restarts() {
        let home = home(true);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let owner = Backend::spawn(&runtime(), Some(&home), Arc::new(move |e| captured.lock().unwrap().push(e))).unwrap();
        let inspected = owner.request(Request::Inspect).unwrap();
        assert_eq!(inspected["profile"]["repo"], json!(checkout()));
        let preview = owner.request(Request::Preview { exclude: vec![] }).unwrap();
        let plan_id = preview["planId"].as_str().unwrap().to_string();
        let applied = owner.request(Request::Apply { plan_id }).unwrap();
        assert_eq!(applied["status"], "started");
        let deadline = Instant::now() + Duration::from_secs(30);
        while !events.lock().unwrap().iter().any(|e| e["progress"]["type"] == "done") {
            assert!(Instant::now() < deadline, "no done event: {:?}", events.lock().unwrap());
            thread::sleep(Duration::from_millis(20));
        }
        assert!(owner.request(Request::Preview { exclude: vec!["not-an-item".into()] }).unwrap_err().starts_with("UNKNOWN_KEY"));
        assert!(!home.join(".config/nortuscc/apply.lock").exists());
        owner.inner.child.lock().unwrap().kill().unwrap();
        thread::sleep(Duration::from_millis(80));
        assert!(owner.request(Request::Inspect).is_err());
        drop(owner);
        let fresh = Backend::spawn(&runtime(), Some(&home), Arc::new(|_| {})).unwrap();
        assert!(fresh.request(Request::Inspect).is_ok());
        drop(fresh);
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn real_backend_reports_a_missing_checkout_record() {
        let home = home(false);
        let owner = Backend::spawn(&runtime(), Some(&home), Arc::new(|_| {})).unwrap();
        assert!(owner.request(Request::Inspect).unwrap_err().starts_with("REPO_NOT_FOUND"));
        drop(owner);
        std::fs::remove_dir_all(home).unwrap();
    }
}

#[cfg(test)]
pub(crate) mod lifecycle_tests {
    use super::*;
    use std::path::PathBuf;
    // Runs `source` on the bundled Bun as the backend; returns its temporary resources directory.
    pub(crate) fn fake_backend(source: &str, emit: Emit) -> (Backend, PathBuf) {
        static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);
        let directory = std::env::temp_dir().join(format!(
            "nortuscc-host-test-{}-{}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&directory).unwrap();
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64/bun");
        std::os::unix::fs::symlink(runtime, directory.join("bun")).unwrap();
        std::fs::write(directory.join("backend.mjs"), source).unwrap();
        (Backend::spawn(&directory, None, emit).unwrap(), directory)
    }
    #[test]
    fn home_isolated_backend_drops_config_location_overrides() {
        let directory = std::env::temp_dir().join(format!("nortuscc-host-env-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let runtime = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/darwin-arm64/bun");
        std::os::unix::fs::symlink(runtime, directory.join("bun")).unwrap();
        let out = directory.join("env.json");
        let names = format!("{:?}", ISOLATED_CONFIG_VARS);
        std::fs::write(
            directory.join("backend.mjs"),
            format!(
                "const names = {names}; require('node:fs').writeFileSync({out:?}, JSON.stringify({{ home: process.env.HOME, vars: names.map(n => process.env[n] ?? null) }})); setInterval(() => {{}}, 1000)"
            ),
        )
        .unwrap();
        // Only this test sets these; other tests spawn with a HOME (variables dropped) or ignore them.
        for key in ISOLATED_CONFIG_VARS {
            unsafe { std::env::set_var(key, "/real/config") };
        }
        let home = directory.join("home");
        let backend = Backend::spawn(&directory, Some(&home), Arc::new(|_| {})).unwrap();
        for key in ISOLATED_CONFIG_VARS {
            unsafe { std::env::remove_var(key) };
        }
        let mut seen = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&out) {
                seen = Some(text);
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(backend);
        let seen: Value = serde_json::from_str(&seen.expect("backend wrote its environment")).unwrap();
        assert_eq!(seen["home"], home.to_string_lossy().as_ref());
        assert_eq!(seen["vars"], serde_json::json!([null, null, null, null]));
        std::fs::remove_dir_all(directory).unwrap();
    }
    const IDLE: &str = "process.stdin.resume(); setInterval(() => {}, 1000)";
    #[test]
    fn timeout_disconnects_owner_and_no_request_is_retried() {
        let (backend, directory) = fake_backend(IDLE, Arc::new(|_| {}));
        assert!(backend.request_timeout(Request::Inspect, Duration::from_millis(60)).unwrap_err().contains("timed out"));
        assert!(backend.request(Request::Cancel).unwrap_err().contains("disconnected"));
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn malformed_oversized_output_rejects_pending_requests() {
        for output in ["{broken".to_string(), "x".repeat(MAX_RECORD + 1)] {
            let source = format!("process.stdin.once('data', () => process.stdout.write({} + '\\n')); {IDLE}", serde_json::to_string(&output).unwrap());
            let (backend, directory) = fake_backend(&source, Arc::new(|_| {}));
            let started = Instant::now();
            assert!(backend.request(Request::Inspect).is_err());
            assert!(started.elapsed() < Duration::from_secs(5));
            drop(backend);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }
    #[test]
    fn child_death_rejects_every_pending_request() {
        let (backend, directory) = fake_backend(IDLE, Arc::new(|_| {}));
        let backend = Arc::new(backend);
        let mut requests = Vec::new();
        for _ in 0..3 {
            let backend = backend.clone();
            requests.push(thread::spawn(move || backend.request(Request::Inspect)));
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
    fn run_events_are_forwarded_and_a_v1_event_disconnects() {
        let source = r#"
            import { createInterface } from 'node:readline';
            createInterface({ input: process.stdin }).on('line', (line) => {
                const { id } = JSON.parse(line);
                process.stdout.write(JSON.stringify({ version: 2, id, ok: true, result: { status: 'started', runId: 'r' } }) + '\n');
                process.stdout.write(JSON.stringify({ version: 2, event: 'progress', runId: 'r', progress: { type: 'done', ok: 0, failed: 0 } }) + '\n');
                process.stdout.write(JSON.stringify({ version: 1, event: 'progress', operationId: 'x', state: 'running', percent: 1, detail: '' }) + '\n');
            });
        "#;
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let (backend, directory) = fake_backend(source, Arc::new(move |e| captured.lock().unwrap().push(e)));
        assert_eq!(backend.request(Request::Apply { plan_id: "p".into() }).unwrap()["status"], "started");
        let deadline = Instant::now() + Duration::from_secs(2);
        while events.lock().unwrap().len() < 2 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let events = events.lock().unwrap().clone();
        assert_eq!(events[0]["progress"]["type"], "done");
        assert_eq!(events[1]["event"], "disconnected");
        drop(backend);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
