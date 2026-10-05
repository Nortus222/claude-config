# Machine rebuild: one TypeScript core for the CLI and the desktop app

Issue #42 (tracking). Builds on the profile engine (#41) and the Bun-backed desktop app (#39,
#45). #43 builds machine sync on the result.

## Intent and scope

Apply resolved profiles to real machines from both the CLI and the desktop app, through one
implementation. #42 first asked only to move `apply`, `status` and `uninstall` onto the engine
and make the app real. It is widened deliberately: the CLI is rebuilt in TypeScript on a shared
`@nortuscc/machine` package, so the app and the CLI inspect, plan and change a machine through
the same code instead of the app shelling out to a CLI it cannot type-check.

Done when:

- every CLI command runs on `@nortuscc/machine` and the profile engine, with its commands,
  flags, exit codes, `state.json` and backup layout unchanged, and the legacy `.mjs` is gone;
- the packaged desktop app inspects this machine, previews a plan, applies it, including skills
  and integrations, backs up before every destructive change, and can cancel;
- the renderer still cannot choose a path or a command (#39).

Out of scope: editing overrides from the app, machine sync and recording applied revisions
(#43), and platforms other than macOS for the app.

## Decisions settled here

The engine spec left three decisions to #42.

1. **Overrides storage.** A machine's `MachineOverrides` live in `<stateRoot>/overrides.json`
   (`~/.config/nortuscc/overrides.json` by default), `{ "version": 1, … }`, decoded by the
   engine's `decodeOverrides`. `state.json` keeps tool bookkeeping only: `repo` and baselines.
   Overrides are user intent that #43 will sync and the app will show; baselines are not.
2. **Loading TypeScript.** The repository becomes an npm-workspaces monorepo on Node 24 or
   later, which strips types without flags. There is no build step. The zero-dependency rule is
   retired; `effect` (pinned, shared) is the one runtime dependency. Tests stay on `node:test`.
   Node will not strip types under `node_modules`, which the bootstrap below handles.
3. **`SYNC`.** The duplicate table is deleted. The engine's `FILES`, resolved into
   `DesiredConfig.files`, is the only table of managed files. It is kept as JSON
   (`packages/profile-engine/src/files.json`) so the legacy commands read the same table from an
   `npx` copy until cutover (#59), and `src/manifest.mjs` keeps a field-renaming adapter over
   `files.json` until then. The CLI's other duplicate parsers (`integrations.json`,
   `skills-manifest.txt`, `settings.keys.json`) go too; the engine is their only reader.

## Layout

| Package | Role |
| --- | --- |
| `packages/profile-engine` (exists) | Desired state: base profile, pins and overrides resolved to `DesiredConfig` with provenance. Reads configuration only. |
| `packages/machine` (new, `@nortuscc/machine`) | Actual state and change: inspect a machine, plan against `DesiredConfig`, execute with backups, progress and cancellation. All filesystem and process access goes through injected services. |
| root `nortuscc` (rewritten, `src/*.ts`) | Argument parsing, prompts and the select picker, text reports. |
| `apps/desktop` (joins the workspace) | The Bun backend imports `@nortuscc/machine` in-process, bundled by esbuild. The renderer shows inspect, preview and apply. |

Dependencies point one way: CLI and app → machine → engine. The engine never sees a machine.

Sources are erasable-syntax TypeScript with `.ts` import extensions, as in the engine. The
machine package uses `node:` builtins behind its services, not `@effect/platform-*`, so it runs
unchanged on Node 24 and on the app's bundled Bun, and avoids `effect`'s unstable modules.

### Bootstrap

`bin/nortuscc.mjs` becomes a small, dependency-free JavaScript launcher:

- From a git checkout it imports `src/main.ts`. The global command is a link into the
  checkout (`npm install --global <checkout>`), so this is the everyday path, and its real
  path is outside `node_modules`.
- From an `npx github:Nortus222/claude-config` copy, which lives under `node_modules`, it does
  only engine-free work, then hands off:
  - `setup` clones the checkout, runs `npm ci` in it, links the global command, and re-execs
    `<checkout>/bin/nortuscc.mjs` with the same arguments;
  - any other command re-execs the checkout recorded in `state.json`, or says to run `setup`.

A global install of a folder links it without installing its dependencies, so the launcher
installs the runtime dependencies itself when a checkout has none, and `pull` re-installs them
when `package-lock.json` changed. npm's output goes to stderr. If that install fails, an unported
command still runs its legacy module, which needs no runtime dependency; a ported one exits 1.

During the migration only TypeScript commands need the handoff: an unported command is plain
JavaScript and still runs from an `npx` copy, as today. The launcher re-execs the recorded
checkout for ported commands only. `setup`'s clone-then-hand-off flow arrives with its cutover.

## `@nortuscc/machine`

Three phases over one item model. The domains are **config** (copied files and settings keys),
**integrations** (hooks, marketplaces, plugins and MCP for Claude and Codex) and **skills**,
plus a probe for undeclared items.

### Inspect

`inspect(desired)` returns `Effect<MachineReport>`. A report is a list of `Observed` items,
plus undeclared items and probe failures such as "Codex state unreadable":

```ts
type Observed = {
  key: string          // stable, as today: config:claude:CLAUDE.md,
                       // config:claude:settings.json#model, integration:<id>, skill:<name>
  domain: 'config' | 'integrations' | 'skills'
  target: Target
  label: string
  group: string
  state: string        // the domain's existing vocabulary, unchanged
  disposition: 'in-sync' | 'apply' | 'capture' | 'blocked' | 'excluded' | 'undeclared'
  note?: string
  from?: Origin        // provenance from the engine
  facts?: string[]     // read only by the owning domain's steps
}
```

`state` keeps each domain's existing values. Files use `clean`, `repo-ahead`, `local-ahead`,
`conflict`, `unmanaged`, `missing-repo`, `unparseable-local` and `invalid`. Integrations use
`installed`, `missing`, `blocked` and `unknown` (an agent's CLI could not say). Skills use `ok`, `missing`, `extra` and `local`.
`disposition` is the one cross-domain verdict. Status, the picker and the app read it, and
exit codes derive from it. An `unknown` integration is `blocked`, so it never becomes a step, but a dirty
count for an exit code leaves it out, as `status` does today: re-running apply cannot repair it.

### Plan

`plan(kind, report, selection, domains)` is pure, for `kind` `apply`, `uninstall` or `capture`. It takes a report and a `Selection`,
and returns a `Plan`:

- `Selection` holds the run-time choices the engine deliberately does not resolve: targets,
  the `--no-*` categories, picked or excluded keys, and `force` (`--take-repo`).
- `Plan` is `{ kind, steps, skipped: { key, reason }[] }`.
- A `Step` is `{ key, domain, action, summary, touches: string[], interruptible: boolean }`. Its
  `action` is one of `write-file`, `merge-keys`, `restore`, `remove`, `capture-file`,
  `write-manifest`, `install-integration` or `install-skills`.

A blocked item never becomes a step. It is listed in `skipped` with its reason, so a preview
shows exactly what will and will not happen.

### Execute

`execute(plan, report, domains, { signal })` returns `Stream<Progress>`. It is the only
executor, for every plan kind, and passes each domain's `run` the report the plan came from.

- It holds `<stateRoot>/apply.lock` for the whole run, so the CLI and the app never change a
  machine concurrently. A held lock fails the run before any step.
- Each step emits `started`, then `finished { ok, note }`. A failed step is a result, not an
  exception, and later steps still run, as `runIntegrations` does today.
- A file step is an uninterruptible unit. It backs up into this run's backup folder, writes
  atomically, and persists its `state.json` baseline before the next step starts. A cancelled
  run's bookkeeping therefore always matches its files.
- A process step (an installer) is interruptible. Interrupting it kills the child's process
  group, and the step finishes `cancelled`.
- Cancellation is Effect interruption. It lands between steps or inside an interruptible step,
  and the stream ends with `cancelled`. The CLI maps SIGINT to it; the app maps its `cancel`
  request to it, through the `signal`. Interrupting the stream itself also stops a run and
  releases the lock, but emits no further events.
- `samePlan(a, b)` compares two plans structurally, so a preview can tell it is stale; a
  domain's `steps` must therefore be deterministic (no timestamps in summaries).

### Services

All are injected. Tests use temporary directories and fake executables.

- `MachinePaths`: `repo`, `claude`, `codex`, `codexOpenRouter`, `agentsSkills`, `stateRoot`,
  `backups`. Only the CLI entry point and the app backend build it, both through
  `MachinePaths.fromEnvironment`, which keeps today's `NORTUSCC_*`, HOME and `state.json`
  `repo` rules. No module below them reads the environment, so a test can no longer write into
  the checkout by forgetting a variable, as the `skills-manifest.txt` leak did.
- `Fs`: reads, atomic writes (a symlink stays a link and a file keeps its mode), copy, move,
  remove, `list`, `stat` (lstat), `readLink` and `symlink` over `node:fs`.
- `Processes`: argv only, never a shell; inherit or capture output; abortable.
- `StateStore` (`state.json`), `OverridesStore` (`overrides.json`) and `Backups`: one
  `nortuscc-<stamp>` folder per run, in today's layout. The first backup of a path in a run
  wins; a repeat never overwrites it.

### Domains

Each domain implements:

```ts
type Domain<R> = {
  name: 'config' | 'integrations' | 'skills'
  inspect: (desired: DesiredConfig) => Effect<{ items: Observed[]; probeErrors: string[] }, never, R>
  steps: (items: Observed[], selection: Selection, kind: 'apply' | 'uninstall' | 'capture', desired: DesiredConfig) =>
    { steps: Step[]; skipped: { key: string; reason: string }[] }
  run: (step: Step, report: MachineReport) => Effect<StepResult, unknown, R>
}
```

`inspect`, `plan` and `execute` take the domain array generically, so domains needing different
services mix and the run requires their union. A failed step's note is its error's message (each
package error states one), else its tag.

`plan` passes each domain's `steps` the report's `desired`, because an observed item does not carry its
declaration (the integrations domain needs a declaration's type and installer command).

The three domains and the undeclared-items probe are the units the parallel issues build.

## CLI

`src/main.ts` dispatches commands. Each command parses its flags into a `Selection`, builds
`MachinePaths.fromEnvironment()`, runs inspect, plan and execute, and renders the report and
progress as text rows.

Preserved: commands and flags; exit codes (0 clean, 1 dirty or refused, 2 usage); the picker
and prompts; the `state.json` and backup layouts; setup's flow; and text output wherever a test
asserts it. SIGINT cancels gracefully. There is no `--json` mode, because the app uses the
library in-process.

`--skills-only`, `--no-skills-only` and setup's target choice write `overrides.json`.

## Desktop app

### Backend

The Bun backend builds `MachinePaths` from HOME and `state.json`'s `repo`, exactly as the CLI
does. Rust passes it no paths.

At startup the backend reads PATH once from the user's login shell, running `$SHELL -ilc` with a
fixed argv and a timeout, so `npx`, `claude` and `codex` resolve as in a terminal. A missing
tool is a probe failure in the report, not a crash.

### Protocol v2

Still JSON lines, strict, with an allow-list on both the Rust and backend sides.

| Request | Result |
| --- | --- |
| `inspect` | the `MachineReport` |
| `preview { exclude: key[] }` | `{ planId, plan }` |
| `apply { planId }` | `{ status: 'started', runId }` at once, then progress events ending in `done`, `cancelled` or `failed`; or `{ status: 'stale', planId, plan }` |
| `cancel`, `shutdown` | as today |

The renderer sends only opaque item keys taken from the report, and the backend checks them
against it. The renderer never sends a path or a command. `apply` re-inspects and re-plans
first. If the plan differs from the previewed one, nothing runs and the result is
`{ status: 'stale', planId, plan }`: the new preview, returned as a result rather than an error
code, so the app only applies what the user saw. The record cap rises from 16 KB to 1 MiB,
and timeouts become per-command, because inspect can take seconds.

### Renderer

The "Fixture Lab" screen becomes:

- a profile panel: repo checkout, revision and overrides file;
- an **Inspect** table grouped by domain, with state, disposition and provenance;
- a **Preview** of steps, plus skipped items with reasons;
- an **Apply** with per-step progress and Cancel, ending with the run's backup folder.

Items can be deselected before previewing. The fixture code, its smoke assertions and its Rust
tests are replaced. Rust tests and the packaged smoke run against a temporary HOME passed
through the environment.

## Migration

The migration is a strangler, so `main` keeps working throughout:

- `src/main.ts` routes each command to its TypeScript implementation once that is ported, and
  to the existing `src/commands/*.mjs` until then. Legacy modules and their tests are deleted
  at cutover.
- `state.json` keeps its format the whole time.
- `overrides.json` is first written by copying `skillsOnly` and `configTargets`, not moving
  them, because unported commands still read `state.json`. Cutover removes the legacy fields.

## Issues

#42 tracks the work. It is split into six sub-issues.

| # | Issue | Depends on | Runs |
| --- | --- | --- | --- |
| 1 | **Foundation**: workspaces, Node 24 floor, root TypeScript test and typecheck tooling, the bootstrap launcher (checkout detection, runtime-dependency install, re-exec of the recorded checkout for ported commands), the `@nortuscc/machine` skeleton (services, `MachinePaths`, stores and overrides migration, `Backups`, `apply.lock`, the item and plan model, executor with cancellation, the domain interface), `main.ts` dispatch, and `CLAUDE.md` conventions for the new layout (parallel threads read them) | — | first |
| 2 | **Config domain**: copy, merge-keys, project trust, file states; apply, uninstall and capture-file steps; `SYNC` retired; `uninstall` cut over | 1 | parallel |
| 3 | **Integrations domain**: hooks, marketplaces, plugins and MCP for Claude and Codex, from the engine's declarations | 1 | parallel |
| 4 | **Skills domain and undeclared probe**: the skills CLI, links and exposure, updates, `write-manifest` with an explicit repo; `update` cut over | 1 | parallel |
| 5 | **Desktop real apply**: protocol v2, backend on `@nortuscc/machine`, the PATH probe, the renderer, a real-machine smoke against a temporary HOME | 1; complete once 2–4 land | parallel |
| 6 | **Cutover**: `apply`, `status`, `capture`, `setup` (with its clone-then-hand-off bootstrap), `pull`, `push` and the self-update; delete the legacy `.mjs`; final `README.md` pass | 2, 3, 4 | last |

Issues 2–5 branch from the Foundation branch once its PR is open, each in its own worktree and
thread. Their PRs stack on Foundation and retarget to `main` when it merges.

## Testing

- **Parity harness:** black-box tests that run the real `bin/nortuscc.mjs` with every
  `NORTUSCC_*` path in temporary directories. A command cuts over only when its black-box
  tests pass both before and after.
- **Domain tests:** `packages/machine/checks/*.spec.ts`, ported from today's unit tests, against
  temporary directories and fake executables.
- **Desktop:** the backend's stdio spec on a temporary HOME, the Rust tests, and the packaged
  smoke run.
- **Foundation checks:** that root `node --test` discovers `.ts` tests, and that the bootstrap
  works end to end through `npm pack` and a global install.
