# nortuscc CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four sync shell scripts with one Node CLI, `nortuscc`, that keeps a machine's Claude config and skill set in agreement with this repo and reports every divergence instead of letting it go silent.

**Architecture:** A declarative sync manifest names each path and whether it is linked (agent never writes it) or copied (agent rewrites it). A machine-local lockfile stores the content hash of each copied file at last sync, so a three-way comparison against repo and local yields one of four states, conflicts included. Skills reuse the same directional verbs, delegating all fetching to `npx skills`. Commands are thin; the logic worth testing is pure.

**Tech Stack:** Node 18+, plain ESM `.mjs`, no build step, no runtime dependencies. Tests use the built-in `node:test` runner and `node:assert/strict`. Git and `npx skills` are invoked as subprocesses via `node:child_process`.

**Spec:** `docs/superpowers/specs/2026-08-02-nortuscc-cli-design.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` has no `dependencies` block. Test-only tooling is also disallowed — `node:test` and `node:assert/strict` cover it.
- **Plain ESM `.mjs`, no build step.** `"type": "module"` in `package.json`. No TypeScript, no bundler, no transpile.
- **Node 18+.** `"engines": { "node": ">=18" }`. Use `node:` prefixed builtin imports throughout.
- **The command name is `nortuscc`.** Binary, help text, and all error messages use it.
- **Lockfile path is `~/.claude/.nortuscc-lock.json`.** Machine-local; never written into the repo.
- **Hashing normalises line endings** (`\r\n` → `\n`) before digesting, so a CRLF checkout does not read as permanent drift.
- **Nothing destructive runs without a backup first**, written to `~/.claude/backups/nortuscc-<stamp>/` preserving relative paths.
- **`status` never writes anything**, including no lockfile updates.
- **`apply` never removes a skill.** Extra skills are reported, never deleted.
- **All `npx skills` invocation is confined to `src/skills-cli.mjs`.** No other module spawns it.
- **Windows directory links use junctions** (`fs.symlinkSync(target, path, 'junction')`), which need no elevation.
- **Commit after every task.** Conventional-commit prefixes (`feat:`, `test:`, `docs:`, `chore:`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `package.json` | Name, `type: module`, `bin` mapping, `test` script, engines |
| `bin/nortuscc.mjs` | Argument parsing and dispatch. No business logic |
| `src/resolve.mjs` | Locate repo root, `~/.claude`, `~/.agents/skills` on this machine |
| `src/manifest.mjs` | The `SYNC` table — single source of truth for what syncs and how |
| `src/lock.mjs` | Content hashing and lockfile read/write |
| `src/state.mjs` | Pure state functions for copied files and linked dirs |
| `src/backup.mjs` | Timestamped backups before any destructive write |
| `src/link.mjs` | Create and inspect directory links |
| `src/copy.mjs` | Copy files in one direction |
| `src/plugins.mjs` | Plugin gap report (ports `plugin-check.sh`) |
| `src/skills.mjs` | Manifest parse/emit and desired-vs-installed reconciliation |
| `src/skills-cli.mjs` | The only place `npx skills` is spawned |
| `src/report.mjs` | Output formatting shared by all commands |
| `src/commands/*.mjs` | One file per verb: `status`, `apply`, `capture`, `setup`, `pull`, `push` |
| `test/*.test.mjs` | One test file per module under test |

---

### Task 1: Scaffold, path resolution, and the sync manifest

**Files:**
- Create: `package.json`
- Create: `bin/nortuscc.mjs`
- Create: `src/resolve.mjs`
- Create: `src/manifest.mjs`
- Test: `test/manifest.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SYNC: Array<{src: string, dest: string, mode: 'link'|'copy'}>` from `src/manifest.mjs`
  - `repoRoot(): string` — absolute path to this repo, derived from the module's own location
  - `claudeDir(): string` — absolute path to `~/.claude`
  - `agentsSkillsDir(): string` — absolute path to `~/.agents/skills`
  - `resolveEntry(entry): {src: string, dest: string, mode: string}` — manifest entry with both sides made absolute

- [ ] **Step 1: Write the failing test**

Create `test/manifest.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SYNC } from '../src/manifest.mjs';
import { resolveEntry, repoRoot, claudeDir } from '../src/resolve.mjs';

test('every manifest entry resolves to a path that exists in the repo', () => {
  assert.ok(SYNC.length > 0, 'manifest must not be empty');
  for (const entry of SYNC) {
    const { src } = resolveEntry(entry);
    assert.ok(existsSync(src), `manifest source missing from repo: ${entry.src}`);
  }
});

test('every manifest entry declares a valid mode', () => {
  for (const entry of SYNC) {
    assert.ok(['link', 'copy'].includes(entry.mode), `bad mode on ${entry.src}: ${entry.mode}`);
  }
});

test('manifest dest paths are relative and land under ~/.claude', () => {
  for (const entry of SYNC) {
    assert.ok(!entry.dest.startsWith('/'), `dest must be relative: ${entry.dest}`);
    const { dest } = resolveEntry(entry);
    assert.ok(dest.startsWith(claudeDir()), `dest escaped ~/.claude: ${dest}`);
  }
});

test('repoRoot points at the repo containing package.json', () => {
  assert.ok(existsSync(`${repoRoot()}/package.json`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/manifest.test.mjs`
Expected: FAIL — `Cannot find module '../src/manifest.mjs'`

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "nortuscc",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "description": "Keep a machine's Claude config and skill set in agreement with claude-config",
  "bin": { "nortuscc": "./bin/nortuscc.mjs" },
  "scripts": { "test": "node --test test/" },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 4: Write `src/manifest.mjs`**

```js
// The single source of truth for what syncs and how.
//
// mode: 'link' — an agent never writes this path, so a symlink is safe and gives
//                live sync. Directories only.
// mode: 'copy' — Claude Code rewrites this file in place, which would silently
//                replace a symlink with a regular file. Copy it and track a hash.
export const SYNC = [
  { src: 'claude/bin', dest: 'bin', mode: 'link' },
  { src: 'claude/hooks', dest: 'hooks', mode: 'link' },
  { src: 'claude/settings.json', dest: 'settings.json', mode: 'copy' },
  { src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
];
```

- [ ] **Step 5: Write `src/resolve.mjs`**

```js
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// src/ lives directly under the repo root.
export function repoRoot() {
  return resolve(here, '..');
}

export function claudeDir() {
  return process.env.NORTUSCC_CLAUDE_DIR || join(homedir(), '.claude');
}

export function agentsSkillsDir() {
  return process.env.NORTUSCC_AGENTS_DIR || join(homedir(), '.agents', 'skills');
}

export function lockPath() {
  return join(claudeDir(), '.nortuscc-lock.json');
}

export function backupRoot() {
  return join(claudeDir(), 'backups');
}

// Turn a manifest entry into absolute paths on both sides.
export function resolveEntry(entry) {
  return {
    ...entry,
    src: join(repoRoot(), entry.src),
    dest: join(claudeDir(), entry.dest),
  };
}
```

The `NORTUSCC_CLAUDE_DIR` and `NORTUSCC_AGENTS_DIR` overrides exist so later tasks can point the whole CLI at a temp directory during tests.

- [ ] **Step 6: Write `bin/nortuscc.mjs`**

```js
#!/usr/bin/env node
const VERBS = ['setup', 'status', 'apply', 'capture', 'pull', 'push'];

const USAGE = `nortuscc — keep this machine in agreement with claude-config

Usage: nortuscc <command> [options]

Commands:
  setup [--repo URL] [--dir PATH]   clone if absent, apply, install skills, report
  status                            read-only: config / plugins / skills
  apply [--skills] [--take-repo|--take-local]
                                    repo -> machine
  capture [--take-repo|--take-local]
                                    machine -> repo
  pull                              git pull --ff-only, then apply
  push -m MSG                       capture, then commit and push

Run 'nortuscc status' first; it changes nothing.`;

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

const { run } = await import(`../src/commands/${verb}.mjs`);
process.exit(await run(rest));
```

- [ ] **Step 7: Create placeholder command modules so dispatch resolves**

For each of the six verbs, create `src/commands/<verb>.mjs` with this exact body, substituting the verb name:

```js
export async function run() {
  console.error('nortuscc: not implemented yet');
  return 1;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — 4 tests.

- [ ] **Step 9: Verify dispatch by hand**

Run: `node bin/nortuscc.mjs --help`
Expected: usage text, exit 0.

Run: `node bin/nortuscc.mjs bogus`
Expected: `unknown command 'bogus'`, exit 2.

- [ ] **Step 10: Commit**

```bash
git add package.json bin/ src/ test/
git commit -m "feat: scaffold nortuscc with path resolution and the sync manifest"
```

---

### Task 2: Content hashing and the lockfile

**Files:**
- Create: `src/lock.mjs`
- Test: `test/lock.test.mjs`

**Interfaces:**
- Consumes: `lockPath()` from `src/resolve.mjs`
- Produces:
  - `hashFile(path): string|null` — `sha256:<hex>` of the file with line endings normalised, or `null` if absent
  - `hashText(text): string` — same digest for an in-memory string
  - `readLock(): {version: number, repo: string|null, files: Record<string, {hash: string, appliedAt: string}>}` — a valid empty lock if the file is missing or unparseable
  - `writeLock(lock): void`
  - `setBaseline(lock, dest, hash): void` — mutates `lock.files[dest]`, stamping `appliedAt`

- [ ] **Step 1: Write the failing test**

Create `test/lock.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nortuscc-lock-'));
process.env.NORTUSCC_CLAUDE_DIR = dir;

const { hashFile, hashText, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');

test('hashText is stable and prefixed', () => {
  const h = hashText('hello');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, hashText('hello'));
});

test('CRLF and LF hash identically', () => {
  assert.equal(hashText('a\r\nb\r\n'), hashText('a\nb\n'));
});

test('different content hashes differently', () => {
  assert.notEqual(hashText('a'), hashText('b'));
});

test('hashFile returns null for a missing file', () => {
  assert.equal(hashFile(join(dir, 'nope.txt')), null);
});

test('hashFile matches hashText for the same content', () => {
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'contents\n');
  assert.equal(hashFile(f), hashText('contents\n'));
});

