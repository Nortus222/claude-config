# Machine Rebuild Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the base the TypeScript machine rebuild builds on: an npm-workspaces monorepo on Node 24, the `@nortuscc/machine` skeleton (services, stores, backups, apply lock, item and plan model, executor with cancellation), and a launcher that routes commands to TypeScript or legacy code (issue #54).

**Architecture:** `@nortuscc/machine` is a new erasable-syntax TypeScript package beside `@nortuscc/profile-engine`. Every filesystem and process access goes through Effect services, built over `node:` builtins so the same code runs on Node 24 and on the desktop app's bundled Bun. `bin/nortuscc.mjs` stays plain JavaScript. From a git checkout it imports `src/main.ts`, which sends a command to its TypeScript port when one exists and to the legacy `src/commands/*.mjs` otherwise. From an `npx` copy it re-execs the recorded checkout for ported commands only.

**Tech Stack:** Node ≥ 24 (native type stripping), TypeScript 7.0.2 (`tsc --noEmit` only), `effect` 4.0.1, `node:test` + `node:assert/strict`, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`

## Global Constraints

- **Node:** `engines.node` is `>=24` everywhere: the root, the engine, the machine package and the desktop app.
- **Runtime dependency:** `effect` exactly `4.0.1`. No other runtime dependency is added.
- **Dev dependencies:** `typescript` exactly `7.0.2` and `@types/node` exactly `25.5.0`.
- **TypeScript syntax:** sources are erasable-syntax TypeScript with `.ts` relative import extensions. Use no `enum`, no `namespace`, and no parameter properties.
- **Builtins:** use `node:`-prefixed imports.
- **Tests:**
  - `node:test` and `node:assert/strict` only.
  - Package tests live in `packages/<name>/checks/*.spec.ts`.
  - Root CLI tests live in `test/*.test.{mjs,ts}`.
- **Processes:** child processes take an argv array, never a shell string.
- **Formats:**
  - The `state.json` format, the backup layout (`<stateRoot>/backups/nortuscc-<stamp>/<agent>/<relative>`) and the state keys (`<target>:<dest>`, `<target>:<dest>#<key>`) stay byte-compatible with the legacy CLI.
  - `overrides.json` is `{ "version": 1, … }`, decoded by the engine's `decodeOverrides`.
  - Until cutover (#59), writing overrides never removes `skillsOnly` or `configTargets` from `state.json`.
- **No environment reads below the boundary:** nothing below `pathsFromEnvironment` reads `process.env` or `os.homedir()`.
- **Commits:** commit after every task, with conventional-commit prefixes.
- **The `skills-manifest.txt` leak:** after **every** root `npm test` run, run `git status --short`. If `skills-manifest.txt` changed, restore it with `git checkout -- skills-manifest.txt` and never commit that change.

## Review Focus

1. **A fresh `git clone` with no `node_modules` runs `nortuscc status`.** Expect the launcher to install the runtime dependencies once, then run. It must not crash with "Cannot find package 'effect'", and it must not reinstall on every run (Task 7 tests `missingRuntime`).
2. **An `npx` copy runs a ported command while `state.json` records a repo that no longer exists.** Expect a clear "run setup" message and exit code 2. It must not exec a missing file (Task 7).
3. **A previous run crashed and left `apply.lock` behind.** Expect the next run to take the lock over. It must not be blocked forever (Task 5).
4. **The abort signal fired before `execute` started.** Expect no step to run, a `cancelled` event listing every key, and the lock released (Task 6).
5. **`overrides.json` holds invalid JSON or an unknown field.** Expect empty overrides plus one machine-layer issue naming the file. It must not crash, and it must not silently fall back to the legacy `state.json` fields (Task 4).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` (modify) | Workspaces, Node 24, root dev tooling, test and typecheck scripts |
| `tsconfig.json` (create, Task 7) | Typecheck for root `src/**/*.ts` and `test/**/*.ts` |
| `packages/machine/package.json`, `tsconfig.json`, `README.md` | The package |
| `packages/machine/src/index.ts` | Public exports |
| `packages/machine/src/errors.ts` | `RepoNotFound`, `FsFailed`, `LaunchFailed`, `LockHeld` |
| `packages/machine/src/paths.ts` | `MachinePaths` service, `pathsFromEnvironment`, `homeDir` |
| `packages/machine/src/fs.ts` | `Fs` service and `nodeFs` layer |
| `packages/machine/src/processes.ts` | `Processes` service and `nodeProcesses` layer |
| `packages/machine/src/hash.ts` | `hashText` (CRLF-normalised sha256) |
| `packages/machine/src/state.ts` | `StateStore`: `state.json` read, write and legacy migration |
| `packages/machine/src/overrides.ts` | `OverridesStore`: `overrides.json` read and write, with legacy fallback |
| `packages/machine/src/backups.ts` | `Backups`: the per-run backup folder |
| `packages/machine/src/apply-lock.ts` | `acquireApplyLock`: exclusive, scoped, stale-takeover |
| `packages/machine/src/model.ts` | `Observed`, `Selection`, `Step`, `Plan`, `Progress`, `Domain` |
| `packages/machine/src/run.ts` | `inspect`, `plan`, `execute` |
| `packages/machine/checks/*.spec.ts` | One spec per source module |
| `bin/commands.mjs` (create) | `VERBS`, `PORTED`, `USAGE`, shared by the launcher and `main.ts` |
| `bin/launcher.mjs` (create) | Pure launcher decisions: `isCheckout`, `missingRuntime`, `recordedCheckout` |
| `bin/nortuscc.mjs` (rewrite) | Thin launcher: version check, usage, route or hand off |
| `src/main.ts` (create) | Dispatch to a TypeScript command or a legacy `.mjs` command |
| `test/launcher.test.mjs`, `test/main.test.ts` | Launcher and dispatch tests |
| `CLAUDE.md`, `README.md`, `setup.sh`, `setup.ps1` (modify) | Node 24 and the new conventions |

---

### Task 1: Workspaces, Node 24 and conventions

**Files:**
- Modify: `package.json`, `packages/profile-engine/package.json`, `apps/desktop/package.json`, `setup.sh:24-26,55,73`, `setup.ps1:30,58,70`, `CLAUDE.md`, `README.md` (development section near line 507), `apps/desktop/README.md` (install commands)
- Delete: `packages/profile-engine/package-lock.json`, `apps/desktop/package-lock.json`
- Create: `package-lock.json` (generated)

**Interfaces:**
- Produces:
  - Root `npm test`: the CLI suite.
  - `npm run test:packages`: every workspace's `test`.
  - `npm run typecheck`: every workspace's `typecheck`.
  - Workspace packages resolve by name through root `node_modules`, e.g. `@nortuscc/profile-engine`.

- [ ] **Step 1: Rewrite the root `package.json`**

```json
{
  "name": "nortuscc",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "description": "Keep a machine's Claude and Codex configuration, integrations and skill set in agreement with claude-config",
  "workspaces": ["packages/*", "apps/*"],
  "files": [
    "bin/",
    "setup.sh",
    "setup.ps1",
    "src/",
    "claude/",
    "codex/",
    "CLAUDE.md",
    "README.md",
    "integrations.json",
    "skills-manifest.txt"
  ],
  "bin": { "nortuscc": "./bin/nortuscc.mjs" },
  "scripts": {
    "test": "node --test --test-timeout=30000",
    "test:packages": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "dependencies": { "effect": "4.0.1" },
  "devDependencies": { "@types/node": "25.5.0", "typescript": "7.0.2" },
  "engines": { "node": ">=24" }
}
```

Workspace packages are deliberately **not** listed under `dependencies`. `npx github:…` installs the root as a dependency, and a named workspace dependency would make npm look for it on the registry. Inside a checkout, npm links the workspaces into root `node_modules` anyway.

- [ ] **Step 2: Align the workspace packages**

In `packages/profile-engine/package.json` and `apps/desktop/package.json`, set `"engines": { "node": ">=24" }`. Delete both per-package lockfiles:

```bash
git rm -q packages/profile-engine/package-lock.json apps/desktop/package-lock.json
rm -rf packages/profile-engine/node_modules apps/desktop/node_modules node_modules
npm install --no-audit --no-fund
```

Expected: one root `package-lock.json`. `ls node_modules/@nortuscc` lists `profile-engine` as a symlink, and `node_modules/nortuscc-desktop-validation` is a symlink.

- [ ] **Step 3: Verify the workspaces still pass**

Run: `npm run test:packages && npm run typecheck`
Expected: both workspaces' suites pass and typecheck is clean. If the desktop's `tsx` cannot be found, run it from the root `node_modules/.bin`. Workspaces hoist binaries there and npm puts that directory on PATH for scripts, so no script change should be needed.

- [ ] **Step 4: Raise the setup scripts to Node 24**

In `setup.sh`, change `>= 18` to `>= 24` on line 25, and `Node.js 18+` to `Node.js 24+` on lines 55 and 73. Make the same three changes in `setup.ps1` (lines 30, 58 and 70).

Run: `grep -rn "18" setup.sh setup.ps1 test/setup.test.mjs test/prerequisites.test.mjs src/prerequisites.mjs`
Expected: no remaining Node-version `18`. Update any test that asserted the old text.

- [ ] **Step 5: Rewrite `CLAUDE.md` Layout and Conventions for the new architecture**

Parallel threads read this file, so it must describe the new rules. Replace the `packages/profile-engine/` layout row and add rows for `packages/machine/` and `src/main.ts`:

```markdown
| `packages/profile-engine/` | Shared TypeScript/Effect engine that resolves a machine's desired configuration — base profile, revision pins, machine overrides — with per-value provenance |
| `packages/machine/` | Shared TypeScript/Effect package that inspects a machine, plans against the engine's desired configuration, and executes plans with backups, progress and cancellation. Used by the CLI and the desktop app |
| `src/main.ts`, `src/commands/` | The CLI. Ported commands are TypeScript; unported ones are legacy `.mjs` until #59 removes them |
```

Replace the Conventions list with:

```markdown
- npm-workspaces monorepo on **Node 24+**, which runs TypeScript directly: no build step.
  New code is erasable-syntax TypeScript with `.ts` import extensions; legacy `.mjs` is only
  edited, never added. The one runtime dependency is `effect` (pinned).
- Machine access goes through `@nortuscc/machine`'s services (`MachinePaths`, `Fs`,
  `Processes`, stores). Nothing below `pathsFromEnvironment` reads `process.env` or the home
  directory, so tests pass temporary paths explicitly.
- Use `node:`-prefixed builtin imports throughout.
- Test-first with `node:test` and `node:assert/strict`. Package tests are
  `packages/<name>/checks/*.spec.ts`; CLI tests are `test/*.test.{mjs,ts}`. Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Nothing destructive runs without a backup to `~/.config/nortuscc/backups/` first.
- Design: `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (#42).
```

Replace the Tests block with:

````markdown
```bash
npm ci              # once per checkout; installs every workspace
npm test            # the CLI suite (node --test)
npm run test:packages
npm run typecheck
```

`node --test test/` reports `pass 0 / fail 1` on Node 25 — pass no path and let
the runner find `test/` itself, exactly as `package.json` does. The root suite can
still rewrite `skills-manifest.txt` from this machine's skills; check `git status`
after a run and restore it.
````

- [ ] **Step 6: Update the README development section and the desktop README**

In `README.md`, replace the `npm test    # node:test, no dependencies` block with the same commands as above. In `apps/desktop/README.md`, replace any `npm ci` / `npm install` run inside `apps/desktop` with `npm ci` at the repository root, and keep the desktop scripts invoked as `npm run <script> -w apps/desktop`.

- [ ] **Step 7: Run the root suite**

Run: `npm test; git status --short`
Expected: the same pass count as before this task. Restore `skills-manifest.txt` if it changed.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json packages/profile-engine/package.json apps/desktop/package.json setup.sh setup.ps1 CLAUDE.md README.md apps/desktop/README.md test
git commit -m "chore: make the repository an npm-workspaces monorepo on Node 24"
```

---

### Task 2: `@nortuscc/machine` package and `MachinePaths`

**Files:**
- Create: `packages/machine/package.json`, `packages/machine/tsconfig.json`, `packages/machine/src/index.ts`, `packages/machine/src/errors.ts`, `packages/machine/src/paths.ts`
- Test: `packages/machine/checks/paths.spec.ts`

**Interfaces:**
- Consumes: `Target` from `@nortuscc/profile-engine`.
- Produces:

```ts
export type MachinePathsValue = {
  readonly repo: string
  readonly claude: string
  readonly codex: string
  readonly codexOpenRouter: string
  readonly agentsSkills: string
  readonly stateRoot: string
  readonly backups: string
}
export class MachinePaths extends Context.Service<MachinePaths, MachinePathsValue>()('machine/MachinePaths') {}
export const machinePaths: (value: MachinePathsValue) => Layer.Layer<MachinePaths>
export type PathsEnvironment = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home: string
  readonly platform: NodeJS.Platform
  readonly fallbackRepo?: string            // the CLI's own checkout; the desktop passes none
  readonly warn?: (message: string) => void
}
export const pathsFromEnvironment: (input: PathsEnvironment) => Effect.Effect<MachinePathsValue, RepoNotFound>
export const homeDir: (paths: MachinePathsValue, home: 'claude' | 'codex' | 'codex-openrouter') => string
export const isGitCheckout: (path: string | undefined) => boolean
export class RepoNotFound extends Data.TaggedError('RepoNotFound')<{ readonly recorded?: string }> {}
export class FsFailed extends Data.TaggedError('FsFailed')<{ readonly op: string; readonly path: string; readonly reason: string }> {}
export class LaunchFailed extends Data.TaggedError('LaunchFailed')<{ readonly cmd: string; readonly reason: string }> {}
export class LockHeld extends Data.TaggedError('LockHeld')<{ readonly path: string; readonly pid: number }> {}
```

These are the rules ported from `src/resolve.mjs`. The order is the contract:
- `repo`:
  1. `NORTUSCC_REPO_DIR`.
  2. Otherwise the `repo` field of `<stateRoot>/state.json`, falling back to the legacy `<claude>/.nortuscc-lock.json`, when it is a git checkout. A recorded path that is not a checkout produces one `warn` and falls through.
  3. Otherwise `fallbackRepo`.
  4. Otherwise fail with `RepoNotFound { recorded }`.
- `claude`: `NORTUSCC_CLAUDE_DIR` or `<home>/.claude`.
- `codex`: `NORTUSCC_CODEX_DIR` or `<home>/.codex`.
- `codexOpenRouter`: `NORTUSCC_OPENROUTER_CODEX_DIR`, else a `.codex-openrouter` sibling of `NORTUSCC_CODEX_DIR`, else `<home>/.codex-openrouter`.
- `agentsSkills`: `NORTUSCC_AGENTS_DIR` or `<home>/.agents/skills`.
- `stateRoot`: `NORTUSCC_STATE_DIR`, else `<APPDATA>/nortuscc` on win32, else `<home>/.config/nortuscc`.
- `backups`: `<stateRoot>/backups`.

- [ ] **Step 1: Create the package files**

`packages/machine/package.json`:

```json
{
  "name": "@nortuscc/machine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Inspects a machine, plans changes against a resolved profile, and executes them with backups, progress and cancellation",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "node --test \"checks/*.spec.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@nortuscc/profile-engine": "0.1.0", "effect": "4.0.1" },
  "devDependencies": { "@types/node": "25.5.0", "typescript": "7.0.2" },
  "engines": { "node": ">=24" }
}
```

`packages/machine/tsconfig.json`: copy `packages/profile-engine/tsconfig.json` verbatim.

`packages/machine/src/errors.ts`:

```ts
import { Data } from 'effect';

// No usable checkout: nothing recorded, the record is stale, and the caller has no fallback.
export class RepoNotFound extends Data.TaggedError('RepoNotFound')<{ readonly recorded?: string }> {}

// A filesystem operation failed for a reason other than the path being absent.
export class FsFailed extends Data.TaggedError('FsFailed')<{ readonly op: string; readonly path: string; readonly reason: string }> {}

// A child process could not be started at all.
export class LaunchFailed extends Data.TaggedError('LaunchFailed')<{ readonly cmd: string; readonly reason: string }> {}

// Another live process holds the apply lock.
export class LockHeld extends Data.TaggedError('LockHeld')<{ readonly path: string; readonly pid: number }> {}
```

Run: `npm install --no-audit --no-fund`
Expected: `node_modules/@nortuscc/machine` is a symlink.

- [ ] **Step 2: Write the failing test**

`packages/machine/checks/paths.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit } from 'effect';
import { homeDir, pathsFromEnvironment, RepoNotFound } from '../src/index.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'machine-paths-'));
const checkout = (dir: string) => { mkdirSync(join(dir, '.git'), { recursive: true }); return dir; };
const resolve = (input: Parameters<typeof pathsFromEnvironment>[0]) => Effect.runPromise(pathsFromEnvironment(input));

test('defaults live under the home directory', async () => {
  const home = scratch();
  const paths = await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli' });
  assert.deepEqual(paths, {
    repo: '/cli',
    claude: join(home, '.claude'),
    codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, '.config', 'nortuscc'),
    backups: join(home, '.config', 'nortuscc', 'backups'),
  });
});

test('every NORTUSCC_ variable overrides its path', async () => {
  const paths = await resolve({
    env: {
      NORTUSCC_REPO_DIR: '/r', NORTUSCC_CLAUDE_DIR: '/c', NORTUSCC_CODEX_DIR: '/x/.codex',
      NORTUSCC_AGENTS_DIR: '/a', NORTUSCC_STATE_DIR: '/s',
    },
    home: scratch(), platform: 'linux',
  });
  assert.equal(paths.repo, '/r');
  assert.equal(paths.claude, '/c');
  assert.equal(paths.codex, '/x/.codex');
  assert.equal(paths.codexOpenRouter, '/x/.codex-openrouter');
  assert.equal(paths.agentsSkills, '/a');
  assert.equal(paths.backups, '/s/backups');
});

test('the OpenRouter variable beats the Codex sibling rule', async () => {
  const paths = await resolve({
    env: { NORTUSCC_CODEX_DIR: '/x/.codex', NORTUSCC_OPENROUTER_CODEX_DIR: '/o' }, home: scratch(), platform: 'linux', fallbackRepo: '/cli',
  });
  assert.equal(paths.codexOpenRouter, '/o');
});

test('windows keeps state under APPDATA', async () => {
  const paths = await resolve({ env: { APPDATA: '/appdata' }, home: scratch(), platform: 'win32', fallbackRepo: '/cli' });
  assert.equal(paths.stateRoot, join('/appdata', 'nortuscc'));
});

test('the recorded repo is used when it is a git checkout', async () => {
  const home = scratch();
  const repo = checkout(join(home, 'claude-config'));
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), JSON.stringify({ repo, files: {} }));
  assert.equal((await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli' })).repo, repo);
});

test('a stale record warns once and falls back', async () => {
  const home = scratch();
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), JSON.stringify({ repo: '/gone', files: {} }));
  const warnings: string[] = [];
  const paths = await resolve({ env: {}, home, platform: 'darwin', fallbackRepo: '/cli', warn: (m) => warnings.push(m) });
  assert.equal(paths.repo, '/cli');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /'\/gone' is not a git checkout/);
});

test('a corrupt state file falls through to the legacy lock', async () => {
  const home = scratch();
  const repo = checkout(join(home, 'legacy-checkout'));
  mkdirSync(join(home, '.config', 'nortuscc'), { recursive: true });
  writeFileSync(join(home, '.config', 'nortuscc', 'state.json'), '{not json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.nortuscc-lock.json'), JSON.stringify({ repo }));
  assert.equal((await resolve({ env: {}, home, platform: 'darwin' })).repo, repo);
});

test('no record and no fallback fails with RepoNotFound', async () => {
  const exit = await Effect.runPromiseExit(pathsFromEnvironment({ env: {}, home: scratch(), platform: 'darwin' }));
  assert.ok(Exit.isFailure(exit));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('RepoNotFound'));
  assert.ok(RepoNotFound);
});

test('homeDir maps an engine home to its directory', async () => {
  const paths = await resolve({ env: {}, home: '/h', platform: 'linux', fallbackRepo: '/cli' });
  assert.equal(homeDir(paths, 'codex-openrouter'), '/h/.codex-openrouter');
  assert.equal(homeDir(paths, 'claude'), '/h/.claude');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `../src/index.ts` does not exist.

- [ ] **Step 4: Implement `paths.ts` and `index.ts`**

`packages/machine/src/paths.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { RepoNotFound } from './errors.ts';

// Every machine location the package touches. Built once, at the boundary, from the environment.
export type MachinePathsValue = {
  readonly repo: string;
  readonly claude: string;
  readonly codex: string;
  readonly codexOpenRouter: string;
  readonly agentsSkills: string;
  readonly stateRoot: string;
  readonly backups: string;
};

export class MachinePaths extends Context.Service<MachinePaths, MachinePathsValue>()('machine/MachinePaths') {}

export const machinePaths = (value: MachinePathsValue) => Layer.succeed(MachinePaths, value);

export type PathsEnvironment = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly fallbackRepo?: string;
  readonly warn?: (message: string) => void;
};

// `.git` is a directory in a clone and a file in a linked worktree; both count.
export const isGitCheckout = (path: string | undefined): boolean =>
  Boolean(path) && existsSync(path!) && existsSync(join(path!, '.git'));

const recordedRepo = (paths: readonly string[]): string | undefined => {
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed.repo === 'string' && parsed.repo) return parsed.repo;
    } catch {
      // Absent or corrupt: try the next record.
    }
  }
  return undefined;
};

// Resolves today's NORTUSCC_* and HOME rules into explicit paths, so nothing below reads the environment.
export const pathsFromEnvironment = (input: PathsEnvironment): Effect.Effect<MachinePathsValue, RepoNotFound> =>
  Effect.suspend(() => {
    const { env, home, platform } = input;
    const claude = env.NORTUSCC_CLAUDE_DIR || join(home, '.claude');
    const codex = env.NORTUSCC_CODEX_DIR || join(home, '.codex');
    const codexOpenRouter = env.NORTUSCC_OPENROUTER_CODEX_DIR
      || (env.NORTUSCC_CODEX_DIR ? join(dirname(env.NORTUSCC_CODEX_DIR), '.codex-openrouter') : join(home, '.codex-openrouter'));
    const stateRoot = env.NORTUSCC_STATE_DIR
      || (platform === 'win32' ? join(env.APPDATA ?? '', 'nortuscc') : join(home, '.config', 'nortuscc'));

    let repo = env.NORTUSCC_REPO_DIR || undefined;
    let recorded: string | undefined;
    if (!repo) {
      recorded = recordedRepo([join(stateRoot, 'state.json'), join(claude, '.nortuscc-lock.json')]);
      if (recorded && isGitCheckout(recorded)) repo = recorded;
      else if (recorded && input.fallbackRepo) {
        input.warn?.(
          `nortuscc: recorded repo '${recorded}' is not a git checkout; using ${input.fallbackRepo} instead. `
            + "Re-run 'nortuscc setup --dir <path>' to fix the record.",
        );
      }
      repo ??= input.fallbackRepo;
    }
    if (!repo) return Effect.fail(new RepoNotFound({ recorded }));

    return Effect.succeed({
      repo,
      claude,
      codex,
      codexOpenRouter,
      agentsSkills: env.NORTUSCC_AGENTS_DIR || join(home, '.agents', 'skills'),
      stateRoot,
      backups: join(stateRoot, 'backups'),
    });
  });

// The one place an engine home becomes a directory.
export const homeDir = (paths: MachinePathsValue, home: 'claude' | 'codex' | 'codex-openrouter'): string =>
  home === 'claude' ? paths.claude : home === 'codex' ? paths.codex : paths.codexOpenRouter;
```

`packages/machine/src/index.ts`:

```ts
export * from './errors.ts';
export * from './paths.ts';
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS, with 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/machine package-lock.json
git commit -m "feat: add @nortuscc/machine with explicit machine paths"
```

---

### Task 3: `Fs` and `Processes` services

**Files:**
- Create: `packages/machine/src/fs.ts`, `packages/machine/src/processes.ts`
- Modify: `packages/machine/src/index.ts`
- Test: `packages/machine/checks/fs.spec.ts`, `packages/machine/checks/processes.spec.ts`

**Interfaces:**
- Consumes: `FsFailed`, `LaunchFailed` (Task 2).
- Produces:

```ts
export class Fs extends Context.Service<Fs, {
  readonly readText: (path: string) => Effect.Effect<string | undefined, FsFailed>   // undefined when absent
  readonly writeTextAtomic: (path: string, text: string) => Effect.Effect<void, FsFailed> // mkdir -p, temp sibling, rename
  readonly exists: (path: string) => Effect.Effect<boolean>                          // lstat: a dangling link exists
  readonly copy: (from: string, to: string) => Effect.Effect<void, FsFailed>          // recursive, symlinks kept as links
  readonly move: (from: string, to: string) => Effect.Effect<void, FsFailed>          // rename, falling back to copy + remove
  readonly remove: (path: string) => Effect.Effect<void, FsFailed>                    // recursive, absent is fine
}>()('machine/Fs') {}
export const nodeFs: Layer.Layer<Fs>

export type Command = { readonly cmd: string; readonly args: readonly string[]; readonly cwd?: string; readonly output: 'inherit' | 'capture' }
export type Completed = { readonly code: number; readonly stdout: string }
export class Processes extends Context.Service<Processes, {
  readonly run: (command: Command) => Effect.Effect<Completed, LaunchFailed>
}>()('machine/Processes') {}
export const nodeProcesses: (options?: { readonly path?: string }) => Layer.Layer<Processes>
```

`run` is interruptible. Interrupting it stops the child's whole process group: SIGTERM, then SIGKILL after 1 s. On win32 it uses `child.kill()`. Each child is spawned `detached: true`, so it leads its own group. `options.path` replaces `PATH` in the child's environment. The desktop uses it to pass the PATH it read from the user's login shell.

- [ ] **Step 1: Write the failing `Fs` test**

`packages/machine/checks/fs.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Fs, nodeFs } from '../src/index.ts';

const run = <A, E>(effect: Effect.Effect<A, E, Fs>) => Effect.runPromise(effect.pipe(Effect.provide(nodeFs)));
const scratch = () => mkdtempSync(join(tmpdir(), 'machine-fs-'));

test('readText returns undefined for an absent file', async () => {
  assert.equal(await run(Effect.flatMap(Fs.asEffect(), (fs) => fs.readText(join(scratch(), 'nope')))), undefined);
});

test('writeTextAtomic creates parents and leaves no temp file', async () => {
  const dir = scratch();
  const target = join(dir, 'a', 'b', 'state.json');
  await run(Effect.flatMap(Fs.asEffect(), (fs) => fs.writeTextAtomic(target, '{"x":1}\n')));
  assert.equal(readFileSync(target, 'utf8'), '{"x":1}\n');
  assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['state.json']);
});

test('copy keeps a symlink a symlink', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'real'), 'r');
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  await run(Effect.flatMap(Fs.asEffect(), (fs) => fs.copy(join(dir, 'link'), join(dir, 'out', 'link'))));
  assert.ok(lstatSync(join(dir, 'out', 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(dir, 'out', 'link')), join(dir, 'real'));
});

test('move relocates a directory and remove tolerates absence', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'f'), 'x');
  await run(Effect.gen(function* () {
    const fs = yield* Fs;
    yield* fs.move(join(dir, 'src'), join(dir, 'deep', 'dst'));
    yield* fs.remove(join(dir, 'never-existed'));
  }));
  assert.equal(existsSync(join(dir, 'src')), false);
  assert.equal(readFileSync(join(dir, 'deep', 'dst', 'f'), 'utf8'), 'x');
});

test('exists sees a dangling symlink', async () => {
  const dir = scratch();
  symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
  assert.equal(await run(Effect.flatMap(Fs.asEffect(), (fs) => fs.exists(join(dir, 'dangling')))), true);
});
```

`Fs.asEffect()` is how Effect 4 exposes a service as an effect. If 4.0.1 names it differently, use `Effect.gen(function* () { const fs = yield* Fs; … })`, as the last test does.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `Fs` is not exported.

- [ ] **Step 3: Implement `fs.ts`**

```ts
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { FsFailed } from './errors.ts';

export class Fs extends Context.Service<
  Fs,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly writeTextAtomic: (path: string, text: string) => Effect.Effect<void, FsFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly copy: (from: string, to: string) => Effect.Effect<void, FsFailed>;
    readonly move: (from: string, to: string) => Effect.Effect<void, FsFailed>;
    readonly remove: (path: string) => Effect.Effect<void, FsFailed>;
  }
>()('machine/Fs') {}

const attempt = <A>(op: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (err) => new FsFailed({ op, path, reason: err instanceof Error ? err.message : String(err) }),
  });

const copyTree = (from: string, to: string) => async () => {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
};

export const nodeFs = Layer.succeed(Fs, {
  readText: (path) =>
    attempt('read', path, () =>
      readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      })),
  // A reader sees the old file or the whole new one, never half of it.
  writeTextAtomic: (path, text) =>
    attempt('write', path, async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      try {
        await writeFile(temp, text, 'utf8');
        await rename(temp, path);
      } catch (err) {
        await rm(temp, { force: true });
        throw err;
      }
    }),
  exists: (path) => Effect.promise(() => lstat(path).then(() => true, () => false)),
  copy: (from, to) => attempt('copy', from, copyTree(from, to)),
  // rename fails across volumes; copy then remove covers that.
  move: (from, to) =>
    attempt('move', from, async () => {
      await mkdir(dirname(to), { recursive: true });
      try {
        await rename(from, to);
      } catch {
        await copyTree(from, to)();
        await rm(from, { recursive: true, force: true });
      }
    }),
  remove: (path) => attempt('remove', path, () => rm(path, { recursive: true, force: true })),
});
```

Add `export * from './fs.ts';` to `index.ts`.

- [ ] **Step 4: Run the `Fs` tests**

Run: `npm test -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Write the failing `Processes` test**

`packages/machine/checks/processes.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect, Exit, Fiber } from 'effect';
import { nodeProcesses, Processes } from '../src/index.ts';

const node = process.execPath;
const run = <A, E>(effect: Effect.Effect<A, E, Processes>, path?: string) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(nodeProcesses(path ? { path } : {}))));
const exec = (args: string[]) => Effect.flatMap(Processes.asEffect(), (p) => p.run({ cmd: node, args, output: 'capture' }));

test('captures stdout and the exit code', async () => {
  const exit = await run(exec(['-e', 'console.log("hi"); process.exit(3)']));
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(Exit.isSuccess(exit) && exit.value, { code: 3, stdout: 'hi\n' });
});

test('a command that cannot launch fails with LaunchFailed', async () => {
  const exit = await run(Effect.flatMap(Processes.asEffect(), (p) => p.run({ cmd: '/no/such/tool', args: [], output: 'capture' })));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LaunchFailed'));
});

test('the path option replaces PATH for the child', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'machine-bin-'));
  writeFileSync(join(bin, 'faketool'), '#!/bin/sh\necho fake\n');
  chmodSync(join(bin, 'faketool'), 0o755);
  const exit = await run(Effect.flatMap(Processes.asEffect(), (p) => p.run({ cmd: 'faketool', args: [], output: 'capture' })), `${bin}:/usr/bin:/bin`);
  assert.ok(Exit.isSuccess(exit) && exit.value.stdout === 'fake\n');
});

test('interrupting a run kills the whole process group', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-proc-'));
  const pidFile = join(dir, 'grandchild');
  const script = `const c = require('node:child_process').spawn('sleep', ['30']);`
    + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(['-e', script]));
    while (!existsSync(pidFile)) yield* Effect.promise(() => sleep(20));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses())));
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await sleep(200);
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `Processes` is not exported.

- [ ] **Step 7: Implement `processes.ts`**

```ts
import { spawn } from 'node:child_process';
import { Context, Effect, Layer } from 'effect';
import { LaunchFailed } from './errors.ts';

export type Command = {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly output: 'inherit' | 'capture';
};
export type Completed = { readonly code: number; readonly stdout: string };

export class Processes extends Context.Service<
  Processes,
  { readonly run: (command: Command) => Effect.Effect<Completed, LaunchFailed> }
>()('machine/Processes') {}

// argv only, never a shell: names and commands come from manifests.
export const nodeProcesses = (options: { readonly path?: string } = {}) =>
  Layer.succeed(Processes, {
    run: (command) =>
      Effect.callback<Completed, LaunchFailed>((resume) => {
        const env = options.path === undefined ? process.env : { ...process.env, PATH: options.path };
        const child = spawn(command.cmd, [...command.args], {
          cwd: command.cwd,
          env,
          shell: false,
          // Its own process group, so cancelling reaches the installer's own children too.
          detached: process.platform !== 'win32',
          stdio: command.output === 'capture' ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        });
        let stdout = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.on('error', (err) => resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: err.message }))));
        child.on('close', (code, signal) => resume(Effect.succeed({ code: code ?? (signal ? 128 : 1), stdout })));

        return Effect.promise(() => new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          const signalGroup = (sig: NodeJS.Signals) => {
            try {
              if (process.platform === 'win32' || child.pid === undefined) child.kill(sig);
              else process.kill(-child.pid, sig);
            } catch {
              // Already gone.
            }
          };
          const force = setTimeout(() => signalGroup('SIGKILL'), 1000);
          child.once('close', () => { clearTimeout(force); done(); });
          signalGroup('SIGTERM');
        }));
      }),
  });
```

Add `export * from './processes.ts';` to `index.ts`.

- [ ] **Step 8: Run the tests and typecheck**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS. The process-group test finishes in under 2 s.

- [ ] **Step 9: Commit**

```bash
git add packages/machine
git commit -m "feat: add filesystem and process services to @nortuscc/machine"
```

---

### Task 4: `StateStore` and `OverridesStore`

**Files:**
- Create: `packages/machine/src/hash.ts`, `packages/machine/src/state.ts`, `packages/machine/src/overrides.ts`
- Modify: `packages/machine/src/index.ts`
- Test: `packages/machine/checks/state.spec.ts`, `packages/machine/checks/overrides.spec.ts`

**Interfaces:**
- Consumes: `MachinePaths`, `Fs`, `FsFailed` (Tasks 2–3). From the engine: `decodeOverrides`, `overridesFromLegacyState`, `Input`, `MachineOverrides`, `Target`, `TARGETS`.
- Produces:

```ts
export const hashText: (text: string) => string               // 'sha256:<hex>', CRLF normalised to LF
export type Baseline = { readonly hash: string; readonly appliedAt: string }
export type MachineState = {
  readonly version: 1
  readonly repo: string | null
  readonly skillsOnly: boolean
  readonly configTargets?: ReadonlyArray<Target>
  readonly files: Readonly<Record<string, Baseline>>
}
export const emptyState: MachineState
export const parseState: (text: string) => MachineState | undefined   // undefined: not the expected shape
export class StateStore extends Context.Service<StateStore, {
  readonly read: Effect.Effect<MachineState, FsFailed>
  readonly write: (state: MachineState) => Effect.Effect<void, FsFailed>
  readonly update: (f: (state: MachineState) => MachineState) => Effect.Effect<MachineState, FsFailed>
}>()('machine/StateStore') {}
export const stateStore: Layer.Layer<StateStore, never, MachinePaths | Fs>
export const withBaseline: (state: MachineState, key: string, hash: string, now?: Date) => MachineState
export const withoutBaseline: (state: MachineState, key: string) => MachineState

export class OverridesStore extends Context.Service<OverridesStore, {
  readonly read: Effect.Effect<Input<MachineOverrides>, FsFailed>
  readonly write: (overrides: MachineOverrides) => Effect.Effect<void, FsFailed>
}>()('machine/OverridesStore') {}
export const overridesStore: Layer.Layer<OverridesStore, never, MachinePaths | Fs>
```

These semantics are ported from `src/lock.mjs`:
- **A missing `state.json`:** migrate from the legacy `<claude>/.nortuscc-lock.json` once (`repo`, plus `CLAUDE.md` → `claude:CLAUDE.md`), write the result, and return it. With no legacy lock, return `emptyState`.
- **A `state.json` that exists but has the wrong shape:** `emptyState`, and no migration.
- **`skillsOnly`:** strictly `=== true`.
- **`configTargets`:** kept, deduplicated, only when every entry is a known target.
- **Written text:** `JSON.stringify(state, null, 2) + '\n'`.

`OverridesStore.read`:
- When `<stateRoot>/overrides.json` exists, parse it and pass it to `decodeOverrides(value, path)`. Invalid JSON gives `{ value: {}, source: path, issues: [one machine issue] }`.
- Only when the file is absent: `overridesFromLegacyState(stateText, statePath)`.

`write` writes `{ version: 1, ...overrides }` and never touches `state.json`.

- [ ] **Step 1: Write the failing state test**

`packages/machine/checks/state.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  emptyState, hashText, machinePaths, nodeFs, parseState, StateStore, stateStore, withBaseline, withoutBaseline,
} from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-state-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = stateStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (store: StateStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(StateStore.asEffect(), f).pipe(Effect.provide(layer)));
  return { paths, run };
};

test('hashText is prefixed and ignores CRLF', () => {
  assert.match(hashText('a'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashText('a\r\nb'), hashText('a\nb'));
});

test('a bare machine reads as empty state', async () => {
  const { run } = machine();
  assert.deepEqual(await run((s) => s.read), emptyState);
});

test('a malformed state file reads as empty and is not migrated over', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.stateRoot, { recursive: true });
  writeFileSync(join(paths.stateRoot, 'state.json'), '{"files": []}');
  mkdirSync(paths.claude, { recursive: true });
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), JSON.stringify({ repo: '/r', files: {} }));
  assert.deepEqual(await run((s) => s.read), emptyState);
});

test('the legacy lock migrates once, carrying repo and the CLAUDE.md baseline only', async () => {
  const { paths, run } = machine();
  mkdirSync(paths.claude, { recursive: true });
  const baseline = { hash: 'sha256:1', appliedAt: '2026-01-01T00:00:00.000Z' };
  writeFileSync(join(paths.claude, '.nortuscc-lock.json'), JSON.stringify({ repo: '/r', files: { 'CLAUDE.md': baseline, 'settings.json': baseline } }));
  const state = await run((s) => s.read);
  assert.equal(state.repo, '/r');
  assert.deepEqual(state.files, { 'claude:CLAUDE.md': baseline });
  assert.ok(existsSync(join(paths.stateRoot, 'state.json')));
  assert.ok(existsSync(join(paths.claude, '.nortuscc-lock.json')));
});

test('skillsOnly is strict and configTargets is kept only when valid', () => {
  assert.equal(parseState(JSON.stringify({ skillsOnly: 'yes', files: {} }))!.skillsOnly, false);
  assert.deepEqual(parseState(JSON.stringify({ configTargets: ['codex', 'codex'], files: {} }))!.configTargets, ['codex']);
  assert.equal(parseState(JSON.stringify({ configTargets: ['nope'], files: {} }))!.configTargets, undefined);
  assert.equal(parseState('[]'), undefined);
});

test('update writes the legacy layout and baselines round-trip', async () => {
  const { paths, run } = machine();
  const now = new Date('2026-10-05T00:00:00.000Z');
  await run((s) => s.update((state) => withBaseline(withBaseline(state, 'claude:CLAUDE.md', 'sha256:a', now), 'x', 'sha256:b', now)));
  await run((s) => s.update((state) => withoutBaseline(state, 'x')));
  const text = readFileSync(join(paths.stateRoot, 'state.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(JSON.parse(text), {
    version: 1, repo: null, skillsOnly: false,
    files: { 'claude:CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-10-05T00:00:00.000Z' } },
  });
});
```

`StateStore['Service']` names the service's shape type. If Effect 4.0.1 spells it differently, use `Context.Service.Shape<typeof StateStore>` or inline the shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `StateStore` is not exported.

- [ ] **Step 3: Implement `hash.ts` and `state.ts`**

`hash.ts`:

```ts
import { createHash } from 'node:crypto';

// Line endings are normalised so a CRLF checkout does not read as drift against an LF repo.
export const hashText = (text: string): string =>
  'sha256:' + createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
```

`state.ts`:

```ts
import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { TARGETS, type Target } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

export type Baseline = { readonly hash: string; readonly appliedAt: string };
export type MachineState = {
  readonly version: 1;
  readonly repo: string | null;
  readonly skillsOnly: boolean;
  readonly configTargets?: ReadonlyArray<Target>;
  readonly files: Readonly<Record<string, Baseline>>;
};

export const emptyState: MachineState = { version: 1, repo: null, skillsOnly: false, files: {} };

// The one legacy key worth carrying forward from the pre-Codex lock.
const LEGACY_KEYS: Record<string, string> = { 'CLAUDE.md': 'claude:CLAUDE.md' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A record that is not the expected shape is treated as absent rather than trusted halfway.
export const parseState = (text: string): MachineState | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.files)) return undefined;
  const targets = parsed.configTargets;
  const validTargets = Array.isArray(targets) && targets.every((t) => (TARGETS as readonly unknown[]).includes(t));
  return {
    version: 1,
    repo: typeof parsed.repo === 'string' ? parsed.repo : null,
    skillsOnly: parsed.skillsOnly === true,
    ...(validTargets ? { configTargets: [...new Set(targets as Target[])] } : {}),
    files: parsed.files as Record<string, Baseline>,
  };
};

export const withBaseline = (state: MachineState, key: string, hash: string, now = new Date()): MachineState => ({
  ...state,
  files: { ...state.files, [key]: { hash, appliedAt: now.toISOString() } },
});

export const withoutBaseline = (state: MachineState, key: string): MachineState => {
  const { [key]: _removed, ...files } = state.files;
  return { ...state, files };
};

export class StateStore extends Context.Service<
  StateStore,
  {
    readonly read: Effect.Effect<MachineState, FsFailed>;
    readonly write: (state: MachineState) => Effect.Effect<void, FsFailed>;
    readonly update: (f: (state: MachineState) => MachineState) => Effect.Effect<MachineState, FsFailed>;
  }
>()('machine/StateStore') {}

// state.json: nortuscc's own bookkeeping, in the legacy CLI's exact format.
export const stateStore = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const statePath = join(paths.stateRoot, 'state.json');
    const legacyPath = join(paths.claude, '.nortuscc-lock.json');

    const write = (state: MachineState) => fs.writeTextAtomic(statePath, JSON.stringify(state, null, 2) + '\n');

    // Migrates the pre-Codex lock only when no state file exists; the old lock is left untouched.
    const read = Effect.gen(function* () {
      const text = yield* fs.readText(statePath);
      if (text !== undefined) return parseState(text) ?? emptyState;
      const legacyText = yield* fs.readText(legacyPath);
      const legacy = legacyText === undefined ? undefined : parseState(legacyText);
      if (!legacy) return emptyState;
      const files: Record<string, Baseline> = {};
      for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
        if (legacy.files[oldKey]) files[newKey] = legacy.files[oldKey];
      }
      const migrated: MachineState = { ...emptyState, repo: legacy.repo, files };
      yield* write(migrated);
      return migrated;
    });

    return {
      read,
      write,
      update: (f) => Effect.flatMap(read, (state) => {
        const next = f(state);
        return Effect.as(write(next), next);
      }),
    };
  }),
);
```

Add `export * from './hash.ts';` and `export * from './state.ts';` to `index.ts`.

- [ ] **Step 4: Run the state tests**

Run: `npm test -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Write the failing overrides test**

`packages/machine/checks/overrides.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs, OverridesStore, overridesStore } from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-overrides-'));
  const stateRoot = join(home, 'state');
  mkdirSync(stateRoot, { recursive: true });
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot, backups: join(stateRoot, 'backups'),
  };
  const layer = overridesStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (store: OverridesStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(OverridesStore.asEffect(), f).pipe(Effect.provide(layer)));
  return { stateRoot, run };
};

test('without overrides.json the legacy state fields are read', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, configTargets: ['codex'], files: {} }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, { manageConfig: false, configTargets: ['codex'] });
  assert.equal(overrides.source, join(stateRoot, 'state.json'));
});

test('overrides.json wins over the legacy fields', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, files: {} }));
  writeFileSync(join(stateRoot, 'overrides.json'), JSON.stringify({ version: 1, skills: { tdd: false } }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, { skills: { tdd: false } });
  assert.deepEqual(overrides.issues, []);
});

test('invalid JSON is one issue and no overrides, not a legacy fallback', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'state.json'), JSON.stringify({ skillsOnly: true, files: {} }));
  writeFileSync(join(stateRoot, 'overrides.json'), '{oops');
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, {});
  assert.equal(overrides.issues.length, 1);
  assert.equal(overrides.issues[0]!.layer, 'machine');
  assert.equal(overrides.issues[0]!.source, join(stateRoot, 'overrides.json'));
});

test('an unknown field is reported by the engine decoder', async () => {
  const { stateRoot, run } = machine();
  writeFileSync(join(stateRoot, 'overrides.json'), JSON.stringify({ version: 1, colour: 'blue' }));
  const overrides = await run((s) => s.read);
  assert.deepEqual(overrides.value, {});
  assert.equal(overrides.issues.length, 1);
});

test('write stamps the version and leaves state.json alone', async () => {
  const { stateRoot, run } = machine();
  const legacy = JSON.stringify({ skillsOnly: true, configTargets: ['codex'], files: {} });
  writeFileSync(join(stateRoot, 'state.json'), legacy);
  await run((s) => s.write({ manageConfig: false, configTargets: ['codex'] }));
  assert.deepEqual(JSON.parse(readFileSync(join(stateRoot, 'overrides.json'), 'utf8')), { version: 1, manageConfig: false, configTargets: ['codex'] });
  assert.equal(readFileSync(join(stateRoot, 'state.json'), 'utf8'), legacy);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `OverridesStore` is not exported.

- [ ] **Step 7: Implement `overrides.ts`**

```ts
import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { decodeOverrides, overridesFromLegacyState, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

export class OverridesStore extends Context.Service<
  OverridesStore,
  {
    readonly read: Effect.Effect<Input<MachineOverrides>, FsFailed>;
    readonly write: (overrides: MachineOverrides) => Effect.Effect<void, FsFailed>;
  }
>()('machine/OverridesStore') {}

// overrides.json: this machine's choices. Until cutover (#59) the legacy state.json fields
// are read when the file is absent, and writing never removes them.
export const overridesStore = Layer.effect(
  OverridesStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'overrides.json');
    const statePath = join(paths.stateRoot, 'state.json');

    const read = Effect.gen(function* () {
      const text = yield* fs.readText(path);
      if (text === undefined) return overridesFromLegacyState(yield* fs.readText(statePath), statePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const message = `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        return { value: {}, source: path, issues: [{ layer: 'machine' as const, source: path, path: '', message }] };
      }
      return decodeOverrides(parsed, path);
    });

    return {
      read,
      write: (overrides) => fs.writeTextAtomic(path, JSON.stringify({ version: 1, ...overrides }, null, 2) + '\n'),
    };
  }),
);
```

Add `export * from './overrides.ts';` to `index.ts`. If the engine's `Issue` type requires a different `path` value for a whole-document problem, match whatever `decodeOverrides` produces for a malformed document. Check `packages/profile-engine/src/overrides.ts`.

- [ ] **Step 8: Run the tests and typecheck**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/machine
git commit -m "feat: add state and overrides stores to @nortuscc/machine"
```

---

### Task 5: `Backups` and the apply lock

**Files:**
- Create: `packages/machine/src/backups.ts`, `packages/machine/src/apply-lock.ts`
- Modify: `packages/machine/src/index.ts`
- Test: `packages/machine/checks/backups.spec.ts`, `packages/machine/checks/apply-lock.spec.ts`

**Interfaces:**
- Consumes: `MachinePaths`, `Fs`, `FsFailed`, `LockHeld`.
- Produces:

```ts
export class Backups extends Context.Service<Backups, {
  readonly dir: Effect.Effect<string | undefined>                // this run's folder, once anything was backed up
  readonly moveAside: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>
  readonly preserve: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>
}>()('machine/Backups') {}
export const backupsForRun: (started?: Date) => Layer.Layer<Backups, never, MachinePaths | Fs>
export const acquireApplyLock: Effect.Effect<void, LockHeld, MachinePaths | Scope.Scope>
```

**Backups.** The folder is `<backups>/nortuscc-<started.toISOString() with ':' and '.' replaced by '-'>`, created lazily. A file lands at `<folder>/<agent>/<relative>`; with no agent, it lands at `<folder>/<relative>`. Both functions return `undefined` when nothing is at `path`. `moveAside` moves the file, and `preserve` copies it. Callers provide a fresh `backupsForRun()` layer for each execution.

**Apply lock.** `<stateRoot>/apply.lock` is created with the `wx` flag and holds `{"pid":…,"startedAt":…}`.
- If the lock exists and its pid is alive (`process.kill(pid, 0)` succeeds or throws `EPERM`), fail with `LockHeld`.
- If the pid is dead or the file is unreadable, remove it and retry once.
- The scope's finalizer removes the file only if it still holds this process's pid.

The lock uses `node:fs` directly, not `Fs`, because exclusive creation is the whole point.

- [ ] **Step 1: Write the failing tests**

`packages/machine/checks/backups.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Backups, backupsForRun, machinePaths, nodeFs } from '../src/index.ts';

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-backups-'));
  const paths = {
    repo: home, claude: join(home, '.claude'), codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = backupsForRun(new Date('2026-10-05T12:34:56.789Z')).pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (b: Backups['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Backups.asEffect(), f).pipe(Effect.provide(layer)));
  return { home, paths, run };
};

test('nothing to back up creates no folder', async () => {
  const { home, paths, run } = setup();
  const result = await run((b) => Effect.all([b.moveAside(join(home, 'absent'), 'absent', 'claude'), b.dir]));
  assert.deepEqual(result, [undefined, undefined]);
  assert.equal(existsSync(paths.backups), false);
});

test('moveAside and preserve use the legacy layout', async () => {
  const { home, paths, run } = setup();
  writeFileSync(join(home, 'CLAUDE.md'), 'mine');
  writeFileSync(join(home, 'settings.json'), '{}');
  const [moved, kept, dir] = await run((b) => Effect.all([
    b.moveAside(join(home, 'CLAUDE.md'), 'CLAUDE.md', 'claude'),
    b.preserve(join(home, 'settings.json'), 'settings.json', 'claude'),
    b.dir,
  ]));
  const folder = join(paths.backups, 'nortuscc-2026-10-05T12-34-56-789Z');
  assert.equal(dir, folder);
  assert.equal(moved, join(folder, 'claude', 'CLAUDE.md'));
  assert.equal(readFileSync(moved!, 'utf8'), 'mine');
  assert.equal(existsSync(join(home, 'CLAUDE.md')), false);
  assert.equal(kept, join(folder, 'claude', 'settings.json'));
  assert.equal(existsSync(join(home, 'settings.json')), true);
});
```

`packages/machine/checks/apply-lock.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Effect, Exit } from 'effect';
import { acquireApplyLock, machinePaths } from '../src/index.ts';

const setup = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'machine-lock-'));
  const layer = machinePaths({
    repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot,
    agentsSkills: stateRoot, stateRoot, backups: join(stateRoot, 'backups'),
  });
  return { lock: join(stateRoot, 'apply.lock'), run: <A, E>(e: Effect.Effect<A, E, any>) => Effect.runPromiseExit(Effect.scoped(e).pipe(Effect.provide(layer))) };
};

test('the lock exists while held and is removed after', async () => {
  const { lock, run } = setup();
  const exit = await run(Effect.andThen(acquireApplyLock, Effect.sync(() => existsSync(lock))));
  assert.ok(Exit.isSuccess(exit) && exit.value === true);
  assert.equal(existsSync(lock), false);
});

test('a lock held by a live process fails with LockHeld', async () => {
  const { lock, run } = setup();
  writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
  const exit = await run(acquireApplyLock);
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(existsSync(lock), true);
});

test('a lock left by a dead process is taken over', async () => {
  const { lock, run } = setup();
  const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(lock, JSON.stringify({ pid: Number(dead), startedAt: 'x' }));
  assert.ok(Exit.isSuccess(await run(acquireApplyLock)));
  assert.equal(existsSync(lock), false);
});

test('an unreadable lock file is taken over', async () => {
  const { lock, run } = setup();
  mkdirSync(join(lock, '..'), { recursive: true });
  writeFileSync(lock, 'garbage');
  assert.ok(Exit.isSuccess(await run(acquireApplyLock)));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w packages/machine`
Expected: FAIL, because `Backups` and `acquireApplyLock` are not exported.

- [ ] **Step 3: Implement `backups.ts` and `apply-lock.ts`**

`backups.ts`:

```ts
import { join } from 'node:path';
import { Context, Effect, Layer, Ref } from 'effect';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

export class Backups extends Context.Service<
  Backups,
  {
    readonly dir: Effect.Effect<string | undefined>;
    readonly moveAside: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly preserve: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>;
  }
>()('machine/Backups') {}

// One folder per run, so a run's displaced files stay together; created only when needed.
export const backupsForRun = (started = new Date()) =>
  Layer.effect(
    Backups,
    Effect.gen(function* () {
      const paths = yield* MachinePaths;
      const fs = yield* Fs;
      const folder = join(paths.backups, `nortuscc-${started.toISOString().replace(/[:.]/g, '-')}`);
      const used = yield* Ref.make(false);
      const target = (relative: string, agent?: string) => join(folder, ...(agent ? [agent] : []), relative);
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(path))) return undefined;
          const to = target(relative, agent);
          yield* (op === 'move' ? fs.move(path, to) : fs.copy(path, to));
          yield* Ref.set(used, true);
          return to;
        });
      return {
        dir: Effect.map(Ref.get(used), (u) => (u ? folder : undefined)),
        moveAside: keep('move'),
        preserve: keep('copy'),
      };
    }),
  );
```

`apply-lock.ts`:

```ts
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { LockHeld } from './errors.ts';
import { MachinePaths } from './paths.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const holder = (path: string): number | undefined => {
  try {
    const pid = JSON.parse(readFileSync(path, 'utf8')).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

// One machine-changing run at a time, across the CLI and the app. A lock whose owner died is taken over.
export const acquireApplyLock = Effect.gen(function* () {
  const { stateRoot } = yield* MachinePaths;
  const path = join(stateRoot, 'apply.lock');
  const claim = () => writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });

  yield* Effect.acquireRelease(
    Effect.suspend(() => {
      mkdirSync(stateRoot, { recursive: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          claim();
          return Effect.void;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return Effect.die(err);
          const pid = holder(path);
          if (pid !== undefined && alive(pid)) return Effect.fail(new LockHeld({ path, pid }));
          rmSync(path, { force: true });
        }
      }
      return Effect.fail(new LockHeld({ path, pid: holder(path) ?? 0 }));
    }),
    () => Effect.sync(() => {
      if (holder(path) === process.pid) rmSync(path, { force: true });
    }),
  );
});
```

Export both from `index.ts`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine
git commit -m "feat: add per-run backups and the apply lock to @nortuscc/machine"
```

---

### Task 6: Item model, `inspect`, `plan` and `execute`

**Files:**
- Create: `packages/machine/src/model.ts`, `packages/machine/src/run.ts`, `packages/machine/README.md`
- Modify: `packages/machine/src/index.ts`
- Test: `packages/machine/checks/run.spec.ts`

**Interfaces:**
- Consumes: `acquireApplyLock`, `Backups`, `MachinePaths`, `LockHeld`. From the engine: `DesiredConfig`, `Origin`, `Target`.
- Produces (domain issues #55–#57 and the desktop issue #58 build against these exact names):

```ts
export type DomainName = 'config' | 'integrations' | 'skills'
export type Disposition = 'in-sync' | 'apply' | 'capture' | 'blocked' | 'excluded' | 'undeclared'
export type Observed = {
  readonly key: string; readonly domain: DomainName; readonly target: Target
  readonly label: string; readonly group: string; readonly state: string
  readonly disposition: Disposition; readonly note?: string; readonly from?: Origin
}
export type MachineReport = { readonly desired: DesiredConfig; readonly items: ReadonlyArray<Observed>; readonly probeErrors: ReadonlyArray<string> }
export type InstallCategory = 'hooks' | 'mcp' | 'plugins' | 'skills'
export type Selection = {
  readonly targets: ReadonlyArray<Target>
  readonly declined: ReadonlyArray<InstallCategory>
  readonly only?: ReadonlyArray<string>       // picker: keep just these keys
  readonly exclude: ReadonlyArray<string>     // desktop: drop these keys
  readonly force: boolean                     // --take-repo / --take-local
}
export const selectAll: Selection
export type PlanKind = 'apply' | 'uninstall' | 'capture'
export type StepAction = 'write-file' | 'merge-keys' | 'restore' | 'remove' | 'capture-file' | 'write-manifest' | 'install-integration' | 'install-skills'
export type Step = {
  readonly key: string; readonly domain: DomainName; readonly action: StepAction
  readonly summary: string; readonly touches: ReadonlyArray<string>; readonly interruptible: boolean
}
export type Skipped = { readonly key: string; readonly reason: string }
export type Plan = { readonly kind: PlanKind; readonly steps: ReadonlyArray<Step>; readonly skipped: ReadonlyArray<Skipped> }
export type StepResult = { readonly ok: boolean; readonly note?: string }
export type Progress =
  | { readonly type: 'started'; readonly index: number; readonly total: number; readonly step: Step }
  | { readonly type: 'finished'; readonly index: number; readonly total: number; readonly key: string; readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string }
  | { readonly type: 'done'; readonly ok: number; readonly failed: number; readonly backups?: string }
  | { readonly type: 'cancelled'; readonly remaining: ReadonlyArray<string>; readonly backups?: string }
export type Domain<R = never> = {
  readonly name: DomainName
  readonly inspect: (desired: DesiredConfig) => Effect.Effect<{ items: ReadonlyArray<Observed>; probeErrors: ReadonlyArray<string> }, never, R>
  readonly steps: (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind) => { steps: ReadonlyArray<Step>; skipped: ReadonlyArray<Skipped> }
  readonly run: (step: Step) => Effect.Effect<StepResult, unknown, R>
}

export const inspect: <R>(desired: DesiredConfig, domains: ReadonlyArray<Domain<R>>) => Effect.Effect<MachineReport, never, R>
export const plan: <R>(kind: PlanKind, report: MachineReport, selection: Selection, domains: ReadonlyArray<Domain<R>>) => Plan
export const execute: <R>(plan: Plan, domains: ReadonlyArray<Domain<R>>, options?: { readonly signal?: AbortSignal }) =>
  Stream.Stream<Progress, LockHeld, R | MachinePaths | Backups>
```

Semantics:
- **`plan`** removes keys in `selection.exclude`, and keys not in `selection.only` when `only` is given. Each removed key is recorded as `skipped` with reason `not selected`. The remaining items, grouped by domain, go to that domain's `steps`. Steps keep the order of `domains`, then the domain's own order. The caller's domain order is the run order.
- **`execute`, before any step:** it takes the apply lock. A held lock fails the stream with `LockHeld` before any step runs.
- **`execute`, before each step:** it checks `signal.aborted`. If set, it emits `cancelled` with the keys not yet started and ends.
- **Per step:** it emits `started`, runs the step, and emits `finished`.
  - A step with `interruptible: false` runs to completion under `Effect.uninterruptible`, and its real result is reported even if the signal fired meanwhile.
  - A step with `interruptible: true` races the signal. If the signal wins, the step is interrupted (finalizers kill its processes) and finishes `cancelled`.
  - A typed failure or a defect finishes `failed` with a message, and the run continues.
- **The last event:** `done` (or `cancelled`) carries `backups: (yield* Backups).dir`.
- **Error propagation:** a failure inside `Stream.callback`'s effect does not end the stream by itself. Route it with `Queue.fail(queue, error)` (verified against effect 4.0.1).

- [ ] **Step 1: Write the failing test**

`packages/machine/checks/run.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit, Layer, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import {
  backupsForRun, execute, inspect, machinePaths, nodeFs, plan, selectAll,
  type Domain, type MachineReport, type Observed, type Progress, type Step,
} from '../src/index.ts';

const desired: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };
const item = (key: string, disposition: Observed['disposition'] = 'apply'): Observed =>
  ({ key, domain: 'config', target: 'claude', label: key, group: 'g', state: 's', disposition });
const step = (key: string, interruptible = false): Step =>
  ({ key, domain: 'config', action: 'write-file', summary: key, touches: [], interruptible });

const fake = (run: Domain['run'], items: Observed[] = []): Domain => ({
  name: 'config',
  inspect: () => Effect.succeed({ items, probeErrors: ['codex unreadable'] }),
  steps: (selected) => ({
    steps: selected.filter((o) => o.disposition === 'apply').map((o) => step(o.key, o.key.startsWith('proc'))),
    skipped: selected.filter((o) => o.disposition === 'blocked').map((o) => ({ key: o.key, reason: 'conflict' })),
  }),
  run,
});

const machine = () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'machine-run-'));
  const paths = { repo: stateRoot, claude: stateRoot, codex: stateRoot, codexOpenRouter: stateRoot, agentsSkills: stateRoot, stateRoot, backups: join(stateRoot, 'backups') };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const collect = (stream: Stream.Stream<Progress, unknown, any>) =>
    Effect.runPromiseExit(Stream.runCollect(stream).pipe(Effect.map((c) => [...c]), Effect.provide(layer)));
  return { stateRoot, collect };
};

test('inspect concatenates items and probe errors', async () => {
  const report = await Effect.runPromise(inspect(desired, [fake(() => Effect.succeed({ ok: true }), [item('a')])]));
  assert.deepEqual(report.items.map((o) => o.key), ['a']);
  assert.deepEqual(report.probeErrors, ['codex unreadable']);
});

test('plan applies only/exclude, then lets the domain decide', () => {
  const report: MachineReport = { desired, items: [item('a'), item('b'), item('c', 'blocked'), item('d')], probeErrors: [] };
  const result = plan('apply', report, { ...selectAll, exclude: ['d'] }, [fake(() => Effect.succeed({ ok: true }))]);
  assert.deepEqual(result.steps.map((s) => s.key), ['a', 'b']);
  assert.deepEqual(result.skipped, [{ key: 'd', reason: 'not selected' }, { key: 'c', reason: 'conflict' }]);
  assert.equal(result.kind, 'apply');
});

test('execute reports each step and isolates failures', async () => {
  const { collect } = machine();
  const domain = fake((s) => s.key === 'b' ? Effect.fail('nope') : s.key === 'c' ? Effect.die(new Error('boom')) : Effect.succeed({ ok: true, note: 'written' }));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b'), step('c')], skipped: [] }, [domain]));
  assert.ok(Exit.isSuccess(exit));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type),
    ['started', 'a:ok', 'started', 'b:failed', 'started', 'c:failed', 'done']);
  assert.deepEqual(events.at(-1), { type: 'done', ok: 1, failed: 2, backups: undefined });
});

test('a held lock fails the run before any step', async () => {
  const { stateRoot, collect } = machine();
  writeFileSync(join(stateRoot, 'apply.lock'), JSON.stringify({ pid: process.ppid }));
  let ran = false;
  const exit = await collect(execute({ kind: 'apply', steps: [step('a')], skipped: [] }, [fake(() => Effect.sync(() => { ran = true; return { ok: true }; }))]));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LockHeld'));
  assert.equal(ran, false);
});

test('an already-aborted signal runs nothing and releases the lock', async () => {
  const { stateRoot, collect } = machine();
  const controller = new AbortController();
  controller.abort();
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, [fake(() => Effect.die('must not run'))], { signal: controller.signal }));
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(Exit.isSuccess(exit) && exit.value, [{ type: 'cancelled', remaining: ['a', 'b'], backups: undefined }]);
  assert.equal(existsSync(join(stateRoot, 'apply.lock')), false);
});

test('cancelling mid-run finishes the file step and stops before the next', async () => {
  const { collect } = machine();
  const controller = new AbortController();
  const domain = fake((s) => s.key === 'a'
    ? Effect.sleep('50 millis').pipe(Effect.tap(() => Effect.sync(() => controller.abort())), Effect.as({ ok: true }))
    : Effect.die('must not run'));
  const exit = await collect(execute({ kind: 'apply', steps: [step('a'), step('b')], skipped: [] }, [domain], { signal: controller.signal }));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type), ['started', 'a:ok', 'cancelled']);
  assert.deepEqual((events.at(-1) as { remaining: string[] }).remaining, ['b']);
});

test('cancelling interrupts an interruptible step and runs its finalizer', async () => {
  const { collect } = machine();
  const controller = new AbortController();
  let finalized = false;
  const domain = fake(() => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { finalized = true; }))));
  setTimeout(() => controller.abort(), 30);
  const exit = await collect(execute({ kind: 'apply', steps: [step('proc-a', true), step('b')], skipped: [] }, [domain], { signal: controller.signal }));
  const events = Exit.isSuccess(exit) ? exit.value : [];
  assert.deepEqual(events.map((e) => e.type === 'finished' ? `${e.key}:${e.outcome}` : e.type), ['started', 'proc-a:cancelled', 'cancelled']);
  assert.equal(finalized, true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w packages/machine`
Expected: FAIL, because `inspect`, `plan` and `execute` are not exported.

- [ ] **Step 3: Implement `model.ts`**

```ts
import type { Effect } from 'effect';
import { TARGETS, type DesiredConfig, type Origin, type Target } from '@nortuscc/profile-engine';

export type DomainName = 'config' | 'integrations' | 'skills';
// The one cross-domain verdict: status, pickers and the app read it, and exit codes derive from it.
export type Disposition = 'in-sync' | 'apply' | 'capture' | 'blocked' | 'excluded' | 'undeclared';

export type Observed = {
  readonly key: string;
  readonly domain: DomainName;
  readonly target: Target;
  readonly label: string;
  readonly group: string;
  readonly state: string;
  readonly disposition: Disposition;
  readonly note?: string;
  readonly from?: Origin;
};

export type MachineReport = {
  readonly desired: DesiredConfig;
  readonly items: ReadonlyArray<Observed>;
  readonly probeErrors: ReadonlyArray<string>;
};

export type InstallCategory = 'hooks' | 'mcp' | 'plugins' | 'skills';

// Run-time choices the engine deliberately does not resolve.
export type Selection = {
  readonly targets: ReadonlyArray<Target>;
  readonly declined: ReadonlyArray<InstallCategory>;
  readonly only?: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
  readonly force: boolean;
};

export const selectAll: Selection = { targets: TARGETS, declined: [], exclude: [], force: false };

export type PlanKind = 'apply' | 'uninstall' | 'capture';
export type StepAction =
  | 'write-file' | 'merge-keys' | 'restore' | 'remove' | 'capture-file' | 'write-manifest' | 'install-integration' | 'install-skills';

export type Step = {
  readonly key: string;
  readonly domain: DomainName;
  readonly action: StepAction;
  readonly summary: string;
  readonly touches: ReadonlyArray<string>;
  // false: a unit that always completes once started (file writes); true: cancellable (installers).
  readonly interruptible: boolean;
};

export type Skipped = { readonly key: string; readonly reason: string };
export type Plan = { readonly kind: PlanKind; readonly steps: ReadonlyArray<Step>; readonly skipped: ReadonlyArray<Skipped> };
export type StepResult = { readonly ok: boolean; readonly note?: string };

export type Progress =
  | { readonly type: 'started'; readonly index: number; readonly total: number; readonly step: Step }
  | {
    readonly type: 'finished'; readonly index: number; readonly total: number; readonly key: string;
    readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string;
  }
  | { readonly type: 'done'; readonly ok: number; readonly failed: number; readonly backups?: string }
  | { readonly type: 'cancelled'; readonly remaining: ReadonlyArray<string>; readonly backups?: string };

// One area of a machine: how to observe it, which steps reconcile it, and how to run one.
export type Domain<R = never> = {
  readonly name: DomainName;
  readonly inspect: (desired: DesiredConfig) => Effect.Effect<{ items: ReadonlyArray<Observed>; probeErrors: ReadonlyArray<string> }, never, R>;
  readonly steps: (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind) =>
    { steps: ReadonlyArray<Step>; skipped: ReadonlyArray<Skipped> };
  readonly run: (step: Step) => Effect.Effect<StepResult, unknown, R>;
};
```

- [ ] **Step 4: Implement `run.ts`**

```ts
import { Cause, Effect, Exit, Queue, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { acquireApplyLock } from './apply-lock.ts';
import { Backups } from './backups.ts';
import type { LockHeld } from './errors.ts';
import type { MachinePaths } from './paths.ts';
import type { Domain, MachineReport, Plan, PlanKind, Progress, Selection, Skipped, Step, StepResult } from './model.ts';

export const inspect = <R>(desired: DesiredConfig, domains: ReadonlyArray<Domain<R>>): Effect.Effect<MachineReport, never, R> =>
  Effect.gen(function* () {
    const items = [];
    const probeErrors = [];
    for (const domain of domains) {
      const part = yield* domain.inspect(desired);
      items.push(...part.items);
      probeErrors.push(...part.probeErrors);
    }
    return { desired, items, probeErrors };
  });

// Pure: decides what would happen, including what will not and why.
export const plan = <R>(kind: PlanKind, report: MachineReport, selection: Selection, domains: ReadonlyArray<Domain<R>>): Plan => {
  const skipped: Skipped[] = [];
  const chosen = report.items.filter((item) => {
    const keep = !selection.exclude.includes(item.key) && (selection.only === undefined || selection.only.includes(item.key));
    if (!keep) skipped.push({ key: item.key, reason: 'not selected' });
    return keep;
  });
  const steps: Step[] = [];
  for (const domain of domains) {
    const part = domain.steps(chosen.filter((item) => item.domain === domain.name), selection, kind);
    steps.push(...part.steps);
    skipped.push(...part.skipped);
  }
  return { kind, steps, skipped };
};

const whenAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

type Outcome = { readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string };

const settle = (exit: Exit.Exit<StepResult, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { outcome: exit.value.ok ? 'ok' : 'failed', note: exit.value.note ?? '' };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: 'cancelled', note: 'cancelled' };
  const error = Cause.squash(exit.cause);
  return { outcome: 'failed', note: error instanceof Error ? error.message : String(error) };
};

// The only executor. Holds the apply lock, runs steps in order, and stops cleanly when the signal fires.
export const execute = <R>(
  plan: Plan,
  domains: ReadonlyArray<Domain<R>>,
  options: { readonly signal?: AbortSignal } = {},
): Stream.Stream<Progress, LockHeld, R | MachinePaths | Backups> =>
  Stream.callback<Progress, LockHeld, R | MachinePaths | Backups>((queue) =>
    Effect.gen(function* () {
      yield* acquireApplyLock;
      const backups = yield* Backups;
      const signal = options.signal ?? new AbortController().signal;
      const total = plan.steps.length;
      let ok = 0;
      let failed = 0;

      for (const [index, step] of plan.steps.entries()) {
        if (signal.aborted) {
          yield* Queue.offer(queue, { type: 'cancelled', remaining: plan.steps.slice(index).map((s) => s.key), backups: yield* backups.dir });
          return yield* Queue.end(queue);
        }
        yield* Queue.offer(queue, { type: 'started', index, total, step });
        const domain = domains.find((d) => d.name === step.domain);
        const body: Effect.Effect<StepResult, unknown, R> = domain
          ? domain.run(step)
          : Effect.succeed({ ok: false, note: `no domain for ${step.domain}` });
        const result = step.interruptible
          ? settle(yield* Effect.exit(Effect.raceFirst(body, Effect.andThen(whenAborted(signal), Effect.interrupt))))
          : settle(yield* Effect.exit(Effect.uninterruptible(body)));
        if (result.outcome === 'ok') ok++;
        else if (result.outcome === 'failed') failed++;
        yield* Queue.offer(queue, { type: 'finished', index, total, key: step.key, ...result });
        if (result.outcome === 'cancelled') {
          yield* Queue.offer(queue, { type: 'cancelled', remaining: plan.steps.slice(index + 1).map((s) => s.key), backups: yield* backups.dir });
          return yield* Queue.end(queue);
        }
      }
      yield* Queue.offer(queue, { type: 'done', ok, failed, backups: yield* backups.dir });
      yield* Queue.end(queue);
    }).pipe(Effect.catch((error: LockHeld) => Queue.fail(queue, error))),
  );
```

Effect 4 notes:
- **`Effect.raceFirst` with an interrupt:** if the losing side's `Effect.interrupt` makes the race report an interruption where the test expects `cancelled`, `settle` already maps interrupt-only causes to `cancelled`. If the whole fiber gets interrupted instead, race the body against `Effect.as(whenAborted(signal), { ok: false, note: 'cancelled', cancelled: true })` and map that sentinel to `cancelled`.
- **Verifying the names:** `Cause.hasInterruptsOnly`, `Cause.squash`, `Effect.catch`, `Queue.offer`, `Queue.end` and `Queue.fail` exist in effect 4.0.1.

Export `model.ts` and `run.ts` from `index.ts`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS, including all 7 run tests.

- [ ] **Step 6: Write `packages/machine/README.md`**

```markdown
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
```

- [ ] **Step 7: Commit**

```bash
git add packages/machine
git commit -m "feat: add the item model, planner and cancellable executor"
```

---

### Task 7: Launcher and `main.ts` dispatch

**Files:**
- Create: `bin/commands.mjs`, `bin/launcher.mjs`, `src/main.ts`, `tsconfig.json`, `test/launcher.test.mjs`, `test/main.test.ts`
- Rewrite: `bin/nortuscc.mjs`
- Modify: `test/package-bootstrap.test.mjs`, `package.json` (`typecheck` script)

**Interfaces:**
- Produces:

```js
// bin/commands.mjs
export const VERBS: string[]      // ['setup','status','apply','capture','pull','push','update','uninstall']
export const PORTED: string[]     // verbs with a src/commands/<verb>.ts; [] in this task
export const USAGE: string        // today's usage text, verbatim
// bin/launcher.mjs
export function isCheckout(root: string): boolean            // root is not inside node_modules and has .git
export function missingRuntime(root: string): boolean        // node_modules/effect/package.json is absent
export function recordedCheckout(env, home, platform): string | null  // state.json repo when it is a nortuscc checkout
export const RUNTIME_INSTALL: string[]                       // npm argv installing runtime deps only
// src/main.ts
export async function main(argv: string[]): Promise<number>
```

How the launcher routes:
1. Node older than 24: print `nortuscc needs Node.js 24 or later (found <version>)` and exit 2.
2. No verb, or `--help`/`-h`: print `USAGE` and exit 0. An unknown verb: print the error and `USAGE` to stderr, and exit 2. Steps 1–2 run before anything else and need no dependencies.
3. When `isCheckout(root)`: if `missingRuntime(root)`, run `npm <RUNTIME_INSTALL>` in `root` with inherited stdio. Then `import('../src/main.ts')` and exit with `main(argv)`.
4. Otherwise (an `npx` copy):
   - A verb **not** in `PORTED`: import `../src/commands/<verb>.mjs` directly, as today.
   - A verb in `PORTED`: take `recordedCheckout(...)` and run `node <checkout>/bin/nortuscc.mjs <verb> …args` with inherited stdio, exiting with its status. With no checkout recorded: `nortuscc: '<verb>' needs a nortuscc checkout. Run 'npx github:Nortus222/claude-config setup' first.` and exit 2.

`main.ts` sends a verb in `PORTED` to `./commands/<verb>.ts`, and every other verb to `./commands/<verb>.mjs`. Both export `run(args): Promise<number>`.

- [ ] **Step 1: Verify the runtime-only install command**

In a scratch clone, check which npm invocation installs only the runtime packages:

```bash
tmp=$(mktemp -d) && git clone -q "$PWD" "$tmp/c" && cd "$tmp/c" && git checkout -q "$(git -C "$OLDPWD" rev-parse HEAD)"
npm ci --omit=dev --include-workspace-root --workspace=packages/profile-engine --workspace=packages/machine --no-audit --no-fund
ls node_modules/effect/package.json node_modules/@nortuscc; ls node_modules/react 2>&1 | head -1; cd "$OLDPWD"
```

Expected: `effect` is present, `@nortuscc/machine` and `@nortuscc/profile-engine` are symlinked, and `react` is absent. If npm rejects the workspace filter, fall back to `['ci', '--omit=dev', '--no-audit', '--no-fund']`. Record the working argv as `RUNTIME_INSTALL` in Step 5.

- [ ] **Step 2: Write the failing launcher test**

`test/launcher.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCheckout, missingRuntime, recordedCheckout } from '../bin/launcher.mjs';
import { PORTED, VERBS } from '../bin/commands.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'nortuscc-launcher-'));
const nortuscc = (dir) => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin', 'nortuscc.mjs'), '');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'nortuscc', bin: { nortuscc: './bin/nortuscc.mjs' } }));
  return dir;
};

test('a git checkout outside node_modules is a checkout', () => {
  const dir = nortuscc(join(scratch(), 'claude-config'));
  assert.equal(isCheckout(dir), true);
});

test('an npx copy under node_modules is not a checkout even with .git', () => {
  const dir = nortuscc(join(scratch(), 'node_modules', 'nortuscc'));
  assert.equal(isCheckout(dir), false);
});

test('missingRuntime is true until effect is installed', () => {
  const dir = scratch();
  assert.equal(missingRuntime(dir), true);
  mkdirSync(join(dir, 'node_modules', 'effect'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'effect', 'package.json'), '{}');
  assert.equal(missingRuntime(dir), false);
});

test('recordedCheckout accepts only an existing nortuscc checkout', () => {
  const home = scratch();
  const state = join(home, '.config', 'nortuscc');
  mkdirSync(state, { recursive: true });
  const write = (repo) => writeFileSync(join(state, 'state.json'), JSON.stringify({ repo, files: {} }));
  write(join(home, 'gone'));
  assert.equal(recordedCheckout({}, home, 'darwin'), null);
  const repo = nortuscc(join(home, 'claude-config'));
  write(repo);
  assert.equal(recordedCheckout({}, home, 'darwin'), repo);
  assert.equal(recordedCheckout({ NORTUSCC_STATE_DIR: join(home, 'elsewhere') }, home, 'darwin'), null);
});

test('PORTED is a subset of VERBS', () => {
  assert.ok(PORTED.every((verb) => VERBS.includes(verb)));
});
```

- [ ] **Step 3: Write the failing dispatch test**

`test/main.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/nortuscc.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('--help prints usage without loading any command', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^nortuscc — keep this machine in agreement with claude-config/);
});

test('an unknown command exits 2 with usage', () => {
  const result = run('frobnicate');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'frobnicate'/);
});

test('an unported command reaches its legacy module through main.ts', () => {
  const result = run('uninstall', '--target', 'all');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Re-run with --yes to confirm/);
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `node --test test/launcher.test.mjs test/main.test.ts`
Expected: FAIL, because `bin/launcher.mjs` and `bin/commands.mjs` do not exist.

- [ ] **Step 5: Implement `bin/commands.mjs`, `bin/launcher.mjs` and `bin/nortuscc.mjs`**

`bin/commands.mjs`: move `VERBS` and the `USAGE` template literal **verbatim** from today's `bin/nortuscc.mjs`, then add:

```js
// Commands whose implementation is TypeScript (src/commands/<verb>.ts). An npx copy cannot
// run TypeScript from node_modules, so it hands these to the recorded checkout.
export const PORTED = [];
```

`bin/launcher.mjs`:

```js
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

// Runtime dependencies only: an end-user checkout never needs the desktop app's toolchain.
export const RUNTIME_INSTALL = [
  'ci', '--omit=dev', '--include-workspace-root',
  '--workspace=packages/profile-engine', '--workspace=packages/machine',
  '--no-audit', '--no-fund',
];

// Node will not strip TypeScript under node_modules, so only a real checkout may load src/main.ts.
export function isCheckout(root) {
  return !root.split(sep).includes('node_modules') && existsSync(join(root, '.git'));
}

export function missingRuntime(root) {
  return !existsSync(join(root, 'node_modules', 'effect', 'package.json'));
}

function isNortusccCheckout(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.name === 'nortuscc' && existsSync(join(dir, '.git')) && existsSync(join(dir, 'bin', 'nortuscc.mjs'));
  } catch {
    return false;
  }
}

// The checkout setup recorded in state.json, when it still is one; the same stateRoot rule as the CLI.
export function recordedCheckout(env, home, platform) {
  const stateRoot = env.NORTUSCC_STATE_DIR
    || (platform === 'win32' ? join(env.APPDATA ?? '', 'nortuscc') : join(home, '.config', 'nortuscc'));
  try {
    const { repo } = JSON.parse(readFileSync(join(stateRoot, 'state.json'), 'utf8'));
    return typeof repo === 'string' && isNortusccCheckout(repo) ? repo : null;
  } catch {
    return null;
  }
}
```

`bin/nortuscc.mjs`:

```js
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTED, USAGE, VERBS } from './commands.mjs';
import { isCheckout, missingRuntime, recordedCheckout, RUNTIME_INSTALL } from './launcher.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`nortuscc needs Node.js 24 or later (found ${process.versions.node})`);
  process.exit(2);
}

const [verb, ...rest] = process.argv.slice(2);
if (!verb || verb === '--help' || verb === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (!VERBS.includes(verb)) {
  console.error(`nortuscc: unknown command '${verb}'\n`);
  console.error(USAGE);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (isCheckout(root)) {
  if (missingRuntime(root)) {
    console.error(`nortuscc: installing runtime dependencies in ${root}`);
    const installed = spawnSync(npm, RUNTIME_INSTALL, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (installed.status !== 0) {
      console.error(`nortuscc: could not install dependencies; run 'npm ci' in ${root}`);
      process.exit(1);
    }
  }
  const { main } = await import('../src/main.ts');
  process.exit(await main([verb, ...rest]));
}

// An npx copy: legacy JavaScript still runs here; TypeScript commands run from the checkout.
if (!PORTED.includes(verb)) {
  const { run } = await import(`../src/commands/${verb}.mjs`);
  process.exit(await run(rest));
}
const checkout = recordedCheckout(process.env, homedir(), process.platform);
if (!checkout) {
  console.error(`nortuscc: '${verb}' needs a nortuscc checkout. Run 'npx github:Nortus222/claude-config setup' first.`);
  process.exit(2);
}
const handed = spawnSync(process.execPath, [join(checkout, 'bin', 'nortuscc.mjs'), verb, ...rest], { stdio: 'inherit' });
process.exit(handed.status ?? 1);
```

`src/main.ts`:

```ts
import { PORTED } from '../bin/commands.mjs';

type Command = { run: (args: string[]) => Promise<number> };

// Routes a verb to its TypeScript port when one exists, else to the legacy module.
export async function main([verb, ...args]: string[]): Promise<number> {
  const module: Command = PORTED.includes(verb!)
    ? await import(`./commands/${verb}.ts`)
    : await import(`./commands/${verb}.mjs`);
  return module.run(args);
}
```

Root `tsconfig.json`: copy `packages/profile-engine/tsconfig.json`, but set `"include": ["src/**/*.ts", "test/**/*.ts"]` and keep `"allowJs": true, "checkJs": false`, so `.mjs` imports type as `any`. Change the root `typecheck` script to `"tsc --noEmit && npm run typecheck --workspaces --if-present"`.

