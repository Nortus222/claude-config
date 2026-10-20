//! The Windows agent endpoint (ADR 0040): the per-start named pipe named in `agent/agent.pipe`.
//! Synchronous pipe I/O on one file object is serialized, so a blocked read would stall every write;
//! the handle is overlapped and each read or write waits on its own event instead.
use std::{
    io,
    path::Path,
    ptr::{null, null_mut},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, RwLock},
    thread,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{EqualSid, GetLengthSid, GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER},
    Storage::FileSystem::*,
    System::{IO::*, Pipes::GetNamedPipeServerProcessId, Threading::*},
};

const PREFIX: &str = r"\\.\pipe\nortuscc-agent-";

/// The pipe path in an `agent.pipe` record: `\\.\pipe\nortuscc-agent-` and 32 lowercase hex digits.
fn pipe_name(record: &str) -> Option<&str> {
    let name = record.trim();
    let hex = name.strip_prefix(PREFIX)?;
    (hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))).then_some(name)
}
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }

struct Shared {
    handle: usize,
    // Readers are in-flight operations; `shutdown` takes it exclusively to close the handle.
    open: RwLock<()>,
    closed: AtomicBool,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
}
impl Drop for Shared {
    fn drop(&mut self) { if !self.closed.load(Ordering::SeqCst) { unsafe { CloseHandle(self.handle as HANDLE) }; } }
}

/// One overlapped pipe handle shared by every clone; timeouts are shared like a socket's.
pub struct Pipe(Arc<Shared>);
impl Pipe {
    fn new(handle: HANDLE) -> Self {
        Self(Arc::new(Shared { handle: handle as usize, open: RwLock::new(()), closed: AtomicBool::new(false), read_timeout: Mutex::new(None), write_timeout: Mutex::new(None) }))
    }
    fn handle(&self) -> HANDLE { self.0.handle as HANDLE }
    pub fn try_clone(&self) -> io::Result<Self> { Ok(Self(self.0.clone())) }
    pub fn set_write_timeout(&self, timeout: Option<Duration>) -> io::Result<()> { *self.0.write_timeout.lock().unwrap() = timeout; Ok(()) }
    #[cfg(test)]
    pub fn set_read_timeout(&self, timeout: Option<Duration>) -> io::Result<()> { *self.0.read_timeout.lock().unwrap() = timeout; Ok(()) }
    /// Cancels every pending operation on every clone and closes the handle: later reads see end of
    /// stream, later writes fail, and the peer sees the pipe broken.
    pub fn shutdown(&self) {
        if self.0.closed.swap(true, Ordering::SeqCst) { return; }
        loop {
            // Repeated: an operation may start between a cancel and the exclusive lock.
            unsafe { CancelIoEx(self.handle(), null()) };
            if let Ok(_open) = self.0.open.try_write() { unsafe { CloseHandle(self.handle()) }; return; }
            thread::sleep(Duration::from_millis(1));
        }
    }
    /// One overlapped read or write, bounded by the matching timeout.
    fn transfer(&self, write: bool, buffer: *mut u8, length: usize) -> io::Result<usize> {
        let _open = self.0.open.read().unwrap_or_else(|e| e.into_inner());
        let ended = || if write { Err(io::ErrorKind::BrokenPipe.into()) } else { Ok(0) };
        if self.0.closed.load(Ordering::SeqCst) { return ended(); }
        let timeout = *if write { &self.0.write_timeout } else { &self.0.read_timeout }.lock().unwrap();
        let event = unsafe { CreateEventW(null(), 1, 0, null()) };
        if event.is_null() { return Err(io::Error::last_os_error()); }
        let _event = Handle(event);
        let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
        overlapped.hEvent = event;
        let length = length.min(u32::MAX as usize) as u32;
        let started = unsafe {
            if write { WriteFile(self.handle(), buffer, length, null_mut(), &mut overlapped) }
            else { ReadFile(self.handle(), buffer, length, null_mut(), &mut overlapped) }
        };
        let error = unsafe { GetLastError() };
        if started == 0 && error != ERROR_IO_PENDING { return failure(error, ended); }
        let wait = timeout.map_or(INFINITE, |t| (t.as_millis().max(1)).min(u128::from(INFINITE - 1)) as u32);
        let mut count = 0;
        if unsafe { GetOverlappedResultEx(self.handle(), &overlapped, &mut count, wait, 0) } != 0 { return Ok(count as usize); }
        let error = unsafe { GetLastError() };
        if error != WAIT_TIMEOUT { return failure(error, ended); }
        unsafe { CancelIoEx(self.handle(), &overlapped); GetOverlappedResult(self.handle(), &overlapped, &mut count, 1) };
        Err(io::ErrorKind::TimedOut.into())
    }
}
fn failure(error: u32, ended: impl Fn() -> io::Result<usize>) -> io::Result<usize> {
    match error {
        ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA | ERROR_OPERATION_ABORTED => ended(),
        _ => Err(io::Error::from_raw_os_error(error as i32)),
    }
}
impl io::Read for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> { self.transfer(false, buffer.as_mut_ptr(), buffer.len()) }
}
impl io::Write for Pipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> { self.transfer(true, buffer.as_ptr().cast_mut(), buffer.len()) }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

