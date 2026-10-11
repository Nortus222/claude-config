use serde::{Deserialize, Serialize};
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
const BOOTSTRAP_CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
type Pending = HashMap<String, mpsc::Sender<Result<Value, String>>>;
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

/// Renderer arguments are public metadata, enums and opaque IDs, never paths or commands.
pub enum Request {
    Status,
    Inspect,
    Preview { exclude: Vec<String> },
    Apply { plan_id: String },
    Cancel,
    HostedState,
    SignIn { name: Option<String>, report_status: Option<bool> },
    SignOut,
    SyncNow,
    TrustSetup { setup_id: String },
    MachineSettings { patch: MachinePatch },
    SetPolicy { policy: Policy },
    Resume,
    Hello { token: String },
    Subscribe,
    Notification { notification_id: String },
    NotificationAck { notification_id: String, receipt: String, delivered: bool },
}
impl Request {
    fn command(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Inspect => "inspect",
            Self::Preview { .. } => "preview",
            Self::Apply { .. } => "apply",
            Self::Cancel => "cancel",
            Self::HostedState => "hostedState",
            Self::SignIn { .. } => "signIn",
            Self::SignOut => "signOut",
            Self::SyncNow => "syncNow",
            Self::TrustSetup { .. } => "trustSetup",
            Self::MachineSettings { .. } => "machineSettings",
            Self::SetPolicy { .. } => "setPolicy",
            Self::Resume => "resume",
            Self::Hello { .. } => "hello",
            Self::Subscribe => "subscribe",
            Self::Notification { .. } => "notification",
            Self::NotificationAck { .. } => "notificationAck",
        }
    }
    fn timeout(&self) -> Duration {
        match self {
            Self::Inspect | Self::Apply { .. } | Self::SyncNow => Duration::from_secs(60),
            Self::Cancel | Self::SignOut => Duration::from_secs(30),
            Self::Hello { .. } => HELLO_TIMEOUT,
            Self::NotificationAck { .. } => Duration::from_secs(1),
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
            Self::SignIn { name, report_status } => {
                if let Some(name) = name { validate_display_name(name)?; record["name"] = json!(name); }
                if let Some(value) = report_status { record["reportStatus"] = json!(value); }
            }
            Self::TrustSetup { setup_id } => {
                if setup_id == "local" || setup_id.is_empty() || setup_id.len() > 100 || !setup_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') { return Err("Invalid setup id".into()); }
                record["setupId"] = json!(setup_id);
            }
            Self::MachineSettings { patch } => { patch.validate()?; record["patch"] = json!(patch); }
            Self::SetPolicy { policy } => { record["policy"] = json!(policy); }
            Self::Hello { token } => {
                if token.is_empty() || token.encode_utf16().count() > 200 { return Err("Invalid agent token".into()); }
                record["token"] = json!(token);
                record["client"] = json!("app");
            }
            Self::Notification { notification_id } | Self::NotificationAck { notification_id, .. } => {
                if !crate::notifications::valid_id(notification_id) { return Err("Invalid notification id".into()); }
                record["notificationId"] = json!(notification_id);
                if let Self::NotificationAck { receipt, delivered, .. } = self {
                    if !crate::notifications::valid_receipt(receipt) { return Err("Invalid notification receipt".into()); }
                    record["receipt"] = json!(receipt);
                    record["delivered"] = json!(delivered);
                }
            }
            _ => {}
        }
        let line = format!("{record}\n");
        if line.len() > MAX_RECORD { return Err("Request exceeds the record limit".into()); }
        Ok(line)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Policy {
    AutoApply,
    Notify,
    Manual,
}
pub fn decode_args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    if !value.is_object() { return Err("Expected command argument object".into()); }
    if serde_json::to_vec(&value).map_err(|_| "Invalid command arguments")?.len() > 4096 { return Err("Command arguments exceed limit".into()); }
    serde_json::from_value(value).map_err(|_| "Invalid command arguments".into())
}
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SignInArgs {
    #[serde(default, deserialize_with = "present")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pub report_status: Option<bool>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TrustArgs { pub setup_id: String }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MachineArgs { pub patch: MachinePatch }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyArgs { pub policy: Policy }
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetupArgs { pub config_targets: Vec<String> }
/// Public metadata only. The agent applies the shared HTTP schema as a second boundary.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy: Option<Policy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    report_status: Option<bool>,
}
impl<'de> Deserialize<'de> for MachinePatch {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self,D::Error> {
        let value = Value::deserialize(deserializer)?;
        if !value.is_object() { return Err(serde::de::Error::custom("Expected machine patch object")); }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields, rename_all = "camelCase")]
        struct Fields {
            #[serde(default, deserialize_with = "present")]
            name: Option<String>,
            #[serde(default, deserialize_with = "present")]
            policy: Option<Policy>,
            #[serde(default, deserialize_with = "present")]
            report_status: Option<bool>,
        }
        let fields: Fields = serde_json::from_value(value).map_err(serde::de::Error::custom)?;
        Ok(Self { name:fields.name, policy:fields.policy, report_status:fields.report_status })
    }
}
impl MachinePatch {
    fn validate(&self) -> Result<(), String> {
        if self.name.is_none() && self.policy.is_none() && self.report_status.is_none() { return Err("Empty machine patch".into()); }
        if let Some(name) = &self.name { validate_display_name(name)?; }
        Ok(())
    }
}
fn validate_display_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.trim() != name || name.chars().count() > 100
        || !name.chars().any(crate::display_name_categories::visible)
        || name.chars().any(crate::display_name_categories::disallowed) { return Err("Invalid display name".into()); }
    Ok(())
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
        if message["event"] == "notification" {
            crate::notifications::Delivery::decode(message.clone())?;
        } else if message["event"] == "status" {
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
        Self::connect_deadline(state_root, emit, hello_timeout, None, true)
    }
    fn connect_deadline(state_root: &Path, emit: Emit, hello_timeout: Duration, deadline: Option<Instant>, subscribe: bool) -> Result<Self, String> {
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
        if subscribe { agent.request_timeout(Request::Subscribe, remaining(Request::Subscribe.timeout()))?; }
        Ok(agent)
    }
    pub fn connect_notification(state_root: &Path, deadline: Instant) -> Result<Self, String> {
        Self::connect_deadline(state_root, Arc::new(|_| {}), HELLO_TIMEOUT, Some(deadline), false)
    }
    pub fn connect_ready(state_root: &Path, emit: Emit) -> Result<Self, String> {
        Self::connect_ready_timeout(state_root, emit, READY_TIMEOUT)
    }
    fn connect_ready_timeout(state_root: &Path, emit: Emit, timeout: Duration) -> Result<Self, String> {
        let deadline = Instant::now() + timeout;
        loop {
            match Self::connect_deadline(state_root, emit.clone(), HELLO_TIMEOUT, Some(deadline), true) {
                Ok(agent) => return Ok(agent),
                Err(error) if error.starts_with("UNREACHABLE:") => {
                    if Instant::now() >= deadline { return Err(error); }
                    thread::sleep(Duration::from_millis(50).min(deadline.saturating_duration_since(Instant::now())));
                }
                Err(error) => return Err(error),
            }
        }
    }
    pub fn request_before(&self, request: Request, deadline: Instant) -> Result<Value, String> {
        self.request_timeout(request, deadline.saturating_duration_since(Instant::now()))
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
    Paths,
    State,
    Bootstrap,
    InstallGit,
}
impl Setup {
    fn argument(self) -> &'static str {
        match self {
            Self::Ensure => "--ensure",
            Self::Restart => "--restart",
            Self::Paths => "--paths",
            Self::State => "--setup-state",
            Self::Bootstrap => "--bootstrap",
            Self::InstallGit => "--install-git",
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
    command.arg(script).arg(setup.argument());
    if matches!(setup, Setup::Ensure | Setup::Restart | Setup::Bootstrap) { command.arg("--app").arg(std::env::current_exe().map_err(|e| e.to_string())?); }
    command.current_dir(resources)
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
    run_helper(helper_command(resources, setup, None)?, if matches!(setup, Setup::Paths) { Duration::from_secs(3) } else { HELPER_TIMEOUT })
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SetupChoices { config_targets: Vec<String> }
impl SetupChoices {
    pub fn decode(config_targets: Vec<String>) -> Result<Self, String> {
        if config_targets.len() > 2 || config_targets.iter().any(|v| v != "claude" && v != "codex")
            || (config_targets.len() == 2 && config_targets[0] == config_targets[1]) { return Err("Invalid config targets".into()); }
        Ok(Self { config_targets })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DesktopSetupState { needs_setup: bool, repo: Option<String>, git_available: bool, can_install_git: bool, default_repo_url: String }
fn validate_setup_state(value: Value) -> Result<Value, String> {
    // Option alone accepts a missing key; every field is required by the helper contract.
    if value.as_object().is_none_or(|o| o.len() != 5 || !o.contains_key("repo")) { return Err("Invalid setup state".into()); }
    let state: DesktopSetupState = serde_json::from_value(value).map_err(|_| "Invalid setup state")?;
    if state.default_repo_url != "https://github.com/Nortus222/claude-config.git" { return Err("Invalid setup repository".into()); }
    serde_json::to_value(state).map_err(|_| "Invalid setup state".into())
}
pub fn desktop_setup_state(resources: &Path) -> Result<Value, String> {
    validate_setup_state(run_json_helper(helper_command(resources, Setup::State, None)?, Duration::from_secs(10), None)?)
}
pub fn bootstrap_desktop(resources: &Path, choices: SetupChoices) -> Result<PathBuf, String> {
    let input = serde_json::to_vec(&choices).map_err(|_| "Invalid setup choices")?;
    let mut command = helper_command(resources, Setup::Bootstrap, None)?;
    command.stdin(Stdio::piped());
    setup_root(run_json_helper_with_cancel(command, HELPER_TIMEOUT, Some(input), BOOTSTRAP_CANCEL_TIMEOUT)?)
}
pub fn install_git(resources: &Path) -> Result<Value, String> {
    let value = run_json_helper(helper_command(resources, Setup::InstallGit, None)?, Duration::from_secs(30), None)?;
    if value != json!({"requested":true}) { return Err("Invalid installer result".into()); }
    Ok(value)
}
pub fn device_login_command() -> Command {
    let mut command = Command::new("/usr/bin/open");
    command.arg("https://github.com/login/device").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    use std::os::unix::process::CommandExt;
    command.process_group(0);
    command
}
pub fn open_device_login() -> Result<Value, String> {
    run_browser(device_login_command(), Duration::from_secs(5))
}
fn run_browser(mut command: Command, timeout: Duration) -> Result<Value, String> {
    wait_browser(command.spawn().map_err(|_| "Unable to open GitHub")?, timeout)
}
fn wait_browser(mut child: std::process::Child, timeout: Duration) -> Result<Value, String> {
    let deadline = Instant::now() + timeout;
    let result = (|| {
        loop {
            if let Some(status) = child.try_wait().map_err(|_| "Unable to open GitHub")? {
                return if status.success() { Ok(json!({"opened":true})) } else { Err("Unable to open GitHub".into()) };
            }
            if Instant::now() >= deadline { return Err("Opening GitHub timed out".into()); }
            thread::sleep(Duration::from_millis(10));
        }
    })();
    if result.is_err() {
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill(); let _ = child.wait();
    }
    result
}

fn setup_root(value: Value) -> Result<PathBuf, String> {
    if !value.is_object() { return Err("Expected setup result object".into()); }
    let result: SetupResult = serde_json::from_value(value).map_err(|_| "Invalid setup result")?;
    if !result.state_root.is_absolute() { return Err("Invalid setup stateRoot".into()); }
    Ok(result.state_root)
}
fn run_helper(command: Command, timeout: Duration) -> Result<PathBuf, String> {
    setup_root(run_json_helper(command, timeout, None)?)
}
/// The native host owns and joins every helper child and pipe reader before returning.
fn run_json_helper(command: Command, timeout: Duration, input: Option<Vec<u8>>) -> Result<Value, String> {
    run_json_helper_with_cancel(command, timeout, input, Duration::ZERO)
}
fn run_json_helper_with_cancel(mut command: Command, timeout: Duration, input: Option<Vec<u8>>, cancel_timeout: Duration) -> Result<Value, String> {
    if input.as_ref().is_some_and(|v| v.len() > 4096) { return Err("Setup input exceeds limit".into()); }
    wait_json_helper(command.spawn().map_err(|e| e.to_string())?, timeout, input, cancel_timeout)
}
fn wait_json_helper(mut child: std::process::Child, timeout: Duration, input: Option<Vec<u8>>, cancel_timeout: Duration) -> Result<Value, String> {
    let stdout = child.stdout.take().ok_or("Missing helper stdout")?;
    let stderr = child.stderr.take().ok_or("Missing helper stderr")?;
    let (send, receive) = mpsc::channel();
    let reader = thread::spawn(move || {
        let result = (|| -> Result<Value, String> {
            let mut reader = BufReader::new(stdout);
            let line = bounded_line(&mut reader)?.ok_or("Missing setup result")?;
            let value = serde_json::from_slice(&line).map_err(|_| "Invalid setup result")?;
            if bounded_line(&mut reader)?.is_some() { return Err("Unexpected setup output".into()); }
            Ok(value)
        })();
        let _ = send.send(result);
    });
    let (done, drained) = mpsc::channel();
    let errors = thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(_)) = bounded_line(&mut reader) {} // Diagnostics never enter renderer or token-bearing logs.
        let _ = done.send(());
    });
    let (sent, written) = mpsc::channel();
    let writer = input.map(|input| {
        let mut stdin = child.stdin.take().expect("Piped helper input");
        thread::spawn(move || { let result = stdin.write_all(&input).and_then(|_| stdin.flush()); drop(stdin); let _ = sent.send(result); })
    });
    let deadline = Instant::now() + timeout;
    let result = (|| -> Result<Value, String> {
        if writer.is_some() { written.recv_timeout(Duration::from_secs(5).min(timeout)).map_err(|_| "Setup input timed out")?.map_err(|_| "Setup input failed")?; }
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
            if Instant::now() >= deadline { return Err("Agent setup timed out".into()); }
            thread::sleep(Duration::from_millis(10));
        };
        if !status.success() { return Err(format!("Agent setup failed: {status}")); }
        let value = receive.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| "Agent setup output timed out")??;
        drained.recv_timeout(deadline.saturating_duration_since(Instant::now())).map_err(|_| "Agent setup diagnostics timed out")?;
        Ok(value)
    })();
    if result.is_err() {
        // Bootstrap's signal handler cancels and joins its detached Git group before cleanup.
        // Other lifecycle helpers retain their existing immediate termination contract.
        if !cancel_timeout.is_zero() && child.try_wait().ok().flatten().is_none() {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM); }
            let cancel_deadline = Instant::now() + cancel_timeout;
            while Instant::now() < cancel_deadline {
                if child.try_wait().ok().flatten().is_some() { break; }
                thread::sleep(Duration::from_millis(10));
            }
        }
        // Also close any inherited pipes held by children in the helper's group.
        // A forced kill or crash cannot run finalizers for children in separate groups.
        unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
        let _ = child.kill(); let _ = child.wait();
    }
    let _ = reader.join(); let _ = errors.join(); if let Some(writer) = writer { let _ = writer.join(); }
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
    fn bootstrap_outer_timeout_joins_detached_git_and_removes_only_its_owned_directory_and_lock() {
        struct Fixture { root: PathBuf, child: Option<std::process::Child> }
        impl Drop for Fixture {
            fn drop(&mut self) {
                if let Some(child) = self.child.take() { let _ = wait_json_helper(child, Duration::ZERO, None, BOOTSTRAP_CANCEL_TIMEOUT); }
                if let Ok(text) = std::fs::read_to_string(self.root.join("git.pid")) {
                    if let Ok(pid) = text.parse::<i32>() { unsafe { libc::kill(-pid, libc::SIGKILL); } }
                }
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        let node = Command::new("node").args(["-p", "process.execPath"]).output().unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        let root = resources(&format!("exec '{}' '{}' \"$PWD\"", node.replace('\'', "'\\''"), repo.join("apps/desktop/checks/support/native-bootstrap-fixture.ts").display()));
        let mut fixture = Fixture { root: root.clone(), child: None };
        let home = root.join("home"); std::fs::create_dir(&home).unwrap();
        let tools = root.join("tools"); std::fs::create_dir(&tools).unwrap();
        std::fs::write(tools.join("git"), format!(r#"#!{node}
const fs = require('node:fs');
if (!process.argv.includes('clone')) {{ console.log('fake Git'); process.exit(0); }}
process.on('SIGTERM', () => {{}});
setInterval(() => {{}}, 1000);
fs.mkdirSync(process.argv.at(-1), {{recursive:true}});
fs.writeFileSync({pid:?}, String(process.pid));
fs.writeFileSync({owned:?} + '.tmp', process.argv.at(-1));
fs.renameSync({owned:?} + '.tmp', {owned:?});
"#, pid=root.join("git.pid").to_str().unwrap(), owned=root.join("owned").to_str().unwrap())).unwrap();
        std::fs::set_permissions(tools.join("git"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let state = home.join("state"); std::fs::create_dir(&state).unwrap();
        std::fs::create_dir(state.join("desktop-setup-existing")).unwrap();
        std::fs::write(state.join("desktop-setup-existing/keep"), "owner data").unwrap();
        fixture.child = Some(helper_command(&root, Setup::Bootstrap, None).unwrap().spawn().unwrap());
        // The fixture's fixed choices let the real clone start before the scaled outer deadline.
        let ready_deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("owned").exists() && Instant::now() < ready_deadline { thread::sleep(Duration::from_millis(10)); }
        assert!(root.join("owned").exists(), "fake clone did not become ready");
        let start = Instant::now();
        let result = wait_json_helper(fixture.child.take().unwrap(), Duration::from_millis(100), None, BOOTSTRAP_CANCEL_TIMEOUT);
        let elapsed = start.elapsed();
        // Capture evidence, then always clean up this fixture's child before asserting RED/GREEN.
        let pid = std::fs::read_to_string(root.join("git.pid")).unwrap().parse::<i32>().unwrap();
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        let owned = PathBuf::from(std::fs::read_to_string(root.join("owned")).unwrap());
        let directory_remains = owned.parent().unwrap().exists();
        let lock_remains = state.join("apply.lock").exists();
        let recorded = state.join("state.json").exists();
        let unrelated = std::fs::read_to_string(state.join("desktop-setup-existing/keep")).unwrap();
        if alive { unsafe { libc::kill(-pid, libc::SIGKILL); } }
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.unwrap_err().contains("timed out"));
        assert!(elapsed < Duration::from_secs(9));
        assert!(!alive, "detached Git survived native timeout");
        assert!(!directory_remains, "owned clone directory survived native timeout");
        assert!(!lock_remains, "apply lock survived native timeout");
        assert!(!recorded, "failed clone recorded setup authority");
        assert_eq!(unrelated, "owner data");
    }
    #[test]
    fn bootstrap_escalates_and_joins_a_helper_that_ignores_graceful_cancellation() {
        let root = resources("exec /bin/sleep 30");
        let mut command = helper_command(&root, Setup::Bootstrap, None).unwrap();
        use std::os::unix::process::CommandExt;
        // Install before exec, so SIGTERM is ignored even if the script has not started.
        unsafe { command.pre_exec(|| { libc::signal(libc::SIGTERM, libc::SIG_IGN); Ok(()) }); }
        let child = command.spawn().unwrap();
        let pid = child.id() as i32;
        let start = Instant::now();
        let result = wait_json_helper(child,
            Duration::from_millis(100), None, Duration::from_millis(50));
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        if alive { unsafe { libc::kill(-pid, libc::SIGKILL); } }
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap_err(), "Agent setup timed out");
        assert!(start.elapsed() >= Duration::from_millis(150), "SIGTERM bypassed the grace interval");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(!alive, "helper survived hard escalation");
    }
    #[test]
    fn first_run_helpers_use_fixed_arguments_and_bounded_json_stdin() {
        let root = resources(r#"case "$2" in
--setup-state) [ "$#" = 2 ] || exit 2; printf '%s\n' '{"needsSetup":true,"repo":null,"gitAvailable":false,"canInstallGit":true,"defaultRepoUrl":"https://github.com/Nortus222/claude-config.git"}' ;;
--install-git) [ "$#" = 2 ] || exit 3; printf '%s\n' '{"requested":true}' ;;
--bootstrap) [ "$#" = 4 ] || exit 4; [ "$3" = --app ] || exit 5; /bin/cat > input; printf '%s\n' '{"stateRoot":"/tmp/bootstrapped"}' ;;
*) exit 6;; esac"#);
        assert_eq!(desktop_setup_state(&root).unwrap()["needsSetup"],true);
        assert_eq!(install_git(&root).unwrap(),json!({"requested":true}));
        assert_eq!(bootstrap_desktop(&root, SetupChoices::decode(vec!["codex".into()]).unwrap()).unwrap(),PathBuf::from("/tmp/bootstrapped"));
        assert_eq!(std::fs::read_to_string(root.join("input")).unwrap(),"{\"configTargets\":[\"codex\"]}");
        assert!(run_json_helper(helper_command(&root, Setup::State, None).unwrap(),Duration::from_secs(1),Some(vec![b'x';4097])).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn explicit_browser_execution_is_bounded_and_joins_only_its_owned_child() {
        let root = resources("/bin/sleep 0.2\nexec /bin/sleep 30");
        let mut command = Command::new(root.join("bun")); command.current_dir(&root);
        use std::os::unix::process::CommandExt; command.process_group(0);
        let child = command.spawn().unwrap();
        // A valid timeout may expire before the fake program's first instruction.
        let pid = child.id() as i32;
        assert!(wait_browser(child,Duration::from_millis(100)).unwrap_err().contains("timed out"));
        assert_eq!(unsafe {libc::kill(pid,0)},-1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn helper_output_is_one_complete_bounded_record() {
        for output in ["printf '%s' '{}'", "printf '%s\\n' '{}\n{}'", "dd if=/dev/zero bs=1048576 count=1 2>/dev/null"] {
            let root = resources(output);
            assert!(run_json_helper(helper_command(&root, Setup::State, None).unwrap(),Duration::from_secs(1),None).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
        let root = resources("printf '%s' \"$$\" > pid\n/bin/cat >/dev/null\n/bin/sleep 30 &\nprintf '%s\\n' '{\"stateRoot\":\"/tmp/x\"}'");
        let mut command = helper_command(&root, Setup::Bootstrap, None).unwrap(); command.stdin(Stdio::piped());
        let started = Instant::now();
        assert!(run_json_helper(command,Duration::from_millis(100),Some(b"{\"configTargets\":[]}".to_vec())).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        let pid = std::fs::read_to_string(root.join("pid")).unwrap().parse::<i32>().unwrap();
        assert_eq!(unsafe {libc::kill(pid,0)},-1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn paths_helper_has_no_registration_arguments() {
        let root = resources(r#"[ "$#" = 2 ] || exit 9
[ "$2" = --paths ] || exit 8
printf '%s\n' '{"stateRoot":"/tmp/read-only-state"}'"#);
        assert_eq!(run_helper(helper_command(&root,Setup::Paths,None).unwrap(),Duration::from_secs(1)).unwrap(),PathBuf::from("/tmp/read-only-state"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fixed_helper_arguments_and_strict_output_determine_the_state_root() {
        let root = resources(r#"[ "$1" = "$PWD/agent.mjs" ] || exit 9
case "$2" in --ensure|--restart) ;; *) exit 8;; esac
[ "$#" = 4 ] || exit 7
[ "$3" = --app ] || exit 6
case "$4" in /*) ;; *) exit 5;; esac
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

#[cfg(test)]
mod notification_tests {
    use super::*;
    #[test]
    fn fixed_notification_requests_reject_invalid_ids_and_receipts() {
        let id = "a".repeat(64);
        let request: Value = serde_json::from_str(&Request::Notification {notification_id:id.clone()}.record("1").unwrap()).unwrap();
        assert_eq!(request,json!({"version":3,"id":"1","command":"notification","notificationId":id}));
        let ack: Value = serde_json::from_str(&Request::NotificationAck {notification_id:id.clone(),receipt:"r".into(),delivered:false}.record("2").unwrap()).unwrap();
        assert_eq!(ack,json!({"version":3,"id":"2","command":"notificationAck","notificationId":id,"receipt":"r","delivered":false}));
        assert!(Request::Notification {notification_id:"path".into()}.record("1").is_err());
        for receipt in [String::new(),"r".repeat(101)] { assert!(Request::NotificationAck {notification_id:id.clone(),receipt,delivered:true}.record("1").is_err()); }
    }
    #[test]
    fn notification_event_is_strict_and_bounded() {
        let good = json!({"version":3,"event":"notification","notification":{"id":"a".repeat(64),"title":"Review","body":"Items"},"receipt":"receipt"});
        assert!(validate(&good).is_ok());
        for (pointer, value) in [("/notification/id", json!("A".repeat(64))), ("/notification/title", json!("a".repeat(101))), ("/notification/body", json!("a".repeat(501))), ("/receipt",json!("")), ("/receipt",json!("a".repeat(101)))] {
            let mut bad = good.clone(); *bad.pointer_mut(pointer).unwrap() = value; assert!(validate(&bad).is_err());
        }
        for field in ["extra", "received_at"] { let mut bad = good.clone(); bad[field] = json!(true); assert!(validate(&bad).is_err()); }
        let mut bad = good; bad["notification"]["extra"] = json!(true); assert!(validate(&bad).is_err());
    }
}

#[cfg(test)]
mod onboarding_bridge_tests {
    use super::*;
    #[test]
    fn account_requests_use_only_strict_public_values() {
        let record: Value = serde_json::from_str(&Request::SignIn { name: Some("My Mac".into()), report_status: Some(false) }.record("1").unwrap()).unwrap();
        assert_eq!(record, json!({"version":3,"id":"1","command":"signIn","name":"My Mac","reportStatus":false}));
        let patch: MachinePatch = serde_json::from_value(json!({"reportStatus":false,"policy":"notify"})).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&Request::MachineSettings { patch }.record("2").unwrap()).unwrap()["patch"], json!({"reportStatus":false,"policy":"notify"}));
        for invalid in [json!({}), json!({"name":" bad"}), json!({"reportStatus":false,"path":"/tmp"}), json!({"policy":"shell"}), json!({"reportStatus":{"command":"x"}})] {
            let decoded = serde_json::from_value::<MachinePatch>(invalid);
            assert!(decoded.is_err() || Request::MachineSettings { patch: decoded.unwrap() }.record("2").is_err());
        }
        for name in ["", " ", "bad\nname", "bad\u{200b}name", "bad\u{0378}name", "\u{0301}"] {
            assert!(Request::SignIn { name: Some(name.into()), report_status: None }.record("1").is_err());
        }
        for id in ["local", "/tmp/repo", "a_b", ""] { assert!(Request::TrustSetup { setup_id:id.into() }.record("1").is_err()); }
        assert!(Request::SignIn { name: Some("😀".repeat(100)), report_status: Some(true) }.record("1").is_ok());
        assert!(Request::SignIn { name: Some("😀".repeat(101)), report_status: None }.record("1").is_err());
        assert_eq!(Request::SignOut.timeout(), Duration::from_secs(30));
        assert_eq!(Request::SyncNow.timeout(), Duration::from_secs(60));
    }
    #[test]
    fn command_args_reject_unknown_nested_null_and_oversized_values() {
        assert!(decode_args::<SignInArgs>(json!({"reportStatus":false})).is_ok());
        for value in [json!({"name":null}), json!({"reportStatus":null}), json!({"reportStatus":false,"token":"secret"}), json!({"name":"x".repeat(4096)})] {
            assert!(decode_args::<SignInArgs>(value).is_err());
        }
        assert!(decode_args::<EmptyArgs>(json!({"url":"https://evil.invalid"})).is_err());
        for value in [json!({"patch":{"name":null}}), json!({"patch":{"reportStatus":false,"command":"x"}}), json!({"patch":{"reportStatus":false},"token":"secret"})] {
            assert!(decode_args::<MachineArgs>(value).is_err());
        }
        assert!(decode_args::<SetupArgs>(json!({"configTargets":[],"repo":"/tmp"})).is_err());
    }
    #[test]
    fn native_records_reject_positional_arrays_before_actions_or_ipc() {
        assert!(decode_args::<EmptyArgs>(json!([])).is_err());
        assert!(decode_args::<SetupArgs>(json!([["codex"]])).is_err());
        assert!(decode_args::<SignInArgs>(json!(["My Mac",false])).is_err());
        assert!(decode_args::<MachineArgs>(json!({"patch":["My Mac","notify",false]})).is_err());
        assert!(serde_json::from_value::<MachinePatch>(json!(["My Mac","notify",false])).is_err());
        assert!(setup_root(json!(["/tmp/owned"])).is_err());
        assert!(decode_args::<SetupArgs>(json!({"configTargets":["codex"]})).is_ok());
        assert!(decode_args::<SignInArgs>(json!({})).is_ok());
        assert!(decode_args::<MachineArgs>(json!({"patch":{"reportStatus":false}})).is_ok());
        assert_eq!(setup_root(json!({"stateRoot":"/tmp/owned"})).unwrap(),PathBuf::from("/tmp/owned"));
    }
    #[test]
    fn choices_and_setup_state_have_no_renderer_authority() {
        assert!(SetupChoices::decode(vec!["claude".into(),"codex".into()]).is_ok());
        for values in [vec!["claude".into(),"claude".into()], vec!["/tmp".into()]] { assert!(SetupChoices::decode(values).is_err()); }
        assert!(validate_setup_state(json!({"needsSetup":true,"repo":null,"gitAvailable":false,"canInstallGit":true,"defaultRepoUrl":"https://github.com/Nortus222/claude-config.git"})).is_ok());
        assert!(validate_setup_state(json!({"needsSetup":true,"repo":null,"gitAvailable":false,"canInstallGit":true,"defaultRepoUrl":"https://evil.invalid"})).is_err());
        assert!(validate_setup_state(json!({"needsSetup":true,"repo":null,"gitAvailable":false,"canInstallGit":true,"defaultRepoUrl":"https://github.com/Nortus222/claude-config.git","path":"/tmp"})).is_err());
        let command = device_login_command();
        assert_eq!(command.get_program(), "/usr/bin/open");
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec!["https://github.com/login/device"]);
    }
}