- [ ] **Step 6: Run the new tests**

Run: `node --test test/launcher.test.mjs test/main.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Extend the packed-install test**

Add these to `test/package-bootstrap.test.mjs`. They reuse its existing `stage`/`prefix`/`command` setup; extract that setup into a `before` hook or a shared helper so it is packed once.

```js
test('a packed copy runs unported commands itself', { skip: !npmCli }, () => {
  const result = spawnSync(command, ['uninstall', '--target', 'all'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Re-run with --yes to confirm/);
});
```

Also add a test of the npx-copy hand-off for a ported verb. It temporarily needs a ported verb, so it builds a fake package root: copy the packed `bin/` into `join(stage, 'node_modules', 'nortuscc', 'bin')`, write a `commands.mjs` there whose `PORTED = ['status']`, and record `state.json` with `repo` set to this checkout. Then:
- Run `node <copy>/bin/nortuscc.mjs status --strict --target bogus`. Expect exit 2 and the checkout's own "invalid target" message, which proves the hand-off reached the checkout.
- With `state.json` recording a missing path, expect exit 2 and `/needs a nortuscc checkout/`.

- [ ] **Step 8: Run the whole root suite, then the packages**

Run: `npm test; git status --short; npm run test:packages && npm run typecheck`
Expected: everything passes. Restore `skills-manifest.txt` if the root suite rewrote it.

- [ ] **Step 9: Commit**

```bash
git add bin src/main.ts tsconfig.json test/launcher.test.mjs test/main.test.ts test/package-bootstrap.test.mjs package.json
git commit -m "feat: route commands through a launcher that hands TypeScript commands to the checkout"
```

---

## Finish

- [ ] Review `git diff main...HEAD`.
- [ ] Run `npm test; git status --short`, then `npm run test:packages`, then `npm run typecheck`. Restore any `skills-manifest.txt` leak.
- [ ] Push the branch and open the PR against `main`. It closes #54 and refers to #42. The PR body ends with `Model: Claude Opus 5.5 · Harness: Claude Code`.
- [ ] Launch the parallel threads for #55–#58 with `t3_thread_launch`, each in a new worktree (`baseRef` = this branch, `startFromOrigin: false`). Each message names its issue, the spec and this plan's Interfaces, and asks for a stacked PR against this branch.
