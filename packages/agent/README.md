# @nortuscc/agent

The local agent's core (#77): keeps a machine on its apply policy while no window is open.
Decisions: `docs/adr/0011-local-agent-per-user-login-service.md` and
`docs/adr/0012-auto-apply-only-provably-inert-items.md`.

- `startAgent(domains)` runs the scheduler: one job at a time, and triggers that arrive during a
  job coalesce into one follow-up. `runAgent({ paths, domains, source })` builds every service from
  `paths` and runs until interrupted.
- A job refreshes through `SetupSource` (#43's contract, faked in tests), resolves
  `effective(decisions)`, inspects, sorts pending items from drift, classifies, and acts by policy
  (`auto-apply`, `notify`, `manual`). Drift is never auto-applied.
- `classify` fails closed: only instruction markdown and the settings keys in `INERT_KEYS` are
  inert. Every skill and integration is held. Adding a key to `INERT_KEYS` is a reviewed change
  with its own test row.
- Auto-apply runs only `write-file` and `merge-keys` steps, under `apply.lock`, bracketed in
  History. A failed, refused or interrupted run pauses auto-apply until a person resumes it.
- State: `<stateRoot>/agent/agent.json` (policy, pause) and `agent/setups.json` (trusted setups).
  Decisions and History live in `@nortuscc/machine`.