test('readLock returns an empty lock when no file exists', () => {
  const lock = readLock();
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.files, {});
});

test('readLock survives a corrupt lockfile', () => {
  writeFileSync(join(dir, '.nortuscc-lock.json'), '{ not json');
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  rmSync(join(dir, '.nortuscc-lock.json'));
});

test('writeLock then readLock round-trips', () => {
  const lock = readLock();
  setBaseline(lock, 'settings.json', hashText('v1'));
  lock.repo = '/some/repo';
  writeLock(lock);

  const again = readLock();
  assert.equal(again.repo, '/some/repo');
  assert.equal(again.files['settings.json'].hash, hashText('v1'));
  assert.match(again.files['settings.json'].appliedAt, /^\d{4}-\d{2}-\d{2}T/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lock.test.mjs`
Expected: FAIL — `Cannot find module '../src/lock.mjs'`

- [ ] **Step 3: Write `src/lock.mjs`**

```js
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { lockPath } from './resolve.mjs';

const LOCK_VERSION = 1;

// Line endings are normalised before digesting so that a CRLF checkout on
// Windows does not read as permanent drift against an LF repo.
export function hashText(text) {
  const normalised = text.replace(/\r\n/g, '\n');
  return 'sha256:' + createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export function hashFile(path) {
  if (!existsSync(path)) return null;
  return hashText(readFileSync(path, 'utf8'));
}

function emptyLock() {
  return { version: LOCK_VERSION, repo: null, files: {} };
}

// A missing or corrupt lockfile is treated as first run rather than as an
// error: every managed file then reads as 'unmanaged', which backs up before
// writing instead of overwriting blind.
export function readLock() {
  const path = lockPath();
  if (!existsSync(path)) return emptyLock();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.files) return emptyLock();
    return { version: parsed.version ?? LOCK_VERSION, repo: parsed.repo ?? null, files: parsed.files };
  } catch {
    return emptyLock();
  }
}

export function writeLock(lock) {
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

export function setBaseline(lock, dest, hash) {
  lock.files[dest] = { hash, appliedAt: new Date().toISOString() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lock.test.mjs`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lock.mjs test/lock.test.mjs
git commit -m "feat: content hashing and lockfile read/write"
```

---

### Task 3: The state machine

**Files:**
- Create: `src/state.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Consumes: nothing — this module is pure and imports nothing
- Produces:
  - `fileState({baseline, repo, local}): string` — one of `clean`, `repo-ahead`, `local-ahead`, `conflict`, `unmanaged`, `missing-repo`
  - `linkState({exists, isSymlink, target, expectedTarget}): string` — one of `linked`, `missing`, `clobbered`, `wrong-target`
  - `NEEDS_APPLY: Set<string>`, `NEEDS_CAPTURE: Set<string>`, `BLOCKED: Set<string>` — state groupings the commands use

- [ ] **Step 1: Write the failing test**

Create `test/state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileState, linkState, NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../src/state.mjs';

const A = 'sha256:aaa', B = 'sha256:bbb', C = 'sha256:ccc';

test('unchanged on both sides is clean', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: A }), 'clean');
});

test('only the repo moved is repo-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: A }), 'repo-ahead');
});

test('only the local moved is local-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: B }), 'local-ahead');
});

test('both moved apart is a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: C }), 'conflict');
});

test('both moved to the SAME content is clean, not a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: B }), 'clean');
});

test('no baseline is unmanaged', () => {
  assert.equal(fileState({ baseline: null, repo: A, local: A }), 'unmanaged');
});

test('missing from the repo is missing-repo regardless of the rest', () => {
  assert.equal(fileState({ baseline: A, repo: null, local: A }), 'missing-repo');
  assert.equal(fileState({ baseline: null, repo: null, local: null }), 'missing-repo');
});

test('local deleted since baseline is repo-ahead, so apply restores it', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: null }), 'repo-ahead');
});

test('local deleted while the repo also moved is still repo-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: null }), 'repo-ahead');
});

test('a correct symlink is linked', () => {
  assert.equal(linkState({ exists: true, isSymlink: true, target: '/r/bin', expectedTarget: '/r/bin' }), 'linked');
});

test('a real directory where a link belongs is clobbered', () => {
  assert.equal(linkState({ exists: true, isSymlink: false, target: null, expectedTarget: '/r/bin' }), 'clobbered');
});

test('a symlink pointing elsewhere is wrong-target', () => {
  assert.equal(linkState({ exists: true, isSymlink: true, target: '/old/bin', expectedTarget: '/r/bin' }), 'wrong-target');
});

test('nothing there is missing', () => {
  assert.equal(linkState({ exists: false, isSymlink: false, target: null, expectedTarget: '/r/bin' }), 'missing');
});

