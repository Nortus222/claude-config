---
status: accepted
---

# The agent serves IPC on a Unix socket only, for now

The agent answers its clients (the CLI and the desktop app) over a user-only local endpoint with a
per-start token checked in `hello`. On macOS and Linux that is `agent/agent.sock`, mode 0600 in a
0700 directory. On Windows it would be a named pipe, but Node cannot create a pipe with an
explicit user-only DACL, and the design forbids relying on the default DACL, which lets Everyone
read. The agent therefore serves no IPC on win32, and Windows clients cannot reach it until a
native helper or a reviewed alternative lands. `restore` is deferred; the error codes
`UNKNOWN_BACKUP` and `BACKUP_PRUNED` are reserved for it.

## Considered options

- The token over the default DACL: a same-machine user could squat the pipe name and harvest
  tokens from clients that connect to it.
- A loopback TCP port: reachable from browsers (ADR 0011).
- A native helper that creates the pipe: the right fix, but a new binary to build and ship.

## Consequences

- On Windows the agent still applies by policy, and `agent status`, `review`, `resume` and
  `policy` report it as unreachable; the CLI works in-process there.
- The shutdown path on every OS stays the service manager's stop (ADR 0018); `shutdown` exists
  over the socket as well. App upgrades wait for idle and request socket shutdown before
  restarting the service; explicit recovery can use its service manager when IPC is unreachable.
- A desktop window closing disconnects its socket without sending `shutdown`.
- Adding Windows IPC is a transport change: the protocol and token stay as they are.
