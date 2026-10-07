---
status: accepted
---

# The service manager's stop is the agent's shutdown

The login service (#79) landed before the agent's IPC (#78), so it had no `shutdown` request and
no `hello`. IPC has since landed (ADR 0019), but the service manager's own stop (SIGTERM from
launchd or systemd) stays the agent's shutdown: `agent uninstall` and the restart after a pull
rely on it, and `agent run` turns the signal into `runAgent`'s abort, so a running auto-apply
stops at its next step and records `cancelled`. Liveness is the agent's single-instance
`agent.lock` or `hello`, and trust is recorded by `agent install`, never on start. The stop path
every OS already provides works when the agent is wedged and where it serves no IPC (Windows).

## Considered options

- Waiting for IPC before shipping the service: accepted items would keep waiting for an open app.
- A stop file the agent polls: a second shutdown path that IPC would make redundant.
- Trusting the checkout whenever the agent starts: a restart would grant trust no person gave.

## Consequences

- On Windows, `schtasks /End` terminates without a signal, so an interrupted auto-apply pauses:
  safe, by ADR 0011.
- The Windows task carries no environment, so `NORTUSCC_*` overrides do not reach it.
- The Windows task wraps Node with `%SystemRoot%\System32\conhost.exe --headless`, so the agent
  has no visible console window. Task Scheduler expands environment variables in its executable
  path, as documented by [Microsoft](https://learn.microsoft.com/en-us/windows/win32/taskschd/execaction).
- Task Scheduler cannot redirect output. On Windows the agent captures stdout and stderr into
  `agent.log` after acquiring `agent.lock`, unless stdout is already a regular redirected file.
  Scope closure restores the writers and closes the append descriptor.
- The task retains `RestartOnFailure`, but `conhost --headless` does not propagate the child's
  non-zero exit status ([microsoft/terminal#17178](https://github.com/microsoft/terminal/issues/17178)).
  It cannot promise recovery from a Node failure; the agent can stay down until the next logon.
  We accept that limitation instead of adding a supervisor or a native binary. Native Windows
  service behavior remains unverified locally.
- Task Scheduler may expand `%VAR%` in the task's arguments.
- On every OS the unit pins the absolute node path (`process.execPath`), so removing that Node
  version (nvm, fnm) breaks the service until `agent install` or a sync restarts it.
- While holding `agent.lock`, the agent checks `agent.log` at startup and every 60 seconds,
  copies and truncates at 1 MiB, and keeps three archives (ADR 0020).
- `hello` over the socket now proves the agent is serving, and `shutdown` exists there (ADR 0019),
  but the service-manager stop stays the path for `agent uninstall` and restarts: it works when the
  agent is wedged or serves no IPC (Windows). `agent.lock` still guards the single instance.