test('state groupings partition the actionable states', () => {
  assert.ok(NEEDS_APPLY.has('repo-ahead'));
  assert.ok(NEEDS_APPLY.has('unmanaged'));
  assert.ok(NEEDS_APPLY.has('missing'));
  assert.ok(NEEDS_APPLY.has('clobbered'));
  assert.ok(NEEDS_APPLY.has('wrong-target'));
  assert.ok(NEEDS_CAPTURE.has('local-ahead'));
  assert.ok(BLOCKED.has('conflict'));
  assert.ok(!NEEDS_APPLY.has('clean'));
  assert.ok(!NEEDS_APPLY.has('conflict'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.test.mjs`
Expected: FAIL — `Cannot find module '../src/state.mjs'`

- [ ] **Step 3: Write `src/state.mjs`**

```js
// Pure state derivation. No I/O, no imports — this is the part of the CLI
// most worth getting right, so it is kept trivially testable.

// Copied files: compare both sides against the baseline recorded at last sync.
// `repo` and `local` are hashes, or null when the file is absent.
export function fileState({ baseline, repo, local }) {
  if (repo === null || repo === undefined) return 'missing-repo';
  if (baseline === null || baseline === undefined) return 'unmanaged';

  // A deleted local file is recoverable from the repo, so treat it as the repo
  // being ahead rather than as a loss to adjudicate.
  if (local === null || local === undefined) return 'repo-ahead';

  // Both sides moved but landed on identical content — nothing to reconcile,
  // only a stale baseline. Checking this before the conflict branch keeps
  // convergence from being reported as a conflict.
  if (repo === local) return 'clean';

  const repoMoved = repo !== baseline;
  const localMoved = local !== baseline;

  if (!repoMoved && !localMoved) return 'clean';
  if (repoMoved && !localMoved) return 'repo-ahead';
  if (!repoMoved && localMoved) return 'local-ahead';
  return 'conflict';
}

// Linked directories: the failure the old scripts could not see is 'clobbered',
// where a real directory sits where a link belongs and syncing silently stopped.
export function linkState({ exists, isSymlink, target, expectedTarget }) {
  if (!exists) return 'missing';
  if (!isSymlink) return 'clobbered';
  if (target !== expectedTarget) return 'wrong-target';
  return 'linked';
}

export const NEEDS_APPLY = new Set(['repo-ahead', 'unmanaged', 'missing', 'clobbered', 'wrong-target']);
export const NEEDS_CAPTURE = new Set(['local-ahead']);
export const BLOCKED = new Set(['conflict', 'missing-repo']);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/state.test.mjs`
Expected: PASS — 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/state.mjs test/state.test.mjs
git commit -m "feat: pure state machine for copied files and linked dirs"
```

---

### Task 4: Backups and directory links

**Files:**
- Create: `src/backup.mjs`
- Create: `src/link.mjs`
- Test: `test/link.test.mjs`

**Interfaces:**
- Consumes: `backupRoot()` from `src/resolve.mjs`; `linkState` from `src/state.mjs`
- Produces:
  - `backupPath(relative): string` — destination inside this run's backup directory, parents created
  - `backupOnce(absPath, relative): string|null` — moves an existing path into the backup dir, returns where it went, or `null` if there was nothing there
  - `inspectLink(dest, expectedTarget): {state: string, target: string|null}`
  - `ensureLink(dest, target, relative): {state: string, backedUp: string|null}` — makes `dest` a link to `target`, backing up anything in the way

- [ ] **Step 1: Write the failing test**

Create `test/link.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-link-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { inspectLink, ensureLink } = await import('../src/link.mjs');

// A stand-in for the repo's claude/bin directory.
const repoBin = join(home, 'repo', 'claude', 'bin');
mkdirSync(repoBin, { recursive: true });
writeFileSync(join(repoBin, 'sp'), 'echo sp\n');

test('a missing destination reports missing', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-a');
  assert.equal(inspectLink(dest, repoBin).state, 'missing');
});

test('ensureLink creates a working link and the content is readable through it', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-b');
  const res = ensureLink(dest, repoBin, 'bin-b');
  assert.equal(res.state, 'linked');
  assert.equal(res.backedUp, null);
  assert.ok(lstatSync(dest).isSymbolicLink());
  assert.equal(readFileSync(join(dest, 'sp'), 'utf8'), 'echo sp\n');
  assert.equal(inspectLink(dest, repoBin).state, 'linked');
});

test('ensureLink is idempotent', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-c');
  ensureLink(dest, repoBin, 'bin-c');
  const second = ensureLink(dest, repoBin, 'bin-c');
  assert.equal(second.state, 'linked');
  assert.equal(second.backedUp, null, 'a clean re-run must not back anything up');
});

test('a real directory in the way is clobbered, and ensureLink backs it up', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-d');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'local-only.sh'), 'precious\n');
  assert.equal(inspectLink(dest, repoBin).state, 'clobbered');

  const res = ensureLink(dest, repoBin, 'bin-d');
  assert.equal(res.state, 'linked');
  assert.ok(res.backedUp, 'the displaced directory must be backed up');
  assert.equal(readFileSync(join(res.backedUp, 'local-only.sh'), 'utf8'), 'precious\n');
  assert.equal(readFileSync(join(dest, 'sp'), 'utf8'), 'echo sp\n');
});

test('a link to the wrong target is repointed', () => {
  const other = join(home, 'other');
  mkdirSync(other, { recursive: true });
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-e');
  ensureLink(dest, other, 'bin-e');
  assert.equal(inspectLink(dest, repoBin).state, 'wrong-target');

  const res = ensureLink(dest, repoBin, 'bin-e');
  assert.equal(res.state, 'linked');
  assert.equal(inspectLink(dest, repoBin).state, 'linked');
});

test('nothing is left behind in the claude dir that was not asked for', () => {
  assert.ok(existsSync(process.env.NORTUSCC_CLAUDE_DIR));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/link.test.mjs`
Expected: FAIL — `Cannot find module '../src/link.mjs'`

- [ ] **Step 3: Write `src/backup.mjs`**

```js
import { mkdirSync, renameSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { backupRoot } from './resolve.mjs';

// One backup directory per process run, so a single command's displacements
// stay together and are obvious to find afterwards.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
let runDir = null;

export function backupDir() {
  if (!runDir) {
    runDir = join(backupRoot(), `nortuscc-${STAMP}`);
    mkdirSync(runDir, { recursive: true });
  }
  return runDir;
}

export function backupPath(relative) {
  const target = join(backupDir(), relative);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

// Move whatever is at absPath into the backup directory. Returns where it went,
// or null if there was nothing to preserve. rename is tried first and falls back
// to copy+remove, since rename fails across volumes.
export function backupOnce(absPath, relative) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative);
  try {
    renameSync(absPath, target);
  } catch {
    cpSync(absPath, target, { recursive: true });
    rmSync(absPath, { recursive: true, force: true });
  }
  return target;
}
```

- [ ] **Step 4: Write `src/link.mjs`**

```js
import { lstatSync, readlinkSync, symlinkSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { linkState } from './state.mjs';
import { backupOnce } from './backup.mjs';

// Junctions need no elevation on Windows, where a plain directory symlink
// requires Developer Mode or admin. On other platforms 'dir' is correct.
const DIR_LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

export function inspectLink(dest, expectedTarget) {
  let stat = null;
  try {
    stat = lstatSync(dest);
  } catch {
    return { state: linkState({ exists: false }), target: null };
  }

  const isSymlink = stat.isSymbolicLink();
  let target = null;
  if (isSymlink) {
    try {
      target = resolve(readlinkSync(dest));
    } catch {
      target = null;
    }
  }

  return {
    state: linkState({ exists: true, isSymlink, target, expectedTarget: resolve(expectedTarget) }),
    target,
  };
}

export function ensureLink(dest, target, relative) {
  const { state } = inspectLink(dest, target);
  if (state === 'linked') return { state: 'linked', backedUp: null };

  let backedUp = null;
  if (state === 'wrong-target') {
    // A wrong link holds no content of its own, so remove it rather than
    // filling the backup directory with dangling links.
    rmSync(dest, { recursive: true, force: true });
  } else if (state === 'clobbered') {
    backedUp = backupOnce(dest, relative);
  }

  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(resolve(target), dest, DIR_LINK_TYPE);
  return { state: 'linked', backedUp };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/link.test.mjs`
Expected: PASS — 6 tests.

If the symlink calls fail with `EPERM` on Windows, the junction type is not being applied — check `DIR_LINK_TYPE` resolves to `'junction'` on `win32`.

- [ ] **Step 6: Commit**

```bash
git add src/backup.mjs src/link.mjs test/link.test.mjs
git commit -m "feat: backups and junction-based directory links"
```

---

### Task 5: Copying files with conflict refusal

**Files:**
- Create: `src/copy.mjs`
- Test: `test/copy.test.mjs`

**Interfaces:**
- Consumes: `hashFile`, `setBaseline` from `src/lock.mjs`; `fileState` from `src/state.mjs`; `backupOnce` from `src/backup.mjs`
- Produces:
  - `inspectCopy(src, dest, baseline): {state: string, repo: string|null, local: string|null}`
  - `applyCopy(src, dest, relative, lock, {force}): {action: string, backedUp: string|null}` — `action` is `copied`, `skipped`, or `refused`
  - `captureCopy(src, dest, relative, lock, {force}): {action: string, backedUp: string|null}` — same, in the other direction

- [ ] **Step 1: Write the failing test**

Create `test/copy.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-copy-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { inspectCopy, applyCopy, captureCopy } = await import('../src/copy.mjs');
const { hashText, readLock, setBaseline } = await import('../src/lock.mjs');

let n = 0;
function pair(repoText, localText) {
  n += 1;
  const src = join(home, `repo-${n}.json`);
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, `local-${n}.json`);
  writeFileSync(src, repoText);
  if (localText !== null) writeFileSync(dest, localText);
  return { src, dest, rel: `local-${n}.json` };
}

test('repo-ahead applies and updates the baseline', () => {
  const { src, dest, rel } = pair('v2', 'v1');
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'repo-ahead');

  const res = applyCopy(src, dest, rel, lock, {});
  assert.equal(res.action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'v2');
  assert.equal(lock.files[rel].hash, hashText('v2'));
});

test('local-ahead is skipped by apply and taken by capture', () => {
  const { src, dest, rel } = pair('v1', 'v2');
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'local-ahead');

  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
  assert.equal(readFileSync(dest, 'utf8'), 'v2', 'apply must not clobber a local edit');

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'copied');
  assert.equal(readFileSync(src, 'utf8'), 'v2');
  assert.equal(lock.files[rel].hash, hashText('v2'));
});

test('a conflict is refused by both directions and backs the loser up', () => {
  const { src, dest, rel } = pair('repo-change', 'local-change');
  const lock = readLock();
  setBaseline(lock, rel, hashText('base'));

  assert.equal(inspectCopy(src, dest, lock.files[rel].hash).state, 'conflict');

  const a = applyCopy(src, dest, rel, lock, {});
  assert.equal(a.action, 'refused');
  assert.ok(a.backedUp, 'a refusal must still preserve the local file');
  assert.equal(readFileSync(a.backedUp, 'utf8'), 'local-change');
  assert.equal(readFileSync(dest, 'utf8'), 'local-change', 'refusing must change nothing');

  assert.equal(captureCopy(src, dest, rel, lock, {}).action, 'refused');
  assert.equal(readFileSync(src, 'utf8'), 'repo-change');
});

test('force resolves a conflict in the requested direction', () => {
  const { src, dest, rel } = pair('repo-change', 'local-change');
  const lock = readLock();
  setBaseline(lock, rel, hashText('base'));

  const res = applyCopy(src, dest, rel, lock, { force: true });
  assert.equal(res.action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'repo-change');
  assert.equal(lock.files[rel].hash, hashText('repo-change'));
});

test('unmanaged backs up the local file before first write', () => {
  const { src, dest, rel } = pair('from-repo', 'pre-existing');
  const lock = readLock();

  assert.equal(inspectCopy(src, dest, undefined).state, 'unmanaged');

  const res = applyCopy(src, dest, rel, lock, {});
  assert.equal(res.action, 'copied');
  assert.ok(res.backedUp);
  assert.equal(readFileSync(res.backedUp, 'utf8'), 'pre-existing');
  assert.equal(readFileSync(dest, 'utf8'), 'from-repo');
});

test('a clean file is skipped and nothing is rewritten', () => {
  const { src, dest, rel } = pair('same', 'same');
  const lock = readLock();
  setBaseline(lock, rel, hashText('same'));
  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'skipped');
});

test('a missing local file is restored by apply', () => {
  const { src, dest, rel } = pair('v1', null);
  const lock = readLock();
  setBaseline(lock, rel, hashText('v1'));
  assert.equal(applyCopy(src, dest, rel, lock, {}).action, 'copied');
  assert.equal(readFileSync(dest, 'utf8'), 'v1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/copy.test.mjs`
Expected: FAIL — `Cannot find module '../src/copy.mjs'`

- [ ] **Step 3: Write `src/copy.mjs`**

```js
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashFile, setBaseline } from './lock.mjs';
import { fileState } from './state.mjs';
import { backupOnce, backupPath } from './backup.mjs';

// Copy into the backup directory without removing the original. A refusal must
// leave both sides exactly as they were, so this cannot use backupOnce, which
// moves.
function preserve(absPath, relative) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative);
  copyFileSync(absPath, target);
  return target;
}

export function inspectCopy(src, dest, baseline) {
  const repo = hashFile(src);
  const local = hashFile(dest);
  return { state: fileState({ baseline, repo, local }), repo, local };
}

function write(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// repo -> machine. Refuses a conflict unless force is set, and never touches a
// file whose only change is local.
export function applyCopy(src, dest, relative, lock, { force = false } = {}) {
  const baseline = lock.files[relative]?.hash;
  const { state, repo } = inspectCopy(src, dest, baseline);

  if (state === 'missing-repo') return { action: 'skipped', backedUp: null };
  if (state === 'clean' || state === 'local-ahead') {
    if (state === 'clean' && repo) setBaseline(lock, relative, repo);
    return { action: 'skipped', backedUp: null };
  }

  if (state === 'conflict' && !force) {
    // Preserve the local side even though nothing is being overwritten, so the
    // user can resolve from a stable copy while continuing to work.
    return { action: 'refused', backedUp: preserve(dest, relative) };
  }

  // unmanaged, repo-ahead, or a forced conflict: the local file is about to be
  // replaced, so keep whatever was there.
  const backedUp = existsSync(dest) ? backupOnce(dest, relative) : null;
  write(src, dest);
  setBaseline(lock, relative, hashFile(dest));
  return { action: 'copied', backedUp };
}

// machine -> repo. Mirrors applyCopy with the directions swapped.
export function captureCopy(src, dest, relative, lock, { force = false } = {}) {
  const baseline = lock.files[relative]?.hash;
  const { state, local } = inspectCopy(src, dest, baseline);

  if (state === 'missing-repo' || local === null) return { action: 'skipped', backedUp: null };
  if (state === 'clean' || state === 'repo-ahead') {
    if (state === 'clean' && local) setBaseline(lock, relative, local);
    return { action: 'skipped', backedUp: null };
  }

  if (state === 'conflict' && !force) {
    return { action: 'refused', backedUp: preserve(dest, relative) };
  }

  write(dest, src);
  setBaseline(lock, relative, hashFile(src));
  return { action: 'copied', backedUp: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/copy.test.mjs`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/copy.mjs test/copy.test.mjs
git commit -m "feat: file copying with conflict refusal and backups"
```

---

### Task 6: The status command, config section

**Files:**
- Create: `src/report.mjs`
- Modify: `src/commands/status.mjs` (replace the placeholder)
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `SYNC`, `resolveEntry`, `readLock`, `inspectLink`, `inspectCopy`
- Produces:
  - `configReport(): Array<{dest: string, mode: string, state: string}>` from `src/commands/status.mjs`
  - `run(args): Promise<number>` — exit code 0 when everything is clean, 1 when anything needs attention
  - `formatRow(label, state, note): string` and `section(title, lines): string` from `src/report.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/status.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-status-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { configReport } = await import('../src/commands/status.mjs');

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  for (const row of rows) {
    assert.ok(row.dest, 'each row names its destination');
    assert.ok(['link', 'copy'].includes(row.mode));
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  }
});

test('an empty claude dir reports nothing as clean', () => {
  const rows = configReport();
  const clean = rows.filter((r) => r.state === 'clean' || r.state === 'linked');
  assert.equal(clean.length, 0, 'a bare machine has no synced files yet');
});

test('link entries report missing on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'link');
  for (const row of rows) assert.equal(row.state, 'missing');
});

test('copy entries report unmanaged on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'copy');
  for (const row of rows) assert.equal(row.state, 'unmanaged');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/status.test.mjs`
Expected: FAIL — `configReport is not a function`

- [ ] **Step 3: Write `src/report.mjs`**

```js
const WIDTH = 16;

export function formatRow(label, state, note = '') {
  return `  ${label.padEnd(WIDTH)} ${state.padEnd(12)} ${note}`.trimEnd();
}

export function section(title, lines) {
  if (lines.length === 0) return `${title}\n  (nothing to report)\n`;
  return `${title}\n${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Write `src/commands/status.mjs`**

```js
import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock } from '../lock.mjs';
import { inspectLink } from '../link.mjs';
import { inspectCopy } from '../copy.mjs';
import { NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../state.mjs';
import { formatRow, section } from '../report.mjs';

// Read-only by construction: nothing here writes, including the lockfile.
export function configReport() {
  const lock = readLock();
  return SYNC.map((entry) => {
    const { src, dest, mode } = resolveEntry(entry);
    if (mode === 'link') {
      return { dest: entry.dest, mode, state: inspectLink(dest, src).state };
    }
    const baseline = lock.files[entry.dest]?.hash;
    return { dest: entry.dest, mode, state: inspectCopy(src, dest, baseline).state };
  });
}

export async function run() {
  const rows = configReport();
  const lines = rows.map((r) => formatRow(r.dest, r.state, noteFor(r)));
  process.stdout.write('\n' + section('config', lines));

  const actionable = rows.filter(
    (r) => NEEDS_APPLY.has(r.state) || NEEDS_CAPTURE.has(r.state) || BLOCKED.has(r.state),
  );

  if (actionable.length === 0) {
    process.stdout.write('\neverything is in agreement\n');
    return 0;
  }

  process.stdout.write('\n' + suggestions(actionable) + '\n');
  return 1;
}

function noteFor(row) {
  switch (row.state) {
    case 'clobbered': return 'a real path sits where a link belongs';
    case 'wrong-target': return 'link points somewhere else';
    case 'conflict': return 'changed in the repo AND here';
    case 'local-ahead': return 'local edits not in the repo';
    case 'repo-ahead': return 'repo has newer content';
    case 'unmanaged': return 'never synced on this machine';
    case 'missing-repo': return 'listed in the manifest but absent from the repo';
    default: return '';
  }
}

function suggestions(rows) {
  const out = [];
  if (rows.some((r) => NEEDS_APPLY.has(r.state))) out.push('  nortuscc apply     bring this machine up to date');
  if (rows.some((r) => NEEDS_CAPTURE.has(r.state))) out.push('  nortuscc push -m   share local edits');
  if (rows.some((r) => r.state === 'conflict')) {
    out.push('  conflicts need a decision: nortuscc apply --take-repo | --take-local');
  }
  return out.join('\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/status.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 6: Verify against the real machine**

Run: `node bin/nortuscc.mjs status`
Expected: a `config` section listing all four manifest entries. On the authoring machine `bin` should report `clobbered` and `hooks` should report `clobbered` or `missing` — this is the drift from the spec's §1, now visible for the first time. Exit code 1.

- [ ] **Step 7: Commit**

```bash
git add src/report.mjs src/commands/status.mjs test/status.test.mjs
git commit -m "feat: status reports config drift"
```

---

### Task 7: The apply command

**Files:**
- Modify: `src/commands/apply.mjs` (replace the placeholder)
- Test: `test/apply.test.mjs`

**Interfaces:**
- Consumes: `SYNC`, `resolveEntry`, `readLock`, `writeLock`, `ensureLink`, `applyCopy`
- Produces: `run(args): Promise<number>` — 0 on success, 1 when a conflict was refused. Accepts `--take-repo`, `--take-local`, and `--skills` (the last is wired in Task 11)

- [ ] **Step 1: Write the failing test**

Create `test/apply.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-apply-'));
const claude = join(home, '.claude');
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { run } = await import('../src/commands/apply.mjs');
const { SYNC } = await import('../src/manifest.mjs');
const { resolveEntry } = await import('../src/resolve.mjs');
const { readLock } = await import('../src/lock.mjs');

test('apply on a bare machine links dirs and copies files', async () => {
  const code = await run([]);
  assert.equal(code, 0);

  for (const entry of SYNC) {
    const { dest } = resolveEntry(entry);
    assert.ok(existsSync(dest), `${entry.dest} should exist after apply`);
  }
});

test('apply records a baseline for every copied file', async () => {
  const lock = readLock();
  for (const entry of SYNC.filter((e) => e.mode === 'copy')) {
    assert.ok(lock.files[entry.dest], `no baseline recorded for ${entry.dest}`);
    assert.match(lock.files[entry.dest].hash, /^sha256:/);
  }
});

test('apply is idempotent — a second run changes nothing and still exits 0', async () => {
  const before = readFileSync(join(claude, 'CLAUDE.md'), 'utf8');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), before);
});

test('apply leaves a local-only edit alone and exits 0', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# edited locally\n');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(f, 'utf8'), '# edited locally\n', 'apply must not clobber a local edit');
});

test('apply --take-repo overwrites the local edit', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# still edited\n');
  const code = await run(['--take-repo']);
  assert.equal(code, 0);
  assert.notEqual(readFileSync(f, 'utf8'), '# still edited\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/apply.test.mjs`
Expected: FAIL — `not implemented yet`, exit code 1 from the placeholder.

- [ ] **Step 3: Write `src/commands/apply.mjs`**

```js
import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { ensureLink } from '../link.mjs';
import { applyCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';

export async function run(args = []) {
  const takeRepo = args.includes('--take-repo');
  const takeLocal = args.includes('--take-local');

  if (takeRepo && takeLocal) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }

  const lock = readLock();
  const lines = [];
  let refused = 0;

  for (const entry of SYNC) {
    const { src, dest, mode } = resolveEntry(entry);

    if (mode === 'link') {
      const res = ensureLink(dest, src, entry.dest);
      lines.push(formatRow(entry.dest, res.state, res.backedUp ? `backed up -> ${res.backedUp}` : ''));
      continue;
    }

    // --take-local is a capture-side resolution; here it means "leave the local
    // file alone", which apply already does for anything but a conflict. Passing
    // force only for --take-repo keeps a conflict refused under --take-local.
    const res = applyCopy(src, dest, entry.dest, lock, { force: takeRepo });
    if (res.action === 'refused') refused += 1;
    lines.push(formatRow(entry.dest, res.action, noteFor(res)));
  }

  writeLock(lock);
  process.stdout.write('\n' + section('apply', lines));

  if (refused > 0) {
    process.stdout.write(
      `\n${refused} conflict(s) refused. Resolve with:\n` +
        '  nortuscc apply --take-repo    discard the local version\n' +
        '  nortuscc capture --take-local keep the local version\n',
    );
    return 1;
  }
  return 0;
}

function noteFor(res) {
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/apply.test.mjs`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/commands/apply.mjs test/apply.test.mjs
git commit -m "feat: apply syncs repo to machine"
```

---

### Task 8: The capture command

**Files:**
- Modify: `src/commands/capture.mjs` (replace the placeholder)
- Test: `test/capture.test.mjs`

**Interfaces:**
- Consumes: `SYNC`, `resolveEntry`, `readLock`, `writeLock`, `captureCopy`
- Produces: `run(args): Promise<number>`, and `capturedPaths(): string[]` — the repo-relative paths capture touched, which `push` uses to stage exactly those files and nothing else

- [ ] **Step 1: Write the failing test**

Create `test/capture.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-capture-'));
const claude = join(home, '.claude');
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { run: applyRun } = await import('../src/commands/apply.mjs');
const { run: captureRun, capturedPaths } = await import('../src/commands/capture.mjs');
const { repoRoot } = await import('../src/resolve.mjs');

const repoClaudeMd = join(repoRoot(), 'claude', 'CLAUDE.md');
const backup = join(home, 'CLAUDE.md.orig');

test('setup: seed the machine, and stash the repo file we are about to mutate', async () => {
  copyFileSync(repoClaudeMd, backup);
  assert.equal(await applyRun([]), 0);
});

test('capture with no local changes reports nothing captured', async () => {
  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(capturedPaths().length, 0);
});

test('capture copies a local edit back into the repo', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# captured edit\n');
  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(repoClaudeMd, 'utf8'), '# captured edit\n');
  assert.deepEqual(capturedPaths(), ['claude/CLAUDE.md']);
});

test('teardown: restore the repo file', () => {
  copyFileSync(backup, repoClaudeMd);
  assert.equal(readFileSync(repoClaudeMd, 'utf8'), readFileSync(backup, 'utf8'));
});
```

This test mutates a real repo file, so the first and last tests bracket it with a stash and restore. Run it alone if a failure leaves the repo dirty; `git checkout claude/CLAUDE.md` recovers.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/capture.test.mjs`
Expected: FAIL — `capturedPaths is not a function`

- [ ] **Step 3: Write `src/commands/capture.mjs`**

```js
import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { captureCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';

let lastCaptured = [];

// The repo-relative paths the most recent capture actually wrote. push stages
// exactly these, so nothing outside the manifest is ever committed.
export function capturedPaths() {
  return [...lastCaptured];
}

export async function run(args = []) {
  const takeLocal = args.includes('--take-local');
  const takeRepo = args.includes('--take-repo');

  if (takeRepo && takeLocal) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }

  const lock = readLock();
  const lines = [];
  const captured = [];
  let refused = 0;

  for (const entry of SYNC) {
    // Linked directories need no capture: the repo IS the live copy.
    if (entry.mode === 'link') continue;

    const { src, dest } = resolveEntry(entry);
    const res = captureCopy(src, dest, entry.dest, lock, { force: takeLocal });

    if (res.action === 'refused') refused += 1;
    if (res.action === 'copied') captured.push(entry.src);
    lines.push(formatRow(entry.dest, res.action, res.action === 'refused' ? 'conflict — nothing changed' : ''));
  }

  writeLock(lock);
  lastCaptured = captured;
  process.stdout.write('\n' + section('capture', lines));

  if (refused > 0) {
    process.stdout.write(`\n${refused} conflict(s) refused. Use --take-local to keep the local version.\n`);
    return 1;
  }
  return 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/capture.test.mjs`
Expected: PASS — 4 tests.

- [ ] **Step 5: Confirm the repo is clean**

Run: `git status --short`
Expected: no modification to `claude/CLAUDE.md`. If there is one, run `git checkout claude/CLAUDE.md`.

- [ ] **Step 6: Commit**

```bash
git add src/commands/capture.mjs test/capture.test.mjs
git commit -m "feat: capture syncs machine back to the repo"
```

---

### Task 9: The plugins section

**Files:**
- Create: `src/plugins.mjs`
- Modify: `src/commands/status.mjs` (add the plugins section)
- Test: `test/plugins.test.mjs`

**Interfaces:**
- Consumes: `claudeDir()` from `src/resolve.mjs`
- Produces: `pluginReport(settings, installed, marketplaces): {missingPlugins: string[], missingMarketplaces: string[], commands: string[]}` — a pure function over already-parsed JSON, plus `loadPluginState(): {settings, installed, marketplaces}` which reads them from disk

- [ ] **Step 1: Write the failing test**

Create `test/plugins.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginReport } from '../src/plugins.mjs';

test('nothing missing when everything is installed', () => {
  const r = pluginReport(
    { enabledPlugins: { 'a@mkt': true }, extraKnownMarketplaces: { mkt: { source: 'x/y' } } },
    { 'a@mkt': {} },
    { mkt: {} },
  );
  assert.deepEqual(r.missingPlugins, []);
  assert.deepEqual(r.missingMarketplaces, []);
  assert.deepEqual(r.commands, []);
});

test('an uninstalled plugin is reported with an install command', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': true } }, {}, { mkt: {} });
  assert.deepEqual(r.missingPlugins, ['a@mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin install a@mkt')));
});

test('a disabled plugin is not reported as missing', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': false } }, {}, { mkt: {} });
  assert.deepEqual(r.missingPlugins, []);
});

test('an unknown marketplace is reported with an add command', () => {
  const r = pluginReport(
    { enabledPlugins: {}, extraKnownMarketplaces: { mkt: { source: 'owner/repo' } } },
    {},
    {},
  );
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin marketplace add owner/repo')));
});

test('missing sections default to empty rather than throwing', () => {
  const r = pluginReport({}, {}, {});
  assert.deepEqual(r.missingPlugins, []);
  assert.deepEqual(r.missingMarketplaces, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/plugins.test.mjs`
Expected: FAIL — `Cannot find module '../src/plugins.mjs'`

- [ ] **Step 3: Write `src/plugins.mjs`**

```js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir, repoRoot } from './resolve.mjs';

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function loadPluginState() {
  return {
    settings: readJson(join(repoRoot(), 'claude', 'settings.json')),
    installed: readJson(join(claudeDir(), 'plugins', 'installed_plugins.json')),
    marketplaces: readJson(join(claudeDir(), 'plugins', 'known_marketplaces.json')),
  };
}

// Pure over parsed JSON so the comparison can be tested without a filesystem.
export function pluginReport(settings, installed, marketplaces) {
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  const wantedMarkets = settings.extraKnownMarketplaces ?? {};

  const missingPlugins = enabled.filter((name) => !(name in (installed ?? {})));
  const missingMarketplaces = Object.keys(wantedMarkets).filter((m) => !(m in (marketplaces ?? {})));

  const commands = [
    ...missingMarketplaces.map((m) => {
      const source = wantedMarkets[m]?.source ?? m;
      return `claude plugin marketplace add ${source}`;
    }),
    ...missingPlugins.map((p) => `claude plugin install ${p}`),
  ];

  return { missingPlugins, missingMarketplaces, commands };
}
```

- [ ] **Step 4: Add the plugins section to `src/commands/status.mjs`**

Add these imports at the top:

```js
import { loadPluginState, pluginReport } from '../plugins.mjs';
```

Then, inside `run()`, immediately after the `config` section is written and before the `actionable` calculation, insert:

```js
  const { settings, installed, marketplaces } = loadPluginState();
  const plugins = pluginReport(settings, installed, marketplaces);
  const pluginLines =
    plugins.commands.length === 0
      ? [formatRow('all enabled', 'installed', '')]
      : [
          ...plugins.missingMarketplaces.map((m) => formatRow(m, 'no marketplace', '')),
          ...plugins.missingPlugins.map((p) => formatRow(p, 'not installed', '')),
          '',
          ...plugins.commands.map((c) => `  ${c}`),
        ];
  process.stdout.write(section('plugins', pluginLines));
```

Then change the final return so plugin gaps also mark the run as not-clean. Replace:

```js
  if (actionable.length === 0) {
```

with:

```js
  if (actionable.length === 0 && plugins.commands.length === 0) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites, including the 5 new plugin tests.

- [ ] **Step 6: Verify against the real machine**

Run: `node bin/nortuscc.mjs status`
Expected: a `plugins` section. On the authoring machine everything enabled is already installed, so it should read `all enabled  installed`.

- [ ] **Step 7: Commit**

```bash
git add src/plugins.mjs src/commands/status.mjs test/plugins.test.mjs
git commit -m "feat: status reports plugin gaps, replacing plugin-check.sh"
```

---

### Task 10: The skills manifest and reconciliation

**Files:**
- Create: `src/skills.mjs`
- Modify: `src/commands/status.mjs` (add the skills section)
- Test: `test/skills.test.mjs`

**Interfaces:**
- Consumes: `agentsSkillsDir()`, `repoRoot()` from `src/resolve.mjs`
- Produces:
  - `parseManifest(text): Array<{source: string, skills: string[]}>`
  - `emitManifest(groups): string` — round-trips with `parseManifest`
  - `groupsFromLock(lock): Array<{source: string, skills: string[]}>` — derives provenance from `.skill-lock.json`
  - `reconcile({groups, lock, installedNames}): {ok: string[], missing: Array<{name, source}>, extra: string[], local: string[]}`
  - `installArgs(missing): Array<{source: string, skills: string[]}>` — missing skills grouped into one install call per source
  - `readSkillsManifest(): Array<{source, skills}>`, `readSkillLock(): object`, `installedSkillNames(): string[]`

- [ ] **Step 1: Write the failing test**

Create `test/skills.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, emitManifest, groupsFromLock, reconcile, installArgs } from '../src/skills.mjs';

const SAMPLE = `# a comment
[Nortus222/agent-skills]
explain

[mattpocock/skills]
teach
grill-me
`;

test('parseManifest groups skills under their source', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(g, [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['teach', 'grill-me'] },
  ]);
});

