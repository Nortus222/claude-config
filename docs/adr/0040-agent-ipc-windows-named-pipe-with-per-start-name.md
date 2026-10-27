---
status: accepted
note: amended by 0041 for remote access over Tailscale
---

# On Windows the agent serves IPC on a named pipe whose name is per-start

Amends ADR 0019 for win32. The agent listens on `\\.\pipe\nortuscc-agent-<128-bit random>`, a
name drawn fresh on every start. It writes the name to `agent/agent.pipe` beside `agent.token`
in the `agent/` directory, and only after `listen` succeeds. That directory must be private to
the user: on Windows the agent's `chmod` is a no-op, so the privacy comes from the per-user ACL
of `%APPDATA%`, and a `NORTUSCC_STATE_DIR` elsewhere must name a user-only location. Clients read the name and
the token from that directory and speak protocol v3 unchanged. The server still sends nothing
before a valid `hello`. Node and Bun both create the first pipe instance with
`FILE_FLAG_FIRST_PIPE_INSTANCE`: on Windows 11 both refuse a name that another process already
holds, whether held by a second Node or Bun listener or by a .NET multi-instance server. Node
reports `EADDRINUSE`; Bun reports `ERR_INVALID_ARG_TYPE`. So an agent fails closed rather than
joining a squatted pipe. The default DACL they produce is `Everyone:R, Anonymous:R, SYSTEM:F,
Administrators:F, owner:F`. Another user can therefore open a read-only instance but can neither
write `hello` nor add an instance, and the unauthenticated server writes nothing they could read.
The Rust host also opens the pipe at `SECURITY_IDENTIFICATION` and refuses a server whose
process token user (`GetNamedPipeServerProcessId`, then `OpenProcessToken`) is not the current
user's SID.

## Considered options

- Default DACL with a fixed name (rejected in 0019): another user could create the name first
  and harvest tokens. A per-start name and the first-instance flag close that: the name cannot be
  predicted before the agent creates it, and cannot be taken once it has.
- A native helper that creates the pipe with a user-only DACL: a new binary to build, sign and
  ship. It is still the stronger fix if remote or read-only access ever matters.
- The Tauri binary owning the pipe: reverses who is server, and the CLI and MCP need the agent
  without the app.
- Loopback TCP: reachable from browsers (ADR 0011). Windows `AF_UNIX` sockets: libuv serves only
  named pipes for `net` paths on Windows, and Rust's `std` has no Windows `AF_UNIX` stream.

## Consequences

- The app stops its agent by asking it to `shutdown` over the pipe, and kills it only if it has
  not exited within about 2 s. A graceful stop removes `agent.pipe` and `agent.token` and
  releases `agent.lock`. A kill, a crash or a forced end of the app leaves them behind. The
  stale lock is reclaimed once its PID is dead, but a reused PID can make the next start
  refuse while that unrelated process runs.
- A stale `agent.pipe` left by such an agent is the remaining exposure: another user could create
  that name and impersonate the agent. A token sent to it is worthless, because each start mints
  a new one. The Rust host's SID check refuses such a server. TypeScript clients (the CLI and
  App MCP, which runs on Windows) have no FFI for that check and get name protection only. A
  spoofed agent could return false status, and could feed false tool results to an MCP host,
  until the real agent starts again.
- On Windows the desktop app owns the agent: it spawns the bundled agent as a child in a
  kill-on-close job, so the agent dies with the app. There is no Task Scheduler login service for
  an app-owned agent. The agent, and with it scheduled checks, auto-apply and App MCP, therefore
  runs only while the app is open.
- Another user can hold read-only instances open until the 10 s handshake timer closes them:
  a nuisance, not a leak.
- The protocol, token, framing and error codes are unchanged; only how a client finds and opens
  the endpoint differs by platform.
