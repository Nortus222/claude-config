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
- `nortuscc agent install [--linger] | uninstall | run` drives it; `npm run smoke:agent` with
  `NORTUSCC_SMOKE=1` registers a throwaway LaunchAgent on a Mac (`smoke/launchd.smoke.ts`).