test('parseManifest ignores comments and blank lines', () => {
  assert.deepEqual(parseManifest('\n# nothing\n\n'), []);
});

test('parseManifest drops names that precede any source header', () => {
  assert.deepEqual(parseManifest('orphan\n[a/b]\nreal\n'), [{ source: 'a/b', skills: ['real'] }]);
});

test('emit then parse round-trips', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(parseManifest(emitManifest(g)), g);
});

test('groupsFromLock derives sources and sorts deterministically', () => {
  const lock = {
    skills: {
      teach: { source: 'mattpocock/skills' },
      explain: { source: 'Nortus222/agent-skills' },
      'grill-me': { source: 'mattpocock/skills' },
      scratch: {},
    },
  };
  assert.deepEqual(groupsFromLock(lock), [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['grill-me', 'teach'] },
  ]);
});

test('reconcile splits into ok, missing, extra, and local', () => {
  const groups = [{ source: 'a/b', skills: ['have', 'want'] }];
  const lock = { skills: { have: { source: 'a/b' }, spare: { source: 'c/d' }, mine: {} } };
  const r = reconcile({ groups, lock, installedNames: ['have', 'spare', 'mine'] });

  assert.deepEqual(r.ok, ['have']);
  assert.deepEqual(r.missing, [{ name: 'want', source: 'a/b' }]);
  assert.deepEqual(r.extra, ['spare']);
  assert.deepEqual(r.local, ['mine']);
});

