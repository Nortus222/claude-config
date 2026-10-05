# @nortuscc/machine

Inspects a machine, plans changes against the profile engine's `DesiredConfig`, and executes
plans with backups, progress and cancellation. The CLI and the desktop app both use it.
Design: `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`.

- `pathsFromEnvironment` is the only reader of the environment; everything else takes
  `MachinePaths`.
- A domain (`config`, `integrations`, `skills`) implements `Domain`: `inspect`, `steps`, `run`.
- `inspect` → `plan` → `execute`. `execute` holds `<stateRoot>/apply.lock`, emits
  `Progress`, never interrupts a step marked `interruptible: false`, and ends with `done` or
  `cancelled`. Provide a fresh `backupsForRun()` layer per execution.

Node 24+ runs the sources directly; Node will not strip types under `node_modules`, so consume
the package through the workspace.

    npm test -w packages/machine
    npm run typecheck -w packages/machine
