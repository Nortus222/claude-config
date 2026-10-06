# @nortuscc/machine

Inspects a machine, plans changes against the profile engine's `DesiredConfig`, and executes
plans with backups, progress and cancellation. The CLI and the desktop app both use it.
Decision: `docs/adr/0007-one-machine-core-for-cli-and-desktop.md`.

- `pathsFromEnvironment` is the only reader of the environment; everything else takes
  `MachinePaths`.
- A domain (`config`, `integrations`, `skills`) implements `Domain<R>`: `inspect`, `steps(items, selection, kind, desired)`,
  and `run(step, report)`, which receives the report the plan was made from. `inspect`, `plan` and
  `execute` accept domains needing different services; the requirement is their union.
- `integrationsDomain({ paths, env, installerOutput })` installs hooks, marketplaces, plugins and MCP for Claude and
  Codex from `DesiredConfig.integrations`. Installers run through `Processes` as interruptible steps;
  pass `installerOutput: 'capture'` where stdout is a protocol channel (the desktop backend).
  Build its `paths` from the same `pathsFromEnvironment` value as the `MachinePaths` layer, and pass the environment MCP prerequisites are checked against (the desktop backend: the login shell's, not its own).
- `Observed.target` is absent for agent-neutral items (shared skills); `Step.targets` names the agents
  an installer step acts for. `update` is a plan kind of its own (adopt, refresh, prune skills).
- `skillsDomain` inspects the shared skill store and each agent's exposure as items, and plans apply
  and update steps. `write-manifest` writes only under `MachinePaths.repo`. Skills steps name their
  skills in `touches` as `skills/<name>`. `inspectUpdates` is the upstream check.
- `probeUndeclared(desired, { targets, installed, hookCommands })` reports what is present but
  undeclared. It reads agents, skill links and hooks; plugin and marketplace observations and
  declared hook commands are inputs from the integrations domain.
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
- Migration rule until cutover (#59): anything that writes `overrides.json` must also write `state.json`'s `skillsOnly`/`configTargets`, and the legacy `writeLock` mirrors `state.json` into an existing `overrides.json`.
- `HistoryStore` appends one JSON line per event to `<stateRoot>/history/<YYYY-MM>.jsonl` and skips
  torn lines; `DecisionsStore` keeps the current accept or skip per setup and item in
  `decisions.json`; `pruneBackups` removes run folders older than 90 days outside the newest 20,
  never the latest one History references, and History then reads those applies as `backup: 'pruned'`.

Node 24+ runs the sources directly; Node will not strip types under `node_modules`, so consume
the package through the workspace.

    npm test -w packages/machine
    npm run typecheck -w packages/machine