struct Handle(HANDLE);
impl Drop for Handle { fn drop(&mut self) { unsafe { CloseHandle(self.0) }; } }

/// A copy of a SID in 4-byte-aligned storage, as `EqualSid` expects.
struct Sid(Vec<u32>);
impl Sid {
    unsafe fn copy(sid: PSID) -> Self {
        let length = GetLengthSid(sid) as usize;
        let mut words = vec![0u32; length.div_ceil(4)];
        std::ptr::copy_nonoverlapping(sid as *const u8, words.as_mut_ptr().cast::<u8>(), length);
        Self(words)
    }
    fn psid(&self) -> PSID { self.0.as_ptr() as PSID }
}
fn same_user(a: &Sid, b: &Sid) -> bool { unsafe { EqualSid(a.psid(), b.psid()) != 0 } }
/// The user SID of a process's primary token.
fn process_user(process: HANDLE) -> io::Result<Sid> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 { return Err(io::Error::last_os_error()); }
    let token = Handle(token);
    let mut length = 0;
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length) };
    let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
    if unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) } == 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { Sid::copy((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid) })
}
/// Refuses a pipe whose server process does not run as the current user.
fn check_server(pipe: &Pipe) -> Result<(), String> {
    let refuse = |e: io::Error| format!("UNREACHABLE: Agent pipe server: {e}");
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(pipe.handle(), &mut pid) } == 0 { return Err(refuse(io::Error::last_os_error())); }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() { return Err(refuse(io::Error::last_os_error())); }
    let process = Handle(process);
    let server = process_user(process.0).map_err(refuse)?;
    let current = process_user(unsafe { GetCurrentProcess() }).map_err(refuse)?;
    if same_user(&server, &current) { Ok(()) } else { Err("UNREACHABLE: Agent pipe server is not the current user".into()) }
}

/// Opens the pipe named in `<directory>/agent.pipe`, read fresh, at identification level, and only
/// if its server runs as the current user. Every failure is `UNREACHABLE:` so readiness retries.
pub fn connect(directory: &Path) -> Result<Pipe, String> {
    let record = std::fs::read_to_string(directory.join("agent.pipe")).map_err(|e| format!("UNREACHABLE: Agent pipe: {e}"))?;
    let name = pipe_name(&record).ok_or("UNREACHABLE: agent.pipe does not name an agent pipe")?;
    let handle = unsafe {
        CreateFileW(wide(name).as_ptr(), GENERIC_READ | GENERIC_WRITE, 0, null(), OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, null_mut())
    };
    if handle == INVALID_HANDLE_VALUE { return Err(format!("UNREACHABLE: Agent pipe: {}", io::Error::last_os_error())); }
    let pipe = Pipe::new(handle);
    check_server(&pipe)?;
    Ok(pipe)
}

