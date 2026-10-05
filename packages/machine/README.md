# @nortuscc/machine

Inspects a machine, plans changes against the profile engine's `DesiredConfig`, and executes
plans with backups, progress and cancellation. The CLI and the desktop app both use it.
Design: `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`.

- `pathsFromEnvironment` is the only reader of the environment; everything else takes
  `MachinePaths`.
- A domain (`config`, `integrations`, `skills`) implements `Domain<R>`: `inspect`, `steps(items, selection, kind, desired)`,
  and `run(step, report)`, which receives the report the plan was made from. `inspect`, `plan` and
  `execute` accept domains needing different services; the requirement is their union.
- `integrationsDomain({ paths, env, installerOutput })` installs hooks, marketplaces, plugins and MCP for Claude and
  Codex from `DesiredConfig.integrations`. Installers run through `Processes` as interruptible steps;
  pass `installerOutput: 'capture'` where stdout is a protocol channel (the desktop backend).
  Build its `paths` from the same `pathsFromEnvironment` value as the `MachinePaths` layer, and pass the environment MCP prerequisites are checked against (the desktop backend: the login shell's, not its own).
- `inspect` → `plan` → `execute(plan, report, domains, { signal })`. `execute` holds
  `<stateRoot>/apply.lock`, emits `Progress`, never interrupts a step marked
  `interruptible: false`, and ends with `done` or `cancelled`. Provide a fresh `backupsForRun()`
  layer per execution; within a run the first backup of a path wins.
- `samePlan(a, b)` compares plans structurally, so a domain's `steps` must be deterministic.
- Cancelling: aborting `signal` is the graceful path — the current file step finishes, an
  interruptible step is interrupted, and the stream ends with `cancelled`. Interrupting the
  stream's fiber from outside also stops the run (finalizers run and the lock is released) but
  emits no further events.

Node 24+ runs the sources directly; Node will not strip types under `node_modules`, so consume
the package through the workspace.

    npm test -w packages/machine
    npm run typecheck -w packages/machine