test('a manifest skill installed from a different source still counts as present', () => {
  const groups = [{ source: 'a/b', skills: ['thing'] }];
  const lock = { skills: { thing: { source: 'z/z' } } };
  const r = reconcile({ groups, lock, installedNames: ['thing'] });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.ok, ['thing']);
});

test('installArgs groups missing skills into one call per source', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'a/b' },
    { name: 'three', source: 'c/d' },
  ];
  assert.deepEqual(installArgs(missing), [
    { source: 'a/b', skills: ['one', 'two'] },
    { source: 'c/d', skills: ['three'] },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skills.test.mjs`
Expected: FAIL — `Cannot find module '../src/skills.mjs'`

- [ ] **Step 3: Write `src/skills.mjs`**

```js
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { agentsSkillsDir, repoRoot } from './resolve.mjs';

const MANIFEST = () => join(repoRoot(), 'skills-manifest.txt');
const SKILL_LOCK = () => join(homedir(), '.agents', '.skill-lock.json');

const HEADER = /^\[(.+)\]$/;

// Source-grouped format. Provenance has to live in the repo to be restorable:
// the skill lock is machine-local and empty on a fresh machine.
export function parseManifest(text) {
  const groups = [];
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(HEADER);
    if (header) {
      current = { source: header[1], skills: [] };
      groups.push(current);
      continue;
    }
    // A name before any header has no source, so it could never be installed.
    if (current) current.skills.push(line);
  }
  return groups;
}

export function emitManifest(groups) {
  const head =
    '# Skills expected on every machine, grouped by the repo they install from.\n' +
    '# Regenerate with: nortuscc capture\n' +
    '# Install with:    nortuscc apply --skills\n\n';

  return (
    head +
    groups
      .map((g) => `[${g.source}]\n${g.skills.join('\n')}\n`)
      .join('\n')
  );
}

export function groupsFromLock(lock) {
  const bySource = new Map();
  for (const [name, meta] of Object.entries(lock?.skills ?? {})) {
    const source = meta?.source;
    if (!source) continue; // hand-authored locally; nothing to install it from
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(name);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, skills]) => ({ source, skills: skills.sort() }));
}

