---
status: accepted
---

# Until IPC exists, the service manager's stop is the agent's shutdown

The login service (#79) lands before the agent's IPC (#78), so there is no `shutdown` request and
no `hello` to ask a running agent anything. The service manager's own stop (SIGTERM from launchd
or systemd) is therefore the agent's shutdown: `agent uninstall` and the restart after a pull rely
on it, and `agent run` turns the signal into `runAgent`'s abort, so a running auto-apply stops at
its next step and records `cancelled`. Liveness is the agent's single-instance `agent.lock` until
`hello` exists, and trust is recorded by `agent install`, never on start. This keeps the service
usable now with the stop path every OS already provides, without a stand-in protocol that #78
would replace.

## Considered options

- Waiting for IPC before shipping the service: accepted items would keep waiting for an open app.
- A stop file the agent polls: a second shutdown path that IPC would make redundant.
- Trusting the checkout whenever the agent starts: a restart would grant trust no person gave.

## Consequences

- On Windows, `schtasks /End` terminates without a signal, so an interrupted auto-apply pauses:
  safe, by ADR 0011.
- The Windows task carries no environment, so `NORTUSCC_*` overrides do not reach it.
- The Windows task may show a console window at logon; closing it stops the agent.
- Task Scheduler cannot redirect output, so nothing writes `agent.log` on Windows.
- Task Scheduler's restart-on-failure may not restart an agent that exits non-zero, so it can stay
  down until the next logon.
- Task Scheduler may expand `%VAR%` in the task's arguments.
- On every OS the unit pins the absolute node path (`process.execPath`), so removing that Node
  version (nvm, fnm) breaks the service until `agent install` or a sync restarts it.
- `agent.log` is not rotated yet.
- #78 replaces the signal with `shutdown` and the lock with `hello`.
