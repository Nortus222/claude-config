# @nortuscc/agent

The local agent (#77, #79): keeps a machine on its apply policy while no window is open, as a
per-user login service. Decisions: `docs/adr/0011-local-agent-per-user-login-service.md`,
`docs/adr/0012-auto-apply-only-provably-inert-items.md` and
`docs/adr/0018-agent-service-stopped-by-its-service-manager.md`.

- `startAgent(domains)` runs the scheduler: one job at a time, and triggers that arrive during a
  job coalesce into one follow-up. `runAgent({ paths, domains, source })` builds every service from
  `paths` and runs until interrupted.
- A job refreshes through `SetupSource` (machine sync's contract, owned by `@nortuscc/sync`, whose
  `setupSourceLayer(paths)` is the real one; tests fake it), resolves
  `effective(decisions)`, inspects, sorts pending items from drift, classifies, and acts by policy
  (`auto-apply`, `notify`, `manual`). Drift is never auto-applied.
- `classify` fails closed: only instruction markdown and the settings keys in `INERT_KEYS` are
  inert. Every skill and integration is held. Adding a key to `INERT_KEYS` is a reviewed change
  with its own test row.
- Auto-apply runs only `write-file` and `merge-keys` steps, under `apply.lock`, bracketed in
  History. A failed, refused or interrupted run pauses auto-apply until a person resumes it.
- State: `<stateRoot>/agent/agent.json` (policy, pause) and `agent/setups.json` (trusted setups — its store lives in @nortuscc/sync).
  Decisions and History live in `@nortuscc/machine`.
- `src/service/` renders the LaunchAgent, `systemd --user` unit and Scheduled Task, and
  `installService`, `uninstallService` and `restartService` register them through `Processes`.
- IPC (#78, `docs/adr/0019-agent-ipc-unix-socket-only-for-now.md`): the agent serves protocol v3 on
  `<stateRoot>/agent/agent.sock`, after a `hello` carrying the per-start token in `agent.token`.
  Person-initiated inspect, preview and apply run inside the agent. Windows serves no IPC yet.
  `history` takes `limit` from 1 to 500 and an optional exclusive `before: { at, seq }` cursor.
  `at` is an ISO timestamp; `seq` is a nonnegative safe integer assigned by append order within
  that exact millisecond, starting at zero. Events sort by timestamp then sequence, both newest
  first. Equivalent ISO offsets share a sequence bucket. The reply is `{ events, nextBefore }`;
  pass `nextBefore` to retrieve older events, or stop when it is `null`. Reply cursors use UTC
  timestamps. Events keep their existing History values and stored format. Cursors assume
  append-only History: hand editing or removing events can invalidate them. Backup pruning only
  annotates events and preserves their positions within each timestamp bucket.
- `nortuscc agent install [--linger] | uninstall | run` drives it; `agent status | review | resume | policy` talk to the running
  agent; `npm run smoke:agent` with `NORTUSCC_SMOKE=1` registers a throwaway LaunchAgent on a Mac and checks `hello` (`smoke/launchd.smoke.ts`).