export function reconcile({ groups, lock, installedNames }) {
  const installed = new Set(installedNames);
  const wanted = new Map();
  for (const g of groups) for (const name of g.skills) wanted.set(name, g.source);

  const ok = [];
  const missing = [];
  for (const [name, source] of wanted) {
    if (installed.has(name)) ok.push(name);
    else missing.push({ name, source });
  }

  const extra = [];
  const local = [];
  for (const name of installedNames) {
    if (wanted.has(name)) continue;
    // No recorded source means it was authored directly in ~/.agents/skills and
    // can never be installed from anywhere, so it is never written to the manifest.
    if (lock?.skills?.[name]?.source) extra.push(name);
    else local.push(name);
  }

  return { ok, missing, extra, local };
}

export function installArgs(missing) {
  const bySource = new Map();
  for (const { name, source } of missing) {
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(name);
  }
  return [...bySource.entries()].map(([source, skills]) => ({ source, skills }));
}

export function readSkillsManifest() {
  const path = MANIFEST();
  if (!existsSync(path)) return [];
  return parseManifest(readFileSync(path, 'utf8'));
}

// A lock that cannot be read degrades to "nothing known" rather than failing the
// whole status run.
export function readSkillLock() {
  const path = SKILL_LOCK();
  if (!existsSync(path)) return { skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { skills: parsed?.skills ?? {} };
  } catch {
    return { skills: {} };
  }
}

export function installedSkillNames() {
  const dir = agentsSkillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .sort();
}

export function manifestPath() {
  return MANIFEST();
}
```

- [ ] **Step 4: Add the skills section to `src/commands/status.mjs`**

Add this import:

```js
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile } from '../skills.mjs';
```

Insert after the plugins section and before the `actionable` calculation:

```js
  const skills = reconcile({
    groups: readSkillsManifest(),
    lock: readSkillLock(),
    installedNames: installedSkillNames(),
  });
  const skillLines = [];
  if (skills.missing.length) {
    skillLines.push(formatRow('missing', String(skills.missing.length), skills.missing.map((m) => m.name).join(', ')));
  }
  if (skills.extra.length) {
    skillLines.push(formatRow('extra', String(skills.extra.length), skills.extra.join(', ')));
  }
  if (skills.local.length) {
    skillLines.push(formatRow('local', String(skills.local.length), skills.local.join(', ')));
  }
  if (!skillLines.length) skillLines.push(formatRow('manifest', 'satisfied', ''));
  if (skills.missing.length) skillLines.push('', '  nortuscc apply --skills');
  process.stdout.write(section('skills', skillLines));
