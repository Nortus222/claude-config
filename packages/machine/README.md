# @nortuscc/machine

Inspects a machine, plans changes against the profile engine's `DesiredConfig`, and executes
plans with backups, progress and cancellation. The CLI and the desktop app both use it.
Design: `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`.

- `pathsFromEnvironment` is the only reader of the environment; everything else takes
  `MachinePaths`.
- A domain (`config`, `integrations`, `skills`) implements `Domain<R>`: `inspect`, `steps`, and
  `run(step, report)`, which receives the report the plan was made from. `inspect`, `plan` and
  `execute` accept domains needing different services; the requirement is their union.
- `inspect` → `plan` → `execute(plan, report, domains, { signal })`. `execute` holds
  `<stateRoot>/apply.lock`, emits `Progress`, never interrupts a step marked
  `interruptible: false`, and ends with `done` or `cancelled`. Provide a fresh `backupsForRun()`
  layer per execution; within a run the first backup call for a path decides, including that the path was absent.
- `samePlan(a, b)` compares plans structurally, so a domain's `steps` must be deterministic.
- Cancelling: aborting `signal` is the graceful path — the current file step finishes, an
  interruptible step is interrupted, and the stream ends with `cancelled`. Interrupting the
  stream's fiber from outside also stops the run (finalizers run and the lock is released) but
  emits no further events.
- The config domain (`configDomain`) owns copied files and settings keys from `DesiredConfig.files`. Its items carry `facts` that only its `steps` reads (`recorded`, `local-changed`, `local-absent`, `baseline-stale`). A step re-reads its file and fails, writing nothing, if the file's state moved since the report. Uninstall restores the earliest run's backup of each recorded file.

Node 24+ runs the sources directly; Node will not strip types under `node_modules`, so consume
the package through the workspace.

    npm test -w packages/machine
    npm run typecheck -w packages/machine