/// A fake agent's pipe server for tests: `bind` publishes a fresh name in `agent.pipe`.
#[cfg(test)]
pub(crate) mod server {
    use super::*;
    use std::sync::atomic::AtomicU64;
    use windows_sys::Win32::System::Pipes::*;
    pub(crate) struct Listener { name: String, next: Pipe }
    pub(crate) fn fresh_name() -> String {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
        format!("{PREFIX}{:08x}{:08x}{:016x}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst) as u32, nanos)
    }
    // A 1 KiB inbound buffer so large client writes wait for the server to read.
    fn instance(name: &str) -> Pipe {
        let handle = unsafe {
            CreateNamedPipeW(wide(name).as_ptr(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, PIPE_UNLIMITED_INSTANCES, 65536, 1024, 0, null())
        };
        assert_ne!(handle, INVALID_HANDLE_VALUE, "{}", io::Error::last_os_error());
        Pipe::new(handle)
    }
    impl Listener {
        pub fn bind(agent: &Path) -> Self {
            let name = fresh_name();
            let listener = Self::named(&name);
            std::fs::write(agent.join("agent.pipe"), format!("{name}\n")).unwrap();
            listener
        }
        pub fn named(name: &str) -> Self { Self { next: instance(name), name: name.into() } }
        /// Waits for a client on the current instance and opens the next one before returning.
        pub fn accept(&mut self) -> Pipe {
            let event = Handle(unsafe { CreateEventW(null(), 1, 0, null()) });
            let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
            overlapped.hEvent = event.0;
            if unsafe { ConnectNamedPipe(self.next.handle(), &mut overlapped) } == 0 {
                match unsafe { GetLastError() } {
                    ERROR_PIPE_CONNECTED => {}
                    ERROR_IO_PENDING => { let mut count = 0; assert_ne!(unsafe { GetOverlappedResult(self.next.handle(), &overlapped, &mut count, 1) }, 0); }
                    error => panic!("ConnectNamedPipe: {}", io::Error::from_raw_os_error(error as i32)),
                }
            }
            std::mem::replace(&mut self.next, instance(&self.name))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{server::*, *};
    use std::{io::{Read, Write}, sync::mpsc, time::Instant};
    use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;

    fn agent_dir() -> std::path::PathBuf {
        let root = crate::host::fixtures::scratch();
        std::fs::create_dir(root.join("agent")).unwrap();
        root.join("agent")
    }
    fn pair() -> (Pipe, Pipe, std::path::PathBuf) {
        let dir = agent_dir();
        let mut listener = Listener::bind(&dir);
        let client = connect(&dir).unwrap();
        (client, listener.accept(), dir)
    }
    #[test]
    fn names_are_exactly_the_agent_pipe_shape() {
        let good = format!("{PREFIX}{}", "0123456789abcdef".repeat(2));
        assert_eq!(pipe_name(&format!("{good}\n")), Some(good.as_str()));
        for bad in [format!("{PREFIX}{}", "0123456789ABCDEF".repeat(2)), format!("{PREFIX}{}", "a".repeat(31)), format!("{PREFIX}{}", "a".repeat(33)),
            format!(r"\\server\pipe\nortuscc-agent-{}", "a".repeat(32)), format!(r"\\.\pipe\other-{}", "a".repeat(32)), String::new()] {
            assert_eq!(pipe_name(&bad), None, "{bad}");
        }
    }
    #[test]
    fn malformed_or_missing_agent_pipe_is_unreachable() {
        let dir = agent_dir();
        assert!(connect(&dir).err().unwrap().starts_with("UNREACHABLE: Agent pipe:"));
        std::fs::write(dir.join("agent.pipe"), r"\\.\pipe\squatter").unwrap();
        assert_eq!(connect(&dir).err().unwrap(), "UNREACHABLE: agent.pipe does not name an agent pipe");
        std::fs::write(dir.join("agent.pipe"), format!("{}\n", fresh_name())).unwrap();
        assert!(connect(&dir).err().unwrap().starts_with("UNREACHABLE: Agent pipe:"), "A named pipe that does not exist is unreachable");
    }
    #[test]
    fn sid_comparison_distinguishes_users() {
        let current = process_user(unsafe { GetCurrentProcess() }).unwrap();
        let mut raw = null_mut();
        assert_ne!(unsafe { ConvertStringSidToSidW(wide("S-1-5-18").as_ptr(), &mut raw) }, 0);
        let system = unsafe { Sid::copy(raw) };
        unsafe { LocalFree(raw) };
        assert!(same_user(&current, &process_user(unsafe { GetCurrentProcess() }).unwrap()));
        assert!(!same_user(&current, &system));
    }
    #[test]
    fn a_blocked_read_never_blocks_a_write_on_a_clone() {
        let (client, mut server, _) = pair();
        let mut reader = client.try_clone().unwrap();
        let blocked = thread::spawn(move || { let mut byte = [0u8; 1]; reader.read(&mut byte).map(|n| (n, byte[0])) });
        thread::sleep(Duration::from_millis(50));
        let (done, written) = mpsc::channel();
        let mut writer = client.try_clone().unwrap();
        thread::spawn(move || done.send(writer.write_all(b"hello\n").is_ok()).unwrap());
        assert!(written.recv_timeout(Duration::from_secs(2)).unwrap(), "A write must complete while a read is pending");
        let mut received = [0u8; 6]; server.read_exact(&mut received).unwrap(); assert_eq!(&received, b"hello\n");
        server.write_all(b"x").unwrap();
        assert_eq!(blocked.join().unwrap().unwrap(), (1, b'x'));
    }
    #[test]
    fn shutdown_interrupts_a_blocked_reader_and_writer_and_the_peer_sees_the_end() {
        let (client, mut server, _) = pair();
        let mut reader = client.try_clone().unwrap(); let mut writer = client.try_clone().unwrap();
        let read = thread::spawn(move || { let mut byte = [0u8; 1]; reader.read(&mut byte) });
        let write = thread::spawn(move || writer.write_all(&vec![b'x'; 1 << 20]));
        thread::sleep(Duration::from_millis(50));
        let start = Instant::now();
        client.shutdown();
        assert_eq!(read.join().unwrap().unwrap(), 0);
        assert!(write.join().unwrap().is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        let mut rest = Vec::new(); server.read_to_end(&mut rest).unwrap();
        assert!(client.try_clone().unwrap().write(b"x").is_err());
    }
    #[test]
    fn write_timeout_bounds_a_write_the_peer_never_reads() {
        let (client, _server, _) = pair();
        client.set_write_timeout(Some(Duration::from_millis(50))).unwrap();
        let start = Instant::now();
        let error = client.try_clone().unwrap().write_all(&vec![b'x'; 1 << 20]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_millis(500));
    }
}