```

Then extend the clean check again. Replace:

```js
  if (actionable.length === 0 && plugins.commands.length === 0) {
```

with:

```js
  if (actionable.length === 0 && plugins.commands.length === 0 && skills.missing.length === 0) {
```

Extra and local skills deliberately do not make the run dirty — they are expected, and are the mechanism by which a machine carries its own additions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites, including the 8 new skills tests.

- [ ] **Step 6: Commit**

```bash
git add src/skills.mjs src/commands/status.mjs test/skills.test.mjs
git commit -m "feat: status reports skill drift, replacing skills-check.sh"
```

---

### Task 11: Installing skills through the skills CLI

**Files:**
- Create: `src/skills-cli.mjs`
- Modify: `src/commands/apply.mjs` (handle `--skills`)
- Modify: `src/commands/capture.mjs` (regenerate the manifest)
- Test: `test/skills-cli.test.mjs`

**Interfaces:**
- Consumes: `installArgs` from `src/skills.mjs`
- Produces:
  - `buildCommand({source, skills}): {cmd: string, args: string[]}` — pure, so the argument construction is testable without spawning anything
  - `installGroups(groups, {dryRun}): Promise<{source: string, ok: boolean}[]>`

- [ ] **Step 1: Write the failing test**

Create `test/skills-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, installGroups } from '../src/skills-cli.mjs';

test('buildCommand targets the right repo with an explicit skill list', () => {
  const { cmd, args } = buildCommand({ source: 'a/b', skills: ['one', 'two'] });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'add', 'a/b', '--skill', 'one,two', '--global', '--yes']);
});

test('buildCommand handles a single skill', () => {
  const { args } = buildCommand({ source: 'a/b', skills: ['solo'] });
  assert.ok(args.includes('--skill'));
  assert.equal(args[args.indexOf('--skill') + 1], 'solo');
});

test('buildCommand always installs globally, never project-scoped', () => {
  const { args } = buildCommand({ source: 'a/b', skills: ['x'] });
  assert.ok(args.includes('--global'), 'skills belong in ~/.agents/skills, not a project');
});

test('installGroups in dry-run spawns nothing and echoes every group', async () => {
  const res = await installGroups(
    [
      { source: 'a/b', skills: ['one'] },
      { source: 'c/d', skills: ['two'] },
    ],
    { dryRun: true },
  );
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.ok));
});

