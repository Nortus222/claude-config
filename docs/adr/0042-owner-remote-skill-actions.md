---
status: accepted
---

# The owner's remote skill actions count as a person acting at the target

Clarifies ADR 0012 and amends ADR 0032. A user manages skills across their own machines from
whichever one they are on: the desktop app, the CLI and coding agents through the bundled MCP all
call the local agent's fan-out operations (`myMachines`, `machineSkills`, `applySkillOnMachines`,
`machineRun`), which reach each other machine's listener over Tailscale (ADR 0041) and run there as
the `remote` actor naming the calling machine and what started the change there (app, CLI or MCP). Once a person at the target turned remote access on,
a request from that person's own Tailscale identity counts as that person acting at the target, so
a remote install or remove previews and applies at once, with no review prompt, like clicking the
button there; it is still a normal run with backups and a History entry on the target, removal is
still the owned disable only (ADR 0034) and pinned installs are still verified (ADR 0014).
Scheduled auto-apply is unchanged: it still applies only proven-inert items. This drops ADR 0032's
"without granting remote installation permission" for these operations: a coding agent may install
skills on the user's other machines when the user asks it to. Nothing is queued for a machine that
cannot be reached.

## Considered options

- Holding remote installs for review on the target: the user is the reviewer and is not at that
  machine, so every change would wait for a second visit and the grid could not show results.
- Allowing only the desktop app to start remote changes: the owner wants the CLI and coding agents
  to manage machines too, through the same operations.

## Consequences

- Accepted risk (owner): whatever drives a coding agent, or any process, on one of the user's
  machines can install or remove skills, including bundled scripts, on every machine of theirs that
  has remote access on, without review there.
- Only a person at a machine turns remote access on or off; MCP and remote callers are refused.
- Retrying a fan-out with the same caller request ID reaches the same runs on each machine.
