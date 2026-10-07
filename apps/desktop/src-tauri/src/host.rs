use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
const HELLO_TIMEOUT: Duration = Duration::from_secs(2);
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const HELPER_TIMEOUT: Duration = Duration::from_secs(120);
type Pending = HashMap<String, mpsc::Sender<Result<Value, String>>>;
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Renderer arguments are opaque item keys and plan ids, never paths or commands.
pub enum Request {
    Status,
    Inspect,
    Preview { exclude: Vec<String> },
    Apply { plan_id: String },
    Cancel,
    Hello { token: String },
    Subscribe,
}
impl Request {
    fn command(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Inspect => "inspect",
            Self::Preview { .. } => "preview",
            Self::Apply { .. } => "apply",
            Self::Cancel => "cancel",
            Self::Hello { .. } => "hello",
            Self::Subscribe => "subscribe",
        }
    }
    fn timeout(&self) -> Duration {
        match self {
            Self::Inspect | Self::Apply { .. } => Duration::from_secs(60),
            Self::Cancel => Duration::from_secs(30),
            Self::Hello { .. } => HELLO_TIMEOUT,
            _ => Duration::from_secs(10),
        }
    }
    fn record(&self, id: &str) -> Result<String, String> {
        let mut record = json!({"version": 3, "id": id, "command": self.command()});
        match self {
            Self::Preview { exclude } => {
                if exclude.len() > MAX_EXCLUDED || exclude.iter().any(|key| key.is_empty() || key.encode_utf16().count() > MAX_KEY) {
                    return Err("Invalid item keys".into());
                }
                record["exclude"] = json!(exclude);
            }
            Self::Apply { plan_id } => {
                if !valid_id(plan_id) { return Err("Invalid plan id".into()); }
                record["planId"] = json!(plan_id);
            }
            Self::Hello { token } => {
                if token.is_empty() || token.encode_utf16().count() > 200 { return Err("Invalid agent token".into()); }
                record["token"] = json!(token);
                record["client"] = json!("app");
            }
            _ => {}
        }
        let line = format!("{record}\n");
        if line.len() > MAX_RECORD { return Err("Request exceeds the record limit".into()); }
        Ok(line)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Policy {
    AutoApply,
    Notify,
    Manual,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Paused {
    reason: String,
    at: String,
}
fn validate_paused(value: &Value) -> Result<(), String> {
    if !value.is_null() {
        let p: Paused = serde_json::from_value(value.clone()).map_err(|_| "Invalid paused state")?;
        let _ = (p.reason, p.at);
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HelloResult {
    agent_version: String,
    protocol: u8,
    policy: Policy,
    paused: Value,
}
fn validate_hello(value: &Value) -> Result<(), String> {
    let hello: HelloResult = serde_json::from_value(value.clone()).map_err(|_| "Invalid agent hello")?;
    if hello.protocol != 3 { return Err("Incompatible agent protocol; restart explicitly".into()); }
    validate_paused(&hello.paused)?;
    let _ = (hello.agent_version, hello.policy);
    Ok(())
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
struct StatusEvent {
    version: u8,
    event: String,
    status: WireStatus,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WireStatus {
    at: String,
    policy: Policy,
    paused: Value,
    trusted: bool,
    applying: Option<bool>,
    pending: Vec<PendingItem>,
    drift: Vec<String>,
    conflicts: Vec<String>,
    probe_errors: Vec<String>,
    error: Option<StatusError>,
    detail: Option<String>,
    counts: Counts,
}
#[derive(Deserialize)]
enum StatusError {
    #[serde(rename = "PROFILE_INVALID")]
    ProfileInvalid,
    #[serde(rename = "DECISIONS_INVALID")]
    DecisionsInvalid,
    #[serde(rename = "REVISION_UNAVAILABLE")]
    RevisionUnavailable,
    #[serde(rename = "JOB_FAILED")]
    JobFailed,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PendingItem {
    key: String,
    item_id: String,
    verdict: Verdict,
    reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Inert,
    Held,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Counts {
    pending: u64,
    held: u64,
    ready: u64,
    drift: u64,
}
fn validate_status(value: &Value) -> Result<(), String> {
    let s: WireStatus = serde_json::from_value(value.clone()).map_err(|_| "Invalid agent status")?;
    validate_paused(&s.paused)?;
    // Optional wire fields may be absent, but cannot be null.
    for field in ["applying", "error", "detail"] {
        if value.get(field).is_some_and(Value::is_null) { return Err("Invalid agent status".into()); }
    }
    for item in value["pending"].as_array().ok_or("Invalid agent status")? {
        if item.get("reason").is_some_and(Value::is_null) { return Err("Invalid agent status".into()); }
    }
    let _ = (s.at, s.policy, s.trusted, s.applying, s.drift, s.conflicts, s.probe_errors, s.error, s.detail);
    let _ = (s.counts.pending, s.counts.held, s.counts.ready, s.counts.drift);
    for item in s.pending { let _ = (item.key, item.item_id, item.verdict, item.reason); }
    Ok(())
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
fn valid_id(value: &str) -> bool { !value.is_empty() && value.encode_utf16().count() <= 100 }
fn validate(message: &Value) -> Result<(), String> {
    if message.get("event").is_some() {
        if message["event"] == "status" {
            let m: StatusEvent = serde_json::from_value(message.clone()).map_err(|_| "Invalid status event")?;
            if m.version != 3 || m.event != "status" { return Err("Invalid status event contract".into()); }
            let _ = m.status;
            validate_status(&message["status"])?;
        } else {
            let m: RunEvent = serde_json::from_value(message.clone()).map_err(|_| "Invalid run event")?;
            let kind = m.progress.get("type").and_then(Value::as_str).unwrap_or("");
            if m.version != 3 || m.event != "progress" || !valid_id(&m.run_id) || !["started", "finished", "done", "cancelled", "failed"].contains(&kind) { return Err("Invalid run event contract".into()); }
        }
    } else if message.get("ok") == Some(&Value::Bool(true)) {
        let m: Success = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 3 || !m.ok || !valid_id(&m.id) { return Err("Invalid success response".into()); }
        let _ = m.result;
    } else {
        let m: Failure = serde_json::from_value(message.clone()).map_err(|_| "Invalid response")?;
        if m.version != 3 || m.ok || !valid_id(&m.id) || !valid_id(&m.error.code) || m.error.message.encode_utf16().count() > 500 { return Err("Invalid failure response".into()); }
    }
    Ok(())
}
fn bounded_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut result = Vec::new();
    loop {
        let part = reader.fill_buf().map_err(|e| e.to_string())?;
        if part.is_empty() { return if result.is_empty() { Ok(None) } else { Err("Truncated agent record".into()) }; }
        let end = part.iter().position(|byte| *byte == b'\n');
        let count = end.unwrap_or(part.len());
        if result.len() + count + 1 > MAX_RECORD { return Err("Oversized agent record".into()); }
        result.extend_from_slice(&part[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() { return Ok(Some(result)); }
    }
}
struct Inner {
    socket: Mutex<Option<UnixStream>>,
    control: UnixStream,
    pending: Mutex<Pending>,
    alive: AtomicBool,
    next_id: AtomicU64,
    emit: Emit,
}
impl Inner {
    fn disconnect(&self, reason: &str) {
        if self.alive.swap(false, Ordering::SeqCst) {
            // This handle interrupts a blocked writer before taking its mutex.
            let _ = self.control.shutdown(Shutdown::Both);
            self.socket.lock().unwrap().take();
            for (_, sender) in self.pending.lock().unwrap().drain() {
                let _ = sender.send(Err(reason.into()));
            }
            (self.emit)(json!({"event":"disconnected", "detail":reason}));
        }
    }
}
/// Owns a client connection only. Closing it leaves the login service running.
pub struct Agent {
    inner: Arc<Inner>,
    pub hello: Value,
}
impl Agent {
    pub fn connect(state_root: &Path, emit: Emit) -> Result<Self, String> {
        Self::connect_timeout(state_root, emit, HELLO_TIMEOUT)
    }
    fn connect_timeout(state_root: &Path, emit: Emit, hello_timeout: Duration) -> Result<Self, String> {
        Self::connect_deadline(state_root, emit, hello_timeout, None)
    }
    fn connect_deadline(state_root: &Path, emit: Emit, hello_timeout: Duration, deadline: Option<Instant>) -> Result<Self, String> {
        let remaining = |limit: Duration| deadline.map_or(limit, |end| limit.min(end.saturating_duration_since(Instant::now())));
        let directory = state_root.join("agent");
        let token = std::fs::read_to_string(directory.join("agent.token")).map_err(|e| format!("UNREACHABLE: Agent token: {e}"))?;
        let token = token.trim().to_string();
        let socket = UnixStream::connect(directory.join("agent.sock")).map_err(|e| format!("UNREACHABLE: Agent socket: {e}"))?;
        let reader = socket.try_clone().map_err(|e| e.to_string())?;
        let control = socket.try_clone().map_err(|e| e.to_string())?;
        let inner = Arc::new(Inner {
            control,
            socket: Mutex::new(Some(socket)),
            pending: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            next_id: AtomicU64::new(1),
            emit,
        });
        let read = inner.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let result = (|| -> Result<(), String> {
                while let Some(line) = bounded_line(&mut reader)? {
                    let value: Value = serde_json::from_slice(&line).map_err(|_| "Malformed agent JSON")?;
                    validate(&value)?;
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        if let Some(sender) = read.pending.lock().unwrap().remove(id) {
                            let result = if value["ok"] == true {
                                Ok(value["result"].clone())
                            } else {
                                Err(format!(
                                    "{}: {}",
                                    value["error"]["code"].as_str().unwrap(),
                                    value["error"]["message"].as_str().unwrap(),
                                ))
                            };
                            let _ = sender.send(result);
                        }
                    } else {
                        (read.emit)(value);
                    }
                }
                Err("Agent disconnected; restart explicitly".into())
            })();
            read.disconnect(&result.unwrap_err());
        });
        let mut agent = Self { inner, hello: Value::Null };
        let hello = agent.request_timeout(Request::Hello { token }, remaining(hello_timeout))?;
        validate_hello(&hello)?;
        agent.hello = hello;
        agent.request_timeout(Request::Subscribe, remaining(Request::Subscribe.timeout()))?;
        Ok(agent)
    }
    pub fn connect_ready(state_root: &Path, emit: Emit) -> Result<Self, String> {
        Self::connect_ready_timeout(state_root, emit, READY_TIMEOUT)
    }
    fn connect_ready_timeout(state_root: &Path, emit: Emit, timeout: Duration) -> Result<Self, String> {
        let deadline = Instant::now() + timeout;
        loop {
            match Self::connect_deadline(state_root, emit.clone(), HELLO_TIMEOUT, Some(deadline)) {
                Ok(agent) => return Ok(agent),
                Err(error) if error.starts_with("UNREACHABLE:") => {
                    if Instant::now() >= deadline { return Err(error); }
                    thread::sleep(Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())));
                }
                Err(error) => return Err(error),
            }
        }
    }
    pub fn request(&self, request: Request) -> Result<Value, String> {
        let timeout = request.timeout();
        self.request_timeout(request, timeout)
    }
    fn request_timeout(&self, request: Request, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        let is_status = matches!(request, Request::Status);
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst).to_string();
        let record = request.record(&id)?;
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self.inner.pending.lock().unwrap();
            if !self.inner.alive.load(Ordering::SeqCst) { return Err("Agent disconnected; restart explicitly".into()); }
            pending.insert(id.clone(), sender);
        }
        let timed_out = Arc::new(AtomicBool::new(false));
        let expired = timed_out.clone();
        let watch = self.inner.clone();
        // Dropping this sender cancels the watchdog on every success, refusal and early error.
        let (_cancel_deadline, wait_deadline) = mpsc::channel::<()>();
        thread::spawn(move || {
            if matches!(
                wait_deadline.recv_timeout(deadline.saturating_duration_since(Instant::now())),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                expired.store(true, Ordering::SeqCst);
                watch.disconnect("Agent request timed out; restart explicitly");
            }
        });
        let written = (|| -> Result<(), String> {
            let mut socket = loop {
                if let Ok(socket) = self.inner.socket.try_lock() { break socket; }
                if Instant::now() >= deadline { return Err("Agent request timed out".into()); }
                thread::sleep(Duration::from_millis(1));
            };
            let socket = socket.as_mut().ok_or("Agent disconnected; restart explicitly")?;
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err("Agent request timed out".into()); }
            socket.set_write_timeout(Some(remaining)).map_err(|e| e.to_string())?;
            socket.write_all(record.as_bytes()).map_err(|_| "Agent write failed".into())
        })();
        if let Err(error) = written {
            let error = if timed_out.load(Ordering::SeqCst) || Instant::now() >= deadline {
                "Agent request timed out; restart explicitly".into()
            } else {
                error
            };
            self.inner.disconnect(&error);
            self.inner.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => {
                if timed_out.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    self.inner.disconnect("Agent request timed out; restart explicitly");
                    return Err("Agent request timed out; restart explicitly".into());
                }
                let result = result?;
                if is_status {
                    if let Err(error) = validate_status(&result) {
                        let error = format!("MALFORMED: {error}; restart explicitly");
                        self.inner.disconnect(&error);
                        return Err(error);
                    }
                }
                Ok(result)
            }
            Err(_) => {
                self.inner.disconnect("Agent request timed out; restart explicitly");
                Err("Agent request timed out; restart explicitly".into())
            }
        }
    }
    pub fn is_connected(&self) -> bool {
        self.inner.alive.load(Ordering::SeqCst)
    }
    pub fn disconnect(&self) {
        self.inner.disconnect("Agent connection closed");
    }
}
impl Drop for Agent {
    fn drop(&mut self) {
        self.disconnect();
    }
}

#[derive(Clone, Copy)]
pub enum Setup {
    Ensure,
    Restart,
}
impl Setup {
    fn argument(self) -> &'static str {
        match self {
            Self::Ensure => "--ensure",
            Self::Restart => "--restart",
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetupResult {
    state_root: PathBuf,
}
const ISOLATED_CONFIG_VARS: [&str; 4] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "ZDOTDIR"];
fn helper_command(resources: &Path, setup: Setup, home: Option<&Path>) -> Result<Command, String> {
    let bun = resources.join("bun");
    let script = resources.join("agent.mjs");
    if !resources.is_absolute() || !bun.is_file() || !script.is_file() { return Err(format!("Missing bundled agent at {}", resources.display())); }
    let mut command = Command::new(bun);
    command.arg(script).arg(setup.argument()).current_dir(resources)
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH").env_remove("BUN_OPTIONS")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(home) = home {
        command.env("HOME", home);
        for key in ISOLATED_CONFIG_VARS { command.env_remove(key); }
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("NORTUSCC_") { command.env_remove(key); }
        }
    }
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    Ok(command)
}
pub fn setup_agent(resources: &Path, setup: Setup) -> Result<PathBuf, String> {
    run_helper(helper_command(resources, setup, None)?, HELPER_TIMEOUT)
}
fn run_helper(mut command: Command, timeout: Duration) -> Result<PathBuf, String> {
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (send, receive) = mpsc::channel();
    thread::spawn(move || {
        let result = (|| -> Result<PathBuf, String> {
            let mut reader = BufReader::new(stdout);
            let line = bounded_line(&mut reader)?.ok_or("Missing setup result")?;
            let result: SetupResult = serde_json::from_slice(&line).map_err(|_| "Invalid setup result")?;
            if !result.state_root.is_absolute() { return Err("Invalid setup stateRoot".into()); }
            if bounded_line(&mut reader)?.is_some() { return Err("Unexpected setup output".into()); }
            Ok(result.state_root)
        })();
        let _ = send.send(result);
    });
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(line)) = bounded_line(&mut reader) { eprintln!("agent setup: {}", String::from_utf8_lossy(&line)); }
    });
    let deadline = Instant::now() + timeout;
    let result = (|| -> Result<PathBuf, String> {
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
            if Instant::now() >= deadline { return Err("Agent setup timed out".into()); }
            thread::sleep(Duration::from_millis(10));
        };
        if !status.success() { return Err(format!("Agent setup failed: {status}")); }
        receive.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| "Agent setup output timed out")?
    })();
    if result.is_err() {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v3_replies_and_status_events_are_accepted() {
        assert!(validate(&json!({"version":3,"id":"1","ok":true,"result":null})).is_ok());
        assert!(validate(&json!({"version":3,"event":"status","status":{"at":"now","policy":"manual","paused":null,"trusted":true,"applying":false,"pending":[],"drift":[],"conflicts":[],"probeErrors":[],"counts":{"pending":0,"held":0,"ready":0,"drift":0}}})).is_ok());
    }
    #[test]
    fn record_limit_includes_the_delimiter() {
        let mut exact = vec![b'x'; MAX_RECORD - 1];
        exact.push(b'\n');
        assert_eq!(bounded_line(&mut BufReader::new(std::io::Cursor::new(exact))).unwrap().unwrap().len(), MAX_RECORD - 1);
        let mut too_big = vec![b'x'; MAX_RECORD];
        too_big.push(b'\n');
        assert!(bounded_line(&mut BufReader::new(std::io::Cursor::new(too_big))).is_err());
    }
    #[test]
    fn renderer_requests_use_v3() {
        assert_eq!(serde_json::from_str::<Value>(&Request::Inspect.record("1").unwrap()).unwrap()["version"], 3);
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use std::os::unix::net::UnixListener;
    pub(crate) struct Fixture { pub root: PathBuf, worker: Option<thread::JoinHandle<()>> }
    pub(crate) fn scratch() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = PathBuf::from(format!("/tmp/ncc-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::canonicalize(root).unwrap()
    }
    pub(crate) struct Wire { reader: BufReader<UnixStream>, writer: UnixStream }
    impl Wire {
        pub fn new(socket: UnixStream) -> Self {
            socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            Self { reader: BufReader::new(socket.try_clone().unwrap()), writer: socket }
        }
        pub fn next(&mut self) -> Option<Value> { bounded_line(&mut self.reader).unwrap().map(|line| serde_json::from_slice(&line).unwrap()) }
        pub fn read_bytes(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> { std::io::Read::read(&mut self.reader, buffer) }
        pub fn discard_until_close(&mut self) { let mut bytes = Vec::new(); let _ = std::io::Read::read_to_end(&mut self.reader, &mut bytes); }
        pub fn raw(&mut self, bytes: &[u8]) { self.writer.write_all(bytes).unwrap(); }
        pub fn send(&mut self, value: Value) { self.raw(format!("{value}\n").as_bytes()); }
        pub fn reply(&mut self, request: &Value, result: Value) { self.send(json!({"version":3,"id":request["id"],"ok":true,"result":result})); }
        pub fn error(&mut self, request: &Value, code: &str) { self.send(json!({"version":3,"id":request["id"],"ok":false,"error":{"code":code,"message":"refused"}})); }
        pub fn handshake(&mut self) {
            let hello = self.next().unwrap();
            assert_eq!(hello["version"], 3);
            assert_eq!(hello["command"], "hello");
            assert_eq!(hello["token"], "token-a");
            assert_eq!(hello["client"], "app");
            assert_eq!(hello.as_object().unwrap().len(), 5);
            self.reply(&hello, hello_result());
            let subscribe = self.next().unwrap();
            assert_eq!(subscribe["command"], "subscribe");
            self.reply(&subscribe, json!({"subscribed":true}));
        }
    }
    pub(crate) fn hello_result() -> Value { json!({"agentVersion":"fake-v1","protocol":3,"policy":"manual","paused":null}) }
    pub(crate) fn status() -> Value { json!({"at":"now","policy":"manual","paused":null,"trusted":true,"applying":false,"pending":[],"drift":[],"conflicts":[],"probeErrors":[],"counts":{"pending":0,"held":0,"ready":0,"drift":0}}) }
    impl Fixture {
        pub fn new(handle: impl FnOnce(Wire) + Send + 'static) -> Self {
            let root = scratch();
            let agent = root.join("agent");
            std::fs::create_dir(&agent).unwrap();
            std::fs::write(agent.join("agent.token"), "token-a\n").unwrap();
            let listener = UnixListener::bind(agent.join("agent.sock")).unwrap();
            let worker = thread::spawn(move || { let (socket, _) = listener.accept().unwrap(); handle(Wire::new(socket)); });
            Self { root, worker: Some(worker) }
        }
        pub fn connect(&self, emit: Emit) -> Agent { Agent::connect(&self.root, emit).unwrap() }
        pub fn finish(mut self) { self.worker.take().unwrap().join().unwrap(); }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }
    pub(crate) fn idle_agent() -> (Agent, Fixture) {
        let fixture = Fixture::new(|mut wire| {
            wire.handshake();
            while let Some(request) = wire.next() { assert_ne!(request["command"], "shutdown"); wire.reply(&request, json!({"command":request["command"]})); }
        });
        let agent = fixture.connect(Arc::new(|_| {}));
        (agent, fixture)
    }
}

#[cfg(test)]
mod socket_tests {
    use super::*;
    use std::os::fd::AsRawFd;
    use super::fixtures::*;
    #[test]
    fn hello_is_strict_and_requires_all_fields() {
        for value in [
            json!({"agentVersion":"v","protocol":2,"policy":"manual","paused":null}),
            json!({"agentVersion":"v","protocol":3,"policy":"manual","paused":null,"extra":true}),
            json!({"agentVersion":"v","protocol":3,"policy":"manual"}),
            json!({"agentVersion":"v","protocol":3,"policy":"invalid","paused":null}),
            json!({"agentVersion":"v","protocol":3,"policy":"manual","paused":{"reason":"x","at":"now","extra":1}}),
        ] { assert!(validate_hello(&value).is_err(), "{value}"); }
        assert!(validate_hello(&hello_result()).is_ok());
    }
    #[test]
    fn unknown_fields_and_invalid_status_disconnect_contract() {
        for value in [
            json!({"version":2,"id":"x","ok":true,"result":null}),
            json!({"version":3,"id":"😀".repeat(60),"ok":true,"result":null}),
            json!({"version":3,"id":"x","ok":true,"result":null,"extra":true}),
            json!({"version":3,"id":"x","ok":false,"error":{"code":"PAUSED","message":"refused","extra":true}}),
            json!({"version":3,"event":"progress","runId":"r","progress":{"type":"exploded"}}),
            json!({"version":3,"event":"progress","runId":"r","progress":{"type":"done"},"extra":true}),
            json!({"version":3,"event":"status","status":status(),"extra":true}),
            json!({"version":3,"event":"status","status":{"at":"now"}}),
        ] { assert!(validate(&value).is_err(), "{value}"); }
        let mut extra = status(); extra["extra"] = json!(true);
        assert!(validate_status(&extra).is_err());
        let mut null = status(); null["applying"] = Value::Null;
        assert!(validate_status(&null).is_err());
    }
    #[test]
    fn keys_and_plan_ids_are_bounded_and_requests_cannot_supply_paths() {
        let line = Request::Preview { exclude: vec!["config:a".into()] }.record("7").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), json!({"version":3,"id":"7","command":"preview","exclude":["config:a"]}));
        assert_eq!(serde_json::from_str::<Value>(&Request::Status.record("8").unwrap()).unwrap(), json!({"version":3,"id":"8","command":"status"}));
        assert!(Request::Preview { exclude: vec!["k".into(); MAX_EXCLUDED + 1] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec!["😀".repeat(251)] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec![String::new()] }.record("1").is_err());
        assert!(Request::Preview { exclude: vec!["x".repeat(500); MAX_EXCLUDED] }.record("1").is_err());
        assert!(Request::Apply { plan_id: String::new() }.record("1").is_err());
        assert!(Request::Apply { plan_id: "x".repeat(101) }.record("1").is_err());
    }
    #[test]
    fn connects_as_app_subscribes_and_disconnects_without_shutdown() {
        let (agent, fixture) = idle_agent();
        assert_eq!(agent.hello, hello_result());
        assert_eq!(agent.request(Request::Inspect).unwrap()["command"], "inspect");
        drop(agent);
        fixture.finish();
    }
    #[test]
    fn every_connection_reads_the_fresh_token() {
        let root = scratch(); let dir = root.join("agent"); std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("agent.token"), "first").unwrap();
        let listener = std::os::unix::net::UnixListener::bind(dir.join("agent.sock")).unwrap();
        let worker = thread::spawn(move || {
            for token in ["first", "second"] {
                let (socket, _) = listener.accept().unwrap(); let mut wire = Wire::new(socket);
                let hello = wire.next().unwrap(); assert_eq!(hello["token"], token); assert_eq!(hello["client"], "app"); wire.reply(&hello, hello_result());
                let subscribe = wire.next().unwrap(); wire.reply(&subscribe, json!({"subscribed":true}));
                assert!(wire.next().is_none());
            }
        });
        drop(Agent::connect(&root, Arc::new(|_| {})).unwrap());
        std::fs::write(dir.join("agent.token"), "second").unwrap();
        drop(Agent::connect(&root, Arc::new(|_| {})).unwrap());
        worker.join().unwrap(); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn wrong_token_and_incompatible_hello_fail_closed_without_retry() {
        for incompatible in [false, true] {
            let fixture = Fixture::new(move |mut wire| {
                let hello = wire.next().unwrap();
                if incompatible { let mut result = hello_result(); result["protocol"] = json!(2); wire.reply(&hello, result); }
                else { wire.error(&hello, "UNAUTHORIZED"); }
                assert!(wire.next().is_none());
            });
            let error = Agent::connect_ready_timeout(&fixture.root, Arc::new(|_| {}), Duration::from_millis(100)).err().unwrap();
            assert!(error.contains(if incompatible {"Incompatible"} else {"UNAUTHORIZED:"}), "{error}");
            fixture.finish();
        }
    }
    #[test]
    fn status_progress_and_application_errors_are_forwarded() {
        let fixture = Fixture::new(|mut wire| {
            wire.handshake();
            let status_request = wire.next().unwrap(); assert_eq!(status_request["command"], "status"); wire.error(&status_request, "NO_REPORT");
            wire.send(json!({"version":3,"event":"status","status":status()}));
            let apply = wire.next().unwrap(); wire.error(&apply, "PAUSED");
            let apply = wire.next().unwrap(); wire.reply(&apply, json!({"status":"started","runId":"r"}));
            wire.send(json!({"version":3,"event":"progress","runId":"r","progress":{"type":"done","ok":0,"failed":0}}));
            let status_request = wire.next().unwrap(); wire.reply(&status_request, status());
            assert!(wire.next().is_none());
        });
        let events = Arc::new(Mutex::new(Vec::new())); let capture = events.clone();
        let agent = fixture.connect(Arc::new(move |event| capture.lock().unwrap().push(event)));
        assert_eq!(agent.request(Request::Status).unwrap_err(), "NO_REPORT: refused");
        assert_eq!(agent.request(Request::Apply { plan_id:"p".into() }).unwrap_err(), "PAUSED: refused");
        assert_eq!(agent.request(Request::Apply { plan_id:"p".into() }).unwrap()["runId"], "r");
        assert_eq!(agent.request(Request::Status).unwrap()["applying"], false);
        let events = events.lock().unwrap(); assert_eq!(events[0]["event"], "status"); assert_eq!(events[1]["progress"]["type"], "done"); drop(events);
        drop(agent); fixture.finish();
    }
    #[test]
    fn disconnect_rejects_all_pending_requests_and_never_retries() {
        let (received, all) = mpsc::channel();
        let fixture = Fixture::new(move |mut wire| {
            wire.handshake();
            for _ in 0..3 { assert_eq!(wire.next().unwrap()["command"], "inspect"); }
            received.send(()).unwrap();
            assert!(wire.next().is_none());
        });
        let agent = Arc::new(fixture.connect(Arc::new(|_| {})));
        let jobs: Vec<_> = (0..3).map(|_| { let agent = agent.clone(); thread::spawn(move || agent.request(Request::Inspect)) }).collect();
        all.recv_timeout(Duration::from_secs(2)).unwrap();
        agent.disconnect();
        for job in jobs { assert!(job.join().unwrap().unwrap_err().contains("closed")); }
        assert!(agent.request(Request::Cancel).unwrap_err().contains("disconnected"));
        drop(agent); fixture.finish();
    }
    #[test]
    fn disconnect_interrupts_a_writer_blocked_by_backpressure() {
        use std::os::fd::AsRawFd;
        let (release, held) = mpsc::channel();
        let fixture = Fixture::new(move |mut wire| {
            wire.handshake(); held.recv().unwrap();
            wire.discard_until_close();
        });
        let agent = Arc::new(fixture.connect(Arc::new(|_| {})));
        let socket = agent.inner.socket.lock().unwrap();
        let size: libc::c_int = 1024;
        assert_eq!(unsafe { libc::setsockopt(socket.as_ref().unwrap().as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, (&size as *const libc::c_int).cast(), std::mem::size_of_val(&size) as libc::socklen_t) }, 0);
        drop(socket);
        let writing = agent.clone();
        let writer = thread::spawn(move || writing.request(Request::Preview { exclude: vec!["x".repeat(50); MAX_EXCLUDED] }));
        let deadline = Instant::now() + Duration::from_secs(2);
        while agent.inner.socket.try_lock().is_ok() { assert!(Instant::now() < deadline); thread::sleep(Duration::from_millis(1)); }
        let (closed, finished) = mpsc::channel(); let closing = agent.clone();
        let closer = thread::spawn(move || { closing.disconnect(); closed.send(()).unwrap(); });
        let timely = finished.recv_timeout(Duration::from_millis(100)).is_ok();
        release.send(()).unwrap(); closer.join().unwrap();
        assert!(writer.join().unwrap().is_err());
        drop(agent); fixture.finish();
        assert!(timely, "Closing the app must interrupt a blocked socket writer");
    }
    #[test]
    fn slow_drain_cannot_extend_request_write_deadline() {
        use std::os::fd::AsRawFd;
        let fixture = Fixture::new(|mut wire| {
            wire.handshake();
            let mut buffer = [0u8; 1024];
            loop {
                thread::sleep(Duration::from_millis(20));
                match wire.read_bytes(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {},
                    Err(error) => panic!("Slow reader failed: {error}"),
                }
            }
        });
        let agent = fixture.connect(Arc::new(|_| {}));
        let socket = agent.inner.socket.lock().unwrap();
        let size: libc::c_int = 1024;
        assert_eq!(unsafe { libc::setsockopt(socket.as_ref().unwrap().as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, (&size as *const libc::c_int).cast(), std::mem::size_of_val(&size) as libc::socklen_t) }, 0);
        drop(socket);
        let start = Instant::now();
        let result = agent.request_timeout(Request::Preview { exclude: vec!["x".repeat(500); 128] }, Duration::from_millis(100));
        let elapsed = start.elapsed();
        let disconnected = !agent.is_connected();
        let pending_empty = agent.inner.pending.lock().unwrap().is_empty();
        let future = agent.request(Request::Cancel);
        drop(agent); fixture.finish();
        assert!(result.as_ref().err().is_some_and(|error| error.contains("timed out")), "An unfinished request must time out: {result:?}");
        assert!(pending_empty, "Timed-out writes must reject and clear pending requests");
        assert!(future.is_err(), "Disconnected requests must never be replayed");
        assert!(disconnected, "A timed-out request must close the connection");
        assert!(elapsed < Duration::from_millis(500), "Slow drain extended a 100ms deadline to {elapsed:?}");
    }
    #[test]
    fn queued_request_deadline_includes_waiting_for_the_writer() {
        let (release, held) = mpsc::channel();
        let fixture = Fixture::new(move |mut wire| {
            wire.handshake(); held.recv().unwrap(); wire.discard_until_close();
        });
        let agent = Arc::new(fixture.connect(Arc::new(|_| {})));
        let socket = agent.inner.socket.lock().unwrap();
        let size: libc::c_int = 1024;
        assert_eq!(unsafe { libc::setsockopt(socket.as_ref().unwrap().as_raw_fd(), libc::SOL_SOCKET, libc::SO_SNDBUF, (&size as *const libc::c_int).cast(), std::mem::size_of_val(&size) as libc::socklen_t) }, 0);
        drop(socket);
        let writing = agent.clone();
        let writer = thread::spawn(move || writing.request(Request::Preview { exclude: vec!["x".repeat(500); 128] }));
        let deadline = Instant::now() + Duration::from_secs(2);
        while agent.inner.socket.try_lock().is_ok() { assert!(Instant::now() < deadline); thread::sleep(Duration::from_millis(1)); }
        let start = Instant::now();
        let result = agent.request_timeout(Request::Inspect, Duration::from_millis(60));
        let elapsed = start.elapsed();
        release.send(()).unwrap(); assert!(writer.join().unwrap().is_err());
        let pending_empty = agent.inner.pending.lock().unwrap().is_empty();
        let disconnected = !agent.is_connected();
        drop(agent); fixture.finish();
        assert!(result.as_ref().err().is_some_and(|error| error.contains("timed out")));
        assert!(elapsed < Duration::from_millis(500), "Writer wait extended a 60ms deadline to {elapsed:?}");
        assert!(pending_empty && disconnected);
    }
    #[test]
    fn completed_and_refused_requests_cancel_their_deadline_watchdog() {
        for refused in [false, true] {
            let fixture = Fixture::new(|mut wire| {
                wire.handshake();
                while let Some(request) = wire.next() {
                    if request["command"] == "apply" { wire.error(&request, "PAUSED"); }
                    else { wire.reply(&request, json!({"command":request["command"]})); }
                }
            });
            let agent = fixture.connect(Arc::new(|_| {}));
            let request = if refused { Request::Apply { plan_id: "p".into() } } else { Request::Inspect };
            let result = agent.request_timeout(request, Duration::from_millis(100));
            if refused { assert_eq!(result.unwrap_err(), "PAUSED: refused"); }
            else { assert_eq!(result.unwrap()["command"], "inspect"); }
            assert!(agent.request(Request::Preview { exclude: vec![String::new()] }).is_err());
            thread::sleep(Duration::from_millis(150));
            assert!(agent.is_connected(), "A cancelled watchdog must leave the connection live");
            assert_eq!(agent.request(Request::Inspect).unwrap()["command"], "inspect");
            drop(agent); fixture.finish();
        }
    }
    #[test]
    fn command_timeout_closes_socket_and_rejects_future_requests() {
        let fixture = Fixture::new(|mut wire| { wire.handshake(); assert_eq!(wire.next().unwrap()["command"], "inspect"); assert!(wire.next().is_none()); });
        let agent = fixture.connect(Arc::new(|_| {}));
        assert!(agent.request_timeout(Request::Inspect, Duration::from_millis(40)).unwrap_err().contains("timed out"));
        assert!(agent.request(Request::Cancel).unwrap_err().contains("disconnected"));
        drop(agent); fixture.finish();
    }
    #[test]
    fn malformed_oversized_and_unknown_field_output_reject_pending_requests() {
        for bytes in [b"{broken\n".to_vec(), vec![b'x'; MAX_RECORD], b"{\"version\":3,\"event\":\"status\",\"status\":{},\"extra\":true}\n".to_vec()] {
            let fixture = Fixture::new(move |mut wire| { wire.handshake(); wire.next().unwrap(); wire.raw(&bytes); });
            let agent = fixture.connect(Arc::new(|_| {}));
            let start = Instant::now(); assert!(agent.request(Request::Inspect).is_err()); assert!(start.elapsed() < Duration::from_secs(1));
            drop(agent); fixture.finish();
        }
    }
    #[test]
    fn invalid_status_reply_disconnects_fail_closed() {
        let fixture = Fixture::new(|mut wire| {
            wire.handshake(); let request = wire.next().unwrap();
            wire.reply(&request, json!({"at":"now"}));
            wire.discard_until_close();
        });
        let agent = fixture.connect(Arc::new(|_| {}));
        let result = agent.request(Request::Status);
        let rejected = result.as_ref().err().is_some_and(|error| error.starts_with("MALFORMED:"));
        let disconnected = !agent.is_connected();
        agent.disconnect(); fixture.finish();
        assert!(rejected, "Invalid status must be reported as a protocol refusal: {result:?}");
        assert!(disconnected, "Invalid status must close the connection");
    }
    #[test]
    fn peer_exit_rejects_pending_requests() {
        let fixture = Fixture::new(|mut wire| { wire.handshake(); wire.next().unwrap(); });
        let agent = fixture.connect(Arc::new(|_| {}));
        assert!(agent.request(Request::Inspect).unwrap_err().contains("disconnected"));
        drop(agent); fixture.finish();
    }
    #[test]
    fn readiness_waits_for_a_delayed_token_and_socket_boundedly() {
        let root = scratch(); let dir = root.join("agent"); std::fs::create_dir(&dir).unwrap(); let delayed = dir.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            std::fs::write(delayed.join("agent.token"), "token-a").unwrap();
            let listener = std::os::unix::net::UnixListener::bind(delayed.join("agent.sock")).unwrap();
            let (socket, _) = listener.accept().unwrap(); let mut wire = Wire::new(socket); wire.handshake(); assert!(wire.next().is_none());
        });
        drop(Agent::connect_ready_timeout(&root, Arc::new(|_| {}), Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        let start = Instant::now(); assert!(Agent::connect_ready_timeout(&root, Arc::new(|_| {}), Duration::from_millis(70)).is_err()); assert!(start.elapsed() < Duration::from_millis(250));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn readiness_deadline_also_bounds_subscribe() {
        let fixture = Fixture::new(|mut wire| {
            let hello = wire.next().unwrap(); wire.reply(&hello, hello_result());
            assert_eq!(wire.next().unwrap()["command"], "subscribe");
            wire.discard_until_close();
        });
        let start = Instant::now();
        assert!(Agent::connect_ready_timeout(&fixture.root, Arc::new(|_| {}), Duration::from_millis(80)).is_err());
        let bounded = start.elapsed() < Duration::from_millis(500);
        fixture.finish();
        assert!(bounded, "Readiness must bound the entire handshake, including subscribe");
    }
    #[test]
    fn hello_wait_is_bounded() {
        let fixture = Fixture::new(|mut wire| { wire.next().unwrap(); assert!(wire.next().is_none()); });
        let start = Instant::now();
        assert!(Agent::connect_timeout(&fixture.root, Arc::new(|_| {}), Duration::from_millis(40)).err().unwrap().contains("timed out"));
        assert!(start.elapsed() < Duration::from_millis(250)); fixture.finish();
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;
    use super::fixtures::scratch;
    use std::os::unix::fs::PermissionsExt;
    fn resources(source: &str) -> PathBuf {
        let root = scratch();
        std::fs::write(root.join("agent.mjs"), "unused fake helper entry").unwrap();
        std::fs::write(root.join("bun"), format!("#!/bin/sh\n{source}\n")).unwrap();
        std::fs::set_permissions(root.join("bun"), std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }
    #[test]
    fn fixed_helper_arguments_and_strict_output_determine_the_state_root() {
        let root = resources(r#"[ "$1" = "$PWD/agent.mjs" ] || exit 9
case "$2" in --ensure|--restart) ;; *) exit 8;; esac
[ "$#" = 2 ] || exit 7
printf '%s\n' '{"stateRoot":"/tmp/fake-state"}'"#);
        for mode in [Setup::Ensure, Setup::Restart] {
            assert_eq!(run_helper(helper_command(&root, mode, None).unwrap(), Duration::from_secs(1)).unwrap(), PathBuf::from("/tmp/fake-state"));
        }
        std::fs::remove_dir_all(root).unwrap();
        for output in ["{}", "{\"stateRoot\":\"relative\"}", "{\"stateRoot\":\"/tmp/x\",\"extra\":true}", "not-json", "{\"stateRoot\":\"/tmp/x\"}\n{}"] {
            let root = resources(&format!("printf '%s\\n' '{output}'"));
            assert!(run_helper(helper_command(&root, Setup::Ensure, None).unwrap(), Duration::from_secs(1)).is_err(), "{output}");
            std::fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn nonzero_helper_and_timeout_leave_no_running_child() {
        let root = resources("exit 3");
        assert!(run_helper(helper_command(&root, Setup::Ensure, None).unwrap(), Duration::from_secs(1)).unwrap_err().contains("failed"));
        std::fs::remove_dir_all(root).unwrap();
        let root = resources("printf '%s' \"$$\" > pid\nexec /bin/sleep 30");
        let start = Instant::now();
        assert!(run_helper(helper_command(&root, Setup::Ensure, None).unwrap(), Duration::from_millis(500)).unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let pid = std::fs::read_to_string(root.join("pid")).unwrap().parse::<i32>().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn isolated_helper_removes_config_and_runtime_overrides() {
        let root = resources(r#"[ "$HOME" = "$PWD/home" ] || exit 2
[ "${NORTUSCC_RUST_FAKE-unset}" = unset ] || exit 3
printf '%s\n' '{"stateRoot":"/tmp/fake-state"}'"#);
        let home = root.join("home"); std::fs::create_dir(&home).unwrap();
        let previous = std::env::var_os("NORTUSCC_RUST_FAKE");
        std::env::set_var("NORTUSCC_RUST_FAKE", "/owner/override");
        let command = helper_command(&root, Setup::Ensure, Some(&home)).unwrap();
        if let Some(previous) = previous { std::env::set_var("NORTUSCC_RUST_FAKE", previous); } else { std::env::remove_var("NORTUSCC_RUST_FAKE"); }
        let env: HashMap<_, _> = command.get_envs().collect();
        for key in ISOLATED_CONFIG_VARS.into_iter().chain(["NORTUSCC_RUST_FAKE", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"]) {
            assert_eq!(env.get(std::ffi::OsStr::new(key)), Some(&None));
        }
        assert!(run_helper(command, Duration::from_secs(1)).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inherited_stdout_from_a_descendant_is_also_bounded() {
        let root = resources("/bin/sleep 30 &\nprintf '%s\\n' '{\"stateRoot\":\"/tmp/fake-state\"}'");
        let start = Instant::now();
        assert!(run_helper(helper_command(&root, Setup::Ensure, None).unwrap(), Duration::from_millis(500)).unwrap_err().contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(1));
        std::fs::remove_dir_all(root).unwrap();
    }
}