test('installGroups with nothing to do returns an empty result', async () => {
  assert.deepEqual(await installGroups([], { dryRun: true }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skills-cli.test.mjs`
Expected: FAIL — `Cannot find module '../src/skills-cli.mjs'`

- [ ] **Step 3: Write `src/skills-cli.mjs`**

```js
import { spawn } from 'node:child_process';

// The only place `npx skills` is invoked. Everything else in the CLI deals in
// skill names and sources, so a change to the skills CLI's flags is contained here.

// --skill restores a precise subset rather than everything a repo publishes;
// --global keeps skills in ~/.agents/skills rather than a project directory.
export function buildCommand({ source, skills }) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'add', source, '--skill', skills.join(','), '--global', '--yes'],
  };
}

function runOne({ cmd, args }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

export async function installGroups(groups, { dryRun = false } = {}) {
  const results = [];
  for (const group of groups) {
    const command = buildCommand(group);
    if (dryRun) {
      console.log(`  ${command.cmd} ${command.args.join(' ')}`);
      results.push({ source: group.source, ok: true });
      continue;
    }
    console.log(`\ninstalling ${group.skills.length} skill(s) from ${group.source}`);
    results.push({ source: group.source, ok: await runOne(command) });
  }
  return results;
}
```

`shell: true` is needed on Windows because `npx` is a `.cmd` shim, which `spawn` cannot execute directly.

- [ ] **Step 4: Wire `--skills` into `src/commands/apply.mjs`**

Add these imports:

```js
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from '../skills.mjs';
import { installGroups } from '../skills-cli.mjs';
```

Insert just before `writeLock(lock);`:

```js
  if (args.includes('--skills')) {
    const skills = reconcile({
      groups: readSkillsManifest(),
      lock: readSkillLock(),
      installedNames: installedSkillNames(),
    });
    if (skills.missing.length === 0) {
      lines.push(formatRow('skills', 'satisfied', ''));
    } else {
      await installGroups(installArgs(skills.missing));
      lines.push(formatRow('skills', 'installed', skills.missing.map((m) => m.name).join(', ')));
    }
  }
```

- [ ] **Step 5: Regenerate the manifest in `src/commands/capture.mjs`**

Add these imports:

```js
import { writeFileSync } from 'node:fs';
import { groupsFromLock, emitManifest, readSkillLock, manifestPath, readSkillsManifest } from '../skills.mjs';
```

Insert just before `writeLock(lock);`:

```js
  // Regenerate the skills manifest from what is actually installed. Capture is
  // the only command that writes it, so an install done the normal way is shared
  // by running capture afterwards.
  const groups = groupsFromLock(readSkillLock());
  const before = readSkillsManifest();
  const beforeCount = before.reduce((n, g) => n + g.skills.length, 0);
  const afterCount = groups.reduce((n, g) => n + g.skills.length, 0);

  if (afterCount < beforeCount && !args.includes('--allow-shrink')) {
    lines.push(formatRow('skills-manifest', 'refused', `would drop ${beforeCount - afterCount} entr(ies); pass --allow-shrink`));
  } else if (groups.length > 0) {
    writeFileSync(manifestPath(), emitManifest(groups), 'utf8');
    captured.push('skills-manifest.txt');
    lines.push(formatRow('skills-manifest', 'written', `${afterCount} skill(s)`));
  }
```

The shrink guard exists because capture emits only what is installed: a failed install would otherwise quietly delete a skill from the shared set.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all suites, including the 5 new skills-cli tests.

Note: `test/capture.test.mjs` now also writes `skills-manifest.txt`. Add a stash/restore for it mirroring the existing `CLAUDE.md` handling, or run `git checkout skills-manifest.txt` afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/skills-cli.mjs src/commands/apply.mjs src/commands/capture.mjs test/skills-cli.test.mjs test/capture.test.mjs
git commit -m "feat: install skills via the skills CLI and regenerate the manifest on capture"
```

---

### Task 12: The setup command

**Files:**
- Modify: `src/commands/setup.mjs` (replace the placeholder)
- Test: manual — this command clones and installs, so it is verified by running it

**Interfaces:**
- Consumes: `apply`, `status`, `installGroups`, `readLock`, `writeLock`, `repoRoot`
- Produces: `run(args): Promise<number>`. Accepts `--repo URL` and `--dir PATH`

- [ ] **Step 1: Write `src/commands/setup.mjs`**

```js
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readLock, writeLock } from '../lock.mjs';
import { repoRoot } from '../resolve.mjs';
import { run as applyRun } from './apply.mjs';
import { run as statusRun } from './status.mjs';

const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export async function run(args = []) {
  const dir = flag(args, '--dir');
  const url = flag(args, '--repo') ?? DEFAULT_REPO;

  // When --dir is given and empty, clone into it. Otherwise this CLI is already
  // running from a clone, which is the npx-from-GitHub case.
  if (dir && !existsSync(dir)) {
    console.log(`cloning ${url} -> ${dir}`);
    execFileSync('git', ['clone', url, dir], { stdio: 'inherit' });
  }

  const root = dir ?? repoRoot();
  console.log(`repo: ${root}`);

  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    console.log(`commit: ${commit}`);
  } catch {
    console.log('commit: unknown (not a git checkout)');
  }

  // Record where the repo lives so later runs work from any directory.
  const lock = readLock();
  lock.repo = root;
  writeLock(lock);

  // setup always installs skills: a bare machine is exactly when they are wanted.
  const applied = await applyRun(['--skills', ...args.filter((a) => a.startsWith('--take-'))]);
  if (applied !== 0) return applied;

  console.log('\n--- status ---');
  return await statusRun();
}
```

- [ ] **Step 2: Verify by hand against a throwaway HOME**

Run:

```bash
NORTUSCC_CLAUDE_DIR=/tmp/ccfg-setup-test node bin/nortuscc.mjs setup
```

Expected: prints the repo path and commit, applies all four manifest entries into `/tmp/ccfg-setup-test`, installs any missing skills, then prints a status report. Exit 0.

- [ ] **Step 3: Confirm it is idempotent**

Run the same command again.
Expected: everything reports `linked` / `skipped`, exit 0, no backups created on the second run.

- [ ] **Step 4: Commit**

```bash
git add src/commands/setup.mjs
git commit -m "feat: setup bootstraps a machine end to end"
```

---

### Task 13: The pull and push commands

**Files:**
- Modify: `src/commands/pull.mjs` (replace the placeholder)
- Modify: `src/commands/push.mjs` (replace the placeholder)
- Test: manual — both wrap git

**Interfaces:**
- Consumes: `capturedPaths` from `src/commands/capture.mjs`, `repoRoot` from `src/resolve.mjs`
- Produces: `run(args): Promise<number>` from each

- [ ] **Step 1: Write `src/commands/pull.mjs`**

```js
import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { run as applyRun } from './apply.mjs';

export async function run(args = []) {
  try {
    execFileSync('git', ['-C', repoRoot(), 'pull', '--ff-only'], { stdio: 'inherit' });
  } catch {
    console.error('\nnortuscc: git pull --ff-only failed.');
    console.error('The remote has diverged; resolve it in the repo before applying.');
    return 1;
  }
  return await applyRun(args);
}
```

- [ ] **Step 2: Write `src/commands/push.mjs`**

```js
import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { run as captureRun, capturedPaths } from './capture.mjs';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export async function run(args = []) {
  const message = flag(args, '-m') ?? flag(args, '--message');
  if (!message) {
    console.error('nortuscc: push requires an explicit message: nortuscc push -m "rules: ..."');
    return 2;
  }

  const captured = await captureRun(args.filter((a) => a.startsWith('--take-')));
  if (captured !== 0) return captured;

  const paths = capturedPaths();
  if (paths.length === 0) {
    console.log('\nnothing captured; nothing to push');
    return 0;
  }

  const root = repoRoot();
  // Stage only what capture wrote. Never `git add -A` — the repo may hold
  // unrelated in-flight work that is not ours to commit.
  execFileSync('git', ['-C', root, 'add', ...paths], { stdio: 'inherit' });

  console.log('\nstaged:');
  execFileSync('git', ['-C', root, 'diff', '--cached', '--stat'], { stdio: 'inherit' });

  execFileSync('git', ['-C', root, 'commit', '-m', message], { stdio: 'inherit' });
  execFileSync('git', ['-C', root, 'push'], { stdio: 'inherit' });
  return 0;
}
```

- [ ] **Step 3: Verify push refuses without a message**

Run: `node bin/nortuscc.mjs push`
Expected: `push requires an explicit message`, exit 2, nothing staged.

- [ ] **Step 4: Verify push with nothing captured**

Run: `node bin/nortuscc.mjs push -m "test: no-op"`
Expected: `nothing captured; nothing to push`, exit 0, no commit created.

Confirm with `git log --oneline -1` that HEAD did not move.

- [ ] **Step 5: Verify pull**

Run: `node bin/nortuscc.mjs pull`
Expected: a git pull followed by an apply report. Exit 0 if the remote has nothing new.

- [ ] **Step 6: Commit**

```bash
git add src/commands/pull.mjs src/commands/push.mjs
git commit -m "feat: pull and push wrap git around apply and capture"
```

---

### Task 14: Migration — retire the scripts and rewrite the docs

**Files:**
- Delete: `bootstrap.sh`, `bootstrap-windows.sh`, `plugin-check.sh`, `skills-check.sh`
- Modify: `skills-manifest.txt` (convert to source-grouped)
- Modify: `README.md` (rewrite)

- [ ] **Step 1: Reconcile `bin/` before the first real apply**

Per the spec's §9 step 2, check which side of any `bin/` divergence is current. On the authoring machine as of `0eafc4d` the repo holds the 85-line submodule-aware `sdd-pkg.sh` and the local copy is the older 43-line one, so applying is a pure upgrade.

Run: `diff ~/.claude/bin/sdd-pkg.sh claude/bin/sdd-pkg.sh`

If the local side has anything the repo lacks, run `nortuscc capture` first. Do not proceed until this is settled — `apply` will move the whole directory to backups.

- [ ] **Step 2: Apply for real and confirm the §1 drift is gone**

```bash
node bin/nortuscc.mjs status    # expect drift
node bin/nortuscc.mjs apply
node bin/nortuscc.mjs status    # expect clean
```

Then verify the two load-bearing files named in the spec's §1:

```bash
ls ~/.claude/bin/sp
diff ~/.claude/bin/sdd-pkg.sh claude/bin/sdd-pkg.sh
```

Expected: `sp` exists, and `sdd-pkg.sh` is identical.

- [ ] **Step 3: Convert the skills manifest**

```bash
node bin/nortuscc.mjs capture
git diff skills-manifest.txt
```

Review the diff before accepting it. The current manifest lists `design-an-interface` and `to-issues`, which have no match on this machine and look like upstream renames to `codebase-design` and `to-tickets`. Capture emits only what is installed, so both will disappear. Confirm the rename before letting them go; if either is a genuine loss, reinstall it first and re-run capture.

- [ ] **Step 4: Delete the four scripts**

```bash
git rm bootstrap.sh bootstrap-windows.sh plugin-check.sh skills-check.sh
```

- [ ] **Step 5: Rewrite `README.md`**

Replace the whole file with:

````markdown
# claude-config

Portable Claude Code configuration, kept in agreement across machines by
`nortuscc` — one CLI that reports drift instead of letting it go silent.

## New machine

```bash
npx github:Nortus222/claude-config setup --dir ~/dev/claude-config
```

Clones the repo, links `bin/` and `hooks/` into `~/.claude`, copies
`settings.json` and `CLAUDE.md`, installs every skill in the manifest, and
prints a status report. Restart Claude Code afterwards to load the rules.

## Daily use

```bash
nortuscc status              # read-only; changes nothing
nortuscc pull                # git pull, then bring this machine up to date
nortuscc push -m "rules: allow gh pr view"   # share local edits
```

`status` exits non-zero when anything needs attention, so it can gate a shell
prompt or a scheduled check.

## Commands

| Command | Effect |
| --- | --- |
| `setup [--repo URL] [--dir PATH]` | Clone if absent, apply, install skills, report |
| `status` | Read-only report: config, plugins, skills |
| `apply [--skills]` | Repo → machine. `--skills` also installs missing skills |
| `capture` | Machine → repo, including regenerating the skills manifest |
| `pull` | `git pull --ff-only`, then apply |
| `push -m MSG` | Capture, then commit and push only what changed |

Conflict resolution on `apply` and `capture`: `--take-repo` or `--take-local`.

## How syncing works

| Path | Mode | Why |
| --- | --- | --- |
| `claude/bin` | link | An agent never writes it, so a link gives live sync |
| `claude/hooks` | link | Same |
| `claude/settings.json` | copy | Claude Code rewrites it in place, which would silently replace a link |
| `claude/CLAUDE.md` | copy | Same |

Copied files carry a content hash in `~/.claude/.nortuscc-lock.json`, recorded at
the last sync. Comparing it against both sides gives four states: `clean`,
`repo-ahead`, `local-ahead`, and `conflict`. A conflict is refused and backed up,
never guessed. Directory links add a fifth: `clobbered`, meaning a real path sits
where a link belongs and syncing had silently stopped.

Everything destructive backs up to `~/.claude/backups/nortuscc-<stamp>/` first.

## Skills

Skill content is never vendored here. `skills-manifest.txt` records which skills
belong on every machine and which repo each installs from; `nortuscc` drives
`npx skills` to fetch them.

Skills present on a machine but absent from the manifest are reported and never
removed — that is how a machine carries the shared set plus its own extras. Run
`nortuscc capture` to fold a locally installed skill into the shared set.

Skills with no recorded source are hand-authored and are never written to the
manifest, since nothing could install them.

## Adding a synced path

Add one line to `SYNC` in `src/manifest.mjs`. Every command reads that table;
nothing else needs to change.

## Development

```bash
npm test    # node:test, no dependencies
```
````

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 7: Confirm the CLI still works after the deletions**

Run: `node bin/nortuscc.mjs status`
Expected: a clean report on all three sections, exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: retire the four sync scripts for nortuscc

status now reports config, plugin, and skill drift in one place, which is
what the scripts could not do: bootstrap-windows.sh never synced bin/ or
hooks/, so this machine had been missing claude/bin/sp entirely and running
a stale sdd-pkg.sh, both of which the global CLAUDE.md tells agents to use.

skills-manifest.txt is now source-grouped, because provenance has to live in
the repo to be restorable - the skill lock is machine-local and empty on a
fresh machine."
```

---

### Task 15: Verify on macOS

**Files:** none — this task is verification only

The authoring machine is Windows. The spec's §9 makes a real run on macOS a
precondition for trusting the deleted scripts as dead.

- [ ] **Step 1: On the mac, pull and run status**

```bash
git -C ~/.config/claude-config pull    # or wherever the clone lives
node ~/.config/claude-config/bin/nortuscc.mjs status
```

Expected: a report with all three sections. `bin/` and `hooks/` were symlinked by
the old `bootstrap.sh`, so they should already read `linked` — the old script's
link target and the new one are the same path.

- [ ] **Step 2: Apply and confirm nothing is destroyed**

```bash
node ~/.config/claude-config/bin/nortuscc.mjs apply
node ~/.config/claude-config/bin/nortuscc.mjs status
```

Expected: exit 0 and a clean report. Check `~/.claude/backups/` — if `apply`
backed anything up, inspect it before continuing, since on the mac these paths
were already correctly linked and a backup means something was unexpected.

- [ ] **Step 3: Confirm the symlinks still resolve**

```bash
ls -l ~/.claude/bin ~/.claude/hooks
cat ~/.claude/bin/sp > /dev/null && echo "sp readable"
```

Expected: both are symlinks into the repo, and `sp` reads.

- [ ] **Step 4: Install the binary on PATH (optional, both machines)**

```bash
npm link    # from the repo, makes `nortuscc` available globally
```

Then `nortuscc status` works from any directory.

- [ ] **Step 5: Record the result**

Append a line to the spec's §9 noting the date and outcome of the macOS run, and
commit:

```bash
git add docs/superpowers/specs/2026-08-02-nortuscc-cli-design.md
git commit -m "docs: record the macOS verification run"
```
