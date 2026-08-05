# `nortuscc update` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `nortuscc update`, which reports which installed skills have moved on upstream, asks for confirmation, backs them up, and then updates them.

**Architecture:** `skillFolderHash` in `~/.agents/.skill-lock.json` is the git tree SHA of the skill's folder in its source repo, so an update check is a SHA comparison, not a content diff. A blobless no-checkout shallow clone per source supplies the current SHAs. Classification is a pure function over `{lock, installedNames, remoteTrees}`; cloning, prompting, and spawning the updater are thin injectable edges, so every state — including partial failures — is tested with no network and no writes to `~/.agents`.

**Tech Stack:** Node 18+, plain ESM `.mjs`, `node:test`, `node:assert/strict`, `git` and `npx` as subprocesses.

Spec: `docs/superpowers/specs/2026-08-05-nortuscc-update-design.md`

## Global Constraints

- Node 18+, plain ESM `.mjs`, **zero dependencies** including test tooling.
- `node:`-prefixed builtin imports throughout (`node:fs`, `node:path`, `node:child_process`, …).
- Tests use `node:test` and `node:assert/strict` only.
- Test-first: write the failing test, watch it fail, then write the module.
- Run the suite with `npm test`. Never `node --test test/` — that reports `pass 0 / fail 1` on Node 25. Pass no path and let the runner find `test/` itself.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`. Commit after every task.
- No test may spawn `npx skills` or write to the real `~/.agents`. `NORTUSCC_AGENTS_DIR` redirects only what nortuscc *reads*, never the installer.
- Nothing destructive runs without a backup to `~/.claude/backups/` first.
- All work happens in the worktree `.claude/worktrees/nortuscc-update` on branch `nortuscc-update`. Feature PRs target `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/skill-updates.mjs` | **New.** Pure. Path derivation and classification of every skill into `current` / `outdated` / `gone` / `unknown` / `local` |
| `src/git-trees.mjs` | **New.** I/O edge. Blobless clone of a source repo, resolve folder paths to tree SHAs, clean up |
| `src/prompt.mjs` | **New.** `confirm()` over `node:readline/promises` with injectable streams and a non-TTY answer of `null` |
| `src/backup.mjs` | **Modify.** Add `preserveCopy` — a copy, where `backupOnce` is a move |
| `src/skills-cli.mjs` | **Modify.** Add `buildUpdateCommand` / `runUpdate`, keeping `npx skills` invoked from exactly one file |
| `src/commands/update.mjs` | **New.** Orchestration, exit-code policy, and the report |
| `bin/nortuscc.mjs` | **Modify.** Add `update` to `VERBS` and `USAGE` |
| `README.md` | **Modify.** Command table and a section on the check |

Tasks 1–5 are independent of each other and each ship a tested unit. Task 6 composes them. Task 7 wires the CLI and documents it.

---

### Task 1: Pure classification (`src/skill-updates.mjs`)

**Files:**
- Create: `src/skill-updates.mjs`
- Test: `test/skill-updates.test.mjs`

**Interfaces:**
- Consumes: `isPlainObject` from `src/plugins.mjs` (already exported).
- Produces:
  - `skillFolder(skillPath: string) -> string` — the repo folder holding a skill; `'.'` for a root `SKILL.md`.
  - `updatableSkills(lock, installedNames) -> Array<{name, source, sourceUrl, path, hash}>` — `hash` may be `null`.
  - `sourcesOf(entries) -> Array<{source, sourceUrl, paths: string[]}>` — deduped, sorted by `sourceUrl`.
  - `planUpdates({lock, installedNames, remoteTrees}) -> {current: string[], outdated: Array<{name, source, from, to}>, gone: Array<{name, source, path}>, unknown: Array<{name, source}>, local: string[]}`
  - `remoteTrees` is `Map<sourceUrl, Map<path, string|null>>`. A `sourceUrl` absent from the outer map means the source was unreachable.

- [ ] **Step 1: Write the failing test**

Create `test/skill-updates.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFolder, updatableSkills, sourcesOf, planUpdates } from '../src/skill-updates.mjs';

const lockOf = (skills) => ({ skills });

const ENTRY = {
  source: 'mattpocock/skills',
  sourceType: 'github',
  sourceUrl: 'https://github.com/mattpocock/skills.git',
  skillPath: 'skills/engineering/tdd/SKILL.md',
  skillFolderHash: 'aaa',
};

test('skillFolder strips the SKILL.md filename', () => {
  assert.equal(skillFolder('skills/engineering/tdd/SKILL.md'), 'skills/engineering/tdd');
});

test('skillFolder maps a root SKILL.md to the root tree', () => {
  assert.equal(skillFolder('SKILL.md'), '.');
});

test('updatableSkills keeps only skills that are installed', () => {
  const entries = updatableSkills(lockOf({ tdd: ENTRY, absent: ENTRY }), ['tdd']);
  assert.deepEqual(entries.map((e) => e.name), ['tdd']);
  assert.equal(entries[0].path, 'skills/engineering/tdd');
  assert.equal(entries[0].hash, 'aaa');
});

test('updatableSkills skips entries with no recorded source', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  assert.deepEqual(updatableSkills(lock, ['mine']), []);
});

test('updatableSkills survives a malformed lock without throwing', () => {
  assert.deepEqual(updatableSkills(null, ['x']), []);
  assert.deepEqual(updatableSkills({ skills: 'nope' }, ['x']), []);
  assert.deepEqual(updatableSkills(lockOf({ x: 5 }), ['x']), []);
});

test('sourcesOf dedupes by sourceUrl and collects every path', () => {
  const entries = [
    { name: 'a', source: 's/one', sourceUrl: 'u1', path: 'p/a', hash: 'x' },
    { name: 'b', source: 's/one', sourceUrl: 'u1', path: 'p/b', hash: 'y' },
    { name: 'c', source: 's/two', sourceUrl: 'u2', path: 'p/c', hash: 'z' },
  ];
  assert.deepEqual(sourcesOf(entries), [
    { source: 's/one', sourceUrl: 'u1', paths: ['p/a', 'p/b'] },
    { source: 's/two', sourceUrl: 'u2', paths: ['p/c'] },
  ]);
});

test('planUpdates calls a matching tree SHA current', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'aaa']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['tdd']);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates reports a differing tree SHA as outdated, with both SHAs', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [
    { name: 'tdd', source: 'mattpocock/skills', from: 'aaa', to: 'bbb' },
  ]);
});

test('planUpdates treats a path missing upstream as gone, never as outdated', () => {
  const remote = new Map([['u', new Map([['p/tdd', null]])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.gone, [{ name: 'tdd', source: 'mattpocock/skills', path: 'p/tdd' }]);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates marks every skill of an unreachable source unknown', () => {
  const lock = lockOf({
    tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
    review: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/review/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['tdd', 'review'], remoteTrees: new Map() });
  assert.deepEqual(plan.unknown.map((u) => u.name), ['review', 'tdd']);
  assert.deepEqual(plan.current, []);
});

test('planUpdates isolates an unreachable source from a reachable one', () => {
  const remote = new Map([['ok', new Map([['p/a', 'same']])]]);
  const lock = lockOf({
    a: { ...ENTRY, sourceUrl: 'ok', skillPath: 'p/a/SKILL.md', skillFolderHash: 'same' },
    b: { ...ENTRY, sourceUrl: 'down', skillPath: 'p/b/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['a', 'b'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['a']);
  assert.deepEqual(plan.unknown.map((u) => u.name), ['b']);
});

test('planUpdates lists an installed skill with no source as local', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['mine'], remoteTrees: new Map() });
  assert.deepEqual(plan.local, ['mine']);
  assert.deepEqual(plan.unknown, []);
});

test('planUpdates treats a sourced entry with no recorded hash as outdated from null', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({
    tdd: { source: 's/one', sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [{ name: 'tdd', source: 's/one', from: null, to: 'bbb' }]);
});

test('planUpdates ignores lock entries for skills that are not installed', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: [], remoteTrees: remote });
  assert.deepEqual(plan, { current: [], outdated: [], gone: [], unknown: [], local: [] });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/skill-updates.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/skill-updates.mjs`:

```js
import { dirname } from 'node:path';
import { isPlainObject } from './plugins.mjs';

// The lock records the path of a skill's SKILL.md, but the tree SHA that
// identifies a version belongs to the directory containing it. A SKILL.md at
// the repo root has no containing directory, so it maps to '.' — git's own
// name for the root tree, which `rev-parse HEAD:.` resolves.
export function skillFolder(skillPath) {
  const dir = dirname(skillPath);
  return dir === '' || dir === '/' ? '.' : dir;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

// An entry is updatable only if it names both where it came from and where it
// lives in that repo. A source with no skillPath cannot be located upstream,
// so there is no SHA to compare and nothing this command could do with it.
export function updatableSkills(lock, installedNames) {
  const skills = isPlainObject(lock) && isPlainObject(lock.skills) ? lock.skills : {};
  const entries = [];
  for (const name of installedNames) {
    const meta = skills[name];
    if (!isPlainObject(meta)) continue;
    const source = str(meta.source);
    const skillPath = str(meta.skillPath);
    if (!source || !skillPath) continue;
    entries.push({
      name,
      source,
      // Older lock entries predate sourceUrl; the "owner/repo" shorthand is
      // what `git clone` accepts from GitHub anyway, so it is a safe fallback.
      sourceUrl: str(meta.sourceUrl) || `https://github.com/${source}.git`,
      path: skillFolder(skillPath),
      hash: str(meta.skillFolderHash),
    });
  }
  return entries;
}

// Grouped by sourceUrl, because that is what gets cloned — two sources that
// differ only in shorthand would otherwise be fetched twice. Plain code-point
// ordering, not localeCompare, so the order is locale-independent.
export function sourcesOf(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    if (!byUrl.has(entry.sourceUrl)) {
      byUrl.set(entry.sourceUrl, { source: entry.source, sourceUrl: entry.sourceUrl, paths: [] });
    }
    byUrl.get(entry.sourceUrl).paths.push(entry.path);
  }
  return [...byUrl.values()].sort((a, b) =>
    a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0,
  );
}

export function planUpdates({ lock, installedNames, remoteTrees }) {
  const names = [...installedNames].sort();
  const entries = updatableSkills(lock, names);
  const updatable = new Set(entries.map((e) => e.name));

  const plan = { current: [], outdated: [], gone: [], unknown: [], local: [] };

  // Nothing could ever update a skill with no recorded source, so it is
  // reported and skipped — the same treatment groupsFromLock gives it when
  // deciding what may be written to the manifest.
  for (const name of names) if (!updatable.has(name)) plan.local.push(name);

  for (const entry of entries) {
    const trees = remoteTrees.get(entry.sourceUrl);
    if (!trees) {
      // The source could not be reached at all. Saying "current" here would be
      // a claim we did not verify, so it gets its own state.
      plan.unknown.push({ name: entry.name, source: entry.source });
      continue;
    }
    const remote = trees.get(entry.path) ?? null;
    if (remote === null) {
      plan.gone.push({ name: entry.name, source: entry.source, path: entry.path });
      continue;
    }
    if (remote === entry.hash) {
      plan.current.push(entry.name);
      continue;
    }
    // A missing hash lands here too, as `from: null`. We cannot verify what is
    // installed, and re-fetching is exactly what repairs that.
    plan.outdated.push({ name: entry.name, source: entry.source, from: entry.hash, to: remote });
  }
  return plan;
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS — all `skill-updates` tests green, and every pre-existing test still green.

- [ ] **Step 5: Commit**

```bash
git add src/skill-updates.mjs test/skill-updates.test.mjs
git commit -m "feat: classify installed skills against their upstream tree SHAs"
```

---

### Task 2: Resolve upstream tree SHAs (`src/git-trees.mjs`)

**Files:**
- Create: `src/git-trees.mjs`
- Test: `test/git-trees.test.mjs`

**Interfaces:**
- Produces:
  - `buildCloneArgs(sourceUrl, dir) -> string[]`
  - `buildRevParseArgs(path) -> string[]`
  - `resolveTrees(sourceUrl, paths, {run?}) -> Promise<Map<path, string|null> | null>` — `null` for the whole map means the clone failed; a `null` value means that path does not exist upstream.
  - `run` is injectable and defaults to a real `git` runner with the signature `(args, {cwd}) -> Promise<{code, out, err}>`.

The test builds a real local git repository and clones from it over `file://`, so the module is verified against actual git behaviour with no network access.

- [ ] **Step 1: Write the failing test**

Create `test/git-trees.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloneArgs, buildRevParseArgs, resolveTrees } from '../src/git-trees.mjs';

// A real repository, so the SHAs compared below are the ones git actually
// produces rather than ones this test made up.
const origin = mkdtempSync(join(tmpdir(), 'nortuscc-origin-'));
mkdirSync(join(origin, 'skills', 'tdd'), { recursive: true });
writeFileSync(join(origin, 'skills', 'tdd', 'SKILL.md'), '# tdd\n');
const git = (...args) => execFileSync('git', args, { cwd: origin, encoding: 'utf8' }).trim();
git('init', '--quiet');
git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.');
git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'seed');
const EXPECTED = git('rev-parse', 'HEAD:skills/tdd');
// file:// keeps git from treating this as a local clone, where --depth and
// --filter are ignored with a warning.
const ORIGIN_URL = pathToFileURL(origin).href;

test.after(() => rmSync(origin, { recursive: true, force: true }));

test('buildCloneArgs fetches trees but no blobs and no working copy', () => {
  const args = buildCloneArgs('https://example.com/r.git', '/tmp/x');
  assert.deepEqual(args, [
    'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet',
    'https://example.com/r.git', '/tmp/x',
  ]);
});

test('buildRevParseArgs asks for the tree at HEAD', () => {
  assert.deepEqual(buildRevParseArgs('skills/tdd'), ['rev-parse', 'HEAD:skills/tdd']);
});

test('resolveTrees returns the real tree SHA git reports', async () => {
  const trees = await resolveTrees(ORIGIN_URL, ['skills/tdd']);
  assert.equal(trees.get('skills/tdd'), EXPECTED);
});

test('resolveTrees maps a path that does not exist upstream to null', async () => {
  const trees = await resolveTrees(ORIGIN_URL, ['skills/tdd', 'skills/gone']);
  assert.equal(trees.get('skills/tdd'), EXPECTED);
  assert.equal(trees.get('skills/gone'), null);
});

test('resolveTrees returns null when the clone itself fails', async () => {
  const trees = await resolveTrees(join(origin, 'does-not-exist'), ['skills/tdd']);
  assert.equal(trees, null);
});

test('resolveTrees with no paths clones nothing', async () => {
  let called = false;
  const trees = await resolveTrees(ORIGIN_URL, [], { run: async () => { called = true; } });
  assert.deepEqual([...trees], []);
  assert.equal(called, false, 'an empty path list has nothing to look up');
});

test('resolveTrees removes its temporary clone', async () => {
  const dirs = [];
  const run = async (args) => {
    if (args[0] === 'clone') { dirs.push(args[args.length - 1]); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: 'deadbeef', err: '' };
  };
  await resolveTrees(ORIGIN_URL, ['skills/tdd'], { run });
  assert.equal(dirs.length, 1);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dirs[0]), false, 'the temp clone must not survive the call');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/git-trees.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/git-trees.mjs`:

```js
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The only place `git` is invoked for update checks. Everything upstream of
// this file deals in tree SHAs, so a change to git's flags is contained here.

// --filter=blob:none fetches every tree but no file contents, and --no-checkout
// skips materialising a working copy — a tree SHA is all this needs, and
// downloading the files to compute one would be waste. Measured on
// mattpocock/skills: 0.45s and 136K, versus a full clone.
export function buildCloneArgs(sourceUrl, dir) {
  return ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet', sourceUrl, dir];
}

export function buildRevParseArgs(path) {
  return ['rev-parse', `HEAD:${path}`];
}

function runGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    // Piped, not inherited: the SHA is the return value, and git's progress
    // chatter would otherwise land in the middle of the report.
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    // git missing from PATH entirely: report it the way a failed command reads.
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
  });
}

// Returns null if the source could not be cloned — the caller reports every
// skill from that source as unknown rather than assuming it is current.
// A path present in the map with a null value exists in the lock but no longer
// exists upstream.
export async function resolveTrees(sourceUrl, paths, { run = runGit } = {}) {
  const trees = new Map();
  if (paths.length === 0) return trees;

  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-trees-'));
  try {
    const cloned = await run(buildCloneArgs(sourceUrl, dir));
    if (cloned.code !== 0) return null;

    for (const path of paths) {
      const res = await run(buildRevParseArgs(path), { cwd: dir });
      // A non-zero exit here is git saying the path is not in HEAD, which is a
      // real answer about the skill, not a failure of the check.
      trees.set(path, res.code === 0 && res.out ? res.out : null);
    }
    return trees;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS. If the `resolveTrees returns the real tree SHA` test fails with a git warning about `--depth` being ignored, confirm the test is using the `file://` URL rather than the bare path.

- [ ] **Step 5: Commit**

```bash
git add src/git-trees.mjs test/git-trees.test.mjs
git commit -m "feat: resolve upstream skill tree SHAs with a blobless clone"
```

---

### Task 3: Confirmation prompt (`src/prompt.mjs`)

**Files:**
- Create: `src/prompt.mjs`
- Test: `test/prompt.test.mjs`

**Interfaces:**
- Produces:
  - `interpret(answer: string) -> boolean` — true only for `y` / `yes`, any case, surrounding whitespace ignored.
  - `confirm(question, {input?, output?, isTTY?}) -> Promise<boolean|null>` — `null` means the question could not be asked because there is no TTY.

`null` rather than `false` for the non-TTY case: the caller needs to distinguish "the user said no" (exit 0, nothing to do) from "nobody could be asked" (exit 2, name `--yes`).

- [ ] **Step 1: Write the failing test**

Create `test/prompt.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { interpret, confirm } from '../src/prompt.mjs';

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('interpret accepts y and yes in any case', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', 'Yes', ' y ', 'yes\n']) {
    assert.equal(interpret(yes), true, `${JSON.stringify(yes)} should mean yes`);
  }
});

test('interpret treats empty input as no', () => {
  assert.equal(interpret(''), false);
  assert.equal(interpret('   '), false);
});

test('interpret treats anything else as no', () => {
  for (const no of ['n', 'no', 'yep', 'sure', 'yy', 'q']) {
    assert.equal(interpret(no), false, `${JSON.stringify(no)} should mean no`);
  }
});

test('confirm returns true when the answer is yes', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from(['y\n']),
    output: sink(),
    isTTY: true,
  });
  assert.equal(answer, true);
});

test('confirm returns false when the answer is empty', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from(['\n']),
    output: sink(),
    isTTY: true,
  });
  assert.equal(answer, false);
});

test('confirm returns null without a TTY instead of blocking', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from([]),
    output: sink(),
    isTTY: false,
  });
  assert.equal(answer, null);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/prompt.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/prompt.mjs`:

```js
import { createInterface } from 'node:readline/promises';

// Only an explicit yes is a yes. Everything else — including a bare Enter —
// is no, so the safe answer is the one that takes no effort to give.
export function interpret(answer) {
  return /^y(es)?$/i.test(String(answer).trim());
}

// null, not false, when there is no TTY: the caller has to tell "the user
// declined" apart from "there was nobody to ask". A scheduled run that blocks
// forever on a prompt nothing will answer is worse than one that fails.
export async function confirm(question, {
  input = process.stdin,
  output = process.stdout,
  isTTY = process.stdin.isTTY,
} = {}) {
  if (!isTTY) return null;
  const rl = createInterface({ input, output });
  try {
    return interpret(await rl.question(`${question} [y/N] `));
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.mjs test/prompt.test.mjs
git commit -m "feat: add a confirmation prompt that refuses to block without a TTY"
```

---

### Task 4: Non-destructive backup (`src/backup.mjs`)

**Files:**
- Modify: `src/backup.mjs` (append after `backupOnce`)
- Test: `test/backup.test.mjs` (create — there is no backup test file yet)

**Interfaces:**
- Consumes: `backupPath` from `src/backup.mjs` (already exported).
- Produces: `preserveCopy(absPath: string, relative: string) -> string | null` — the backup location, or `null` if there was nothing there.

- [ ] **Step 1: Write the failing test**

Create `test/backup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-backup-'));
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { preserveCopy, backupOnce } = await import('../src/backup.mjs');

function skillFolder(name) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-skill-'));
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`);
  return join(dir, name);
}

test('preserveCopy leaves the original in place', () => {
  const src = skillFolder('tdd');
  const target = preserveCopy(src, 'skills/tdd');
  assert.ok(existsSync(src), 'the skill must stay where the updater expects it');
  assert.ok(existsSync(target));
});

test('preserveCopy copies the folder contents', () => {
  const src = skillFolder('research');
  const target = preserveCopy(src, 'skills/research');
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), '# research\n');
});

test('preserveCopy returns null when there is nothing to preserve', () => {
  assert.equal(preserveCopy(join(claude, 'nope'), 'skills/nope'), null);
});

test('backupOnce still moves, so the two are not interchangeable', () => {
  const src = skillFolder('moved');
  backupOnce(src, 'skills/moved');
  assert.equal(existsSync(src), false, 'backupOnce is a move and must stay one');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `preserveCopy is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/backup.mjs`:

```js
// Copy rather than move. backupOnce moves its target aside, which is right
// when something else is about to take that path — but a skill folder has to
// stay exactly where it is for the updater to overwrite it in place, so
// preserving it here must not disturb the original.
export function preserveCopy(absPath, relative) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative);
  cpSync(absPath, target, { recursive: true });
  return target;
}
```

`cpSync` and `existsSync` are already imported at the top of the file; no import change is needed.

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backup.mjs test/backup.test.mjs
git commit -m "feat: preserve a copy without displacing the original"
```

---

### Task 5: Drive the updater (`src/skills-cli.mjs`)

**Files:**
- Modify: `src/skills-cli.mjs` (append)
- Test: `test/skills-cli.test.mjs` (append)

**Interfaces:**
- Produces:
  - `buildUpdateCommand(names: string[]) -> {cmd: string, args: string[]}`
  - `runUpdate(names: string[], {dryRun?}) -> Promise<boolean>`

This task starts with a manual verification, because the spec records one unverified assumption and this is the task that depends on it.

- [ ] **Step 1: Verify the updater's actual behaviour**

The spec assumes `skills update <names…> --global --yes` updates **only** the named skills and never prompts. Confirm it before writing the builder. Run, and read the output carefully:

```bash
npx -y skills update code-review --global --yes 2>&1 | tail -30
```

Then check what actually moved:

```bash
node -e "
const fs=require('fs'),os=require('os');
const l=JSON.parse(fs.readFileSync(os.homedir()+'/.agents/.skill-lock.json','utf8'));
for(const [n,m] of Object.entries(l.skills)) console.log(m.updatedAt, n);
" | sort | tail -30
```

Expected: only `code-review` has a fresh `updatedAt`, and the command exited without waiting for input.

**If instead every global skill was updated, or it prompted:** stop and use the fallback the spec names. Replace Step 3's builder with the per-source form already proven by `apply --skills`, and change the signature to `buildUpdateCommand({source, skills})` returning `['-y', 'skills', 'add', source, '--skill', skills.join(','), '--global', '--yes']`. Task 6 then groups outdated skills by source before calling it. Note which branch you took in the commit message.

- [ ] **Step 2: Write the failing test**

Append to `test/skills-cli.test.mjs`:

```js
import { buildUpdateCommand, runUpdate } from '../src/skills-cli.mjs';

test('buildUpdateCommand names every skill and stays global and non-interactive', () => {
  const { cmd, args } = buildUpdateCommand(['one', 'two']);
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'update', 'one', 'two', '--global', '--yes']);
});

test('buildUpdateCommand passes names as separate arguments, not a comma list', () => {
  const { args } = buildUpdateCommand(['one', 'two']);
  assert.ok(!args.some((a) => a.includes(',')), 'update takes a name list, unlike add --skill');
});

test('buildUpdateCommand handles a single skill', () => {
  const { args } = buildUpdateCommand(['solo']);
  assert.deepEqual(args, ['-y', 'skills', 'update', 'solo', '--global', '--yes']);
});

test('runUpdate in dry-run spawns nothing and reports success', async () => {
  assert.equal(await runUpdate(['one'], { dryRun: true }), true);
});

test('runUpdate with nothing to update spawns nothing', async () => {
  assert.equal(await runUpdate([], { dryRun: true }), true);
});
```

Update the import at the top of the file rather than adding a second `import` line from the same module — merge `buildUpdateCommand` and `runUpdate` into the existing `import { buildCommand, installGroups } from '../src/skills-cli.mjs';`.

- [ ] **Step 3: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `buildUpdateCommand is not a function`.

- [ ] **Step 4: Write the implementation**

Append to `src/skills-cli.mjs`:

```js
// `update` takes a bare name list, where `add --skill` takes one comma-joined
// value. Naming every skill keeps the batch to exactly what was confirmed,
// rather than everything installed globally. --yes skips the scope prompt,
// which is the only prompt this command has.
export function buildUpdateCommand(names) {
  return {
    cmd: 'npx',
    args: ['-y', 'skills', 'update', ...names, '--global', '--yes'],
  };
}

export async function runUpdate(names, { dryRun = false } = {}) {
  if (names.length === 0) return true;
  const command = buildUpdateCommand(names);
  if (dryRun) {
    console.log(`  ${command.cmd} ${command.args.join(' ')}`);
    return true;
  }
  console.log(`\nupdating ${names.length} skill(s)`);
  return runOne(command);
}
```

`runOne` is already defined in this file and stays private to it.

- [ ] **Step 5: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/skills-cli.mjs test/skills-cli.test.mjs
git commit -m "feat: build the skills update command for a confirmed batch"
```

---

### Task 6: Orchestration (`src/commands/update.mjs`)

**Files:**
- Create: `src/commands/update.mjs`
- Test: `test/update.test.mjs`

**Interfaces:**
- Consumes: `planUpdates`, `updatableSkills`, `sourcesOf` (Task 1); `resolveTrees` (Task 2); `confirm` (Task 3); `preserveCopy` (Task 4); `runUpdate` (Task 5); `readSkillLock`, `installedSkillNames` from `src/skills.mjs`; `agentsSkillsDir` from `src/resolve.mjs`; `formatRow`, `section` from `src/report.mjs`.
- Produces:
  - `exitCode({plan, updateFailed}) -> number`
  - `reportLines(plan) -> string[]`
  - `run(args: string[], deps?: object) -> Promise<number>`
  - `deps` overrides `{resolveTrees, confirm, runUpdate, preserve, readLock, installed}`, defaulting to the real implementations. Injecting them is how every branch is tested without a network, a prompt, or a spawn.

- [ ] **Step 1: Write the failing test**

Create `test/update.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-update-'));
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { run, exitCode, reportLines } = await import('../src/commands/update.mjs');

const URL = 'https://github.com/o/r.git';
const entry = (path, hash) => ({
  source: 'o/r', sourceUrl: URL, skillPath: `${path}/SKILL.md`, skillFolderHash: hash,
});

// Two installed skills: `stale` has moved upstream, `fresh` has not.
function baseDeps(overrides = {}) {
  return {
    readLock: () => ({ skills: { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') } }),
    installed: () => ['fresh', 'stale'],
    resolveTrees: async () => new Map([['s/stale', 'new'], ['s/fresh', 'same']]),
    confirm: async () => true,
    preserve: () => '/backup/path',
    runUpdate: async () => true,
    ...overrides,
  };
}

test('exitCode is 0 when everything is current', () => {
  const plan = { current: ['a'], outdated: [], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
});

test('exitCode is 1 for a gone skill even with nothing outdated', () => {
  const plan = { current: [], outdated: [], gone: [{ name: 'a' }], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 1);
});

test('exitCode is 1 for an unreachable source', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [{ name: 'a' }], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 1);
});

test('exitCode is 1 when the updater failed', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: true }), 1);
});

test('exitCode ignores local skills, which are informational', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [], local: ['mine'] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
});

test('exitCode is 0 for an outdated skill left alone — declining is not a failure', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
});

test('reportLines shows both SHAs for an outdated skill', () => {
  const plan = {
    current: [], gone: [], unknown: [], local: [],
    outdated: [{ name: 'tdd', source: 'o/r', from: 'abcdef1234', to: '1234567890' }],
  };
  const text = reportLines(plan).join('\n');
  assert.match(text, /tdd/);
  assert.match(text, /abcdef1/);
  assert.match(text, /1234567/);
});

test('--check and --yes together are refused', async () => {
  assert.equal(await run(['--check', '--yes'], baseDeps()), 2);
});

test('--check reports outdated skills, exits 1, and updates nothing', async () => {
  let updated = false;
  const code = await run(['--check'], baseDeps({ runUpdate: async () => { updated = true; return true; } }));
  assert.equal(code, 1);
  assert.equal(updated, false, '--check must never write');
});

test('--check never prompts', async () => {
  let asked = false;
  await run(['--check'], baseDeps({ confirm: async () => { asked = true; return true; } }));
  assert.equal(asked, false);
});

test('an all-current machine exits 0 and updates nothing', async () => {
  let updated = false;
  const deps = baseDeps({
    resolveTrees: async () => new Map([['s/stale', 'old'], ['s/fresh', 'same']]),
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.equal(updated, false);
});

test('a confirmed run backs up and updates only the outdated skills', async () => {
  const preserved = [];
  const sent = [];
  const deps = baseDeps({
    preserve: (abs, rel) => { preserved.push(rel); return '/b'; },
    runUpdate: async (names) => { sent.push(...names); return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.deepEqual(sent, ['stale'], 'only the outdated skill may be updated');
  assert.equal(preserved.length, 1);
  assert.match(preserved[0], /stale/);
});

test('backups are taken before the updater runs', async () => {
  const order = [];
  const deps = baseDeps({
    preserve: () => { order.push('backup'); return '/b'; },
    runUpdate: async () => { order.push('update'); return true; },
  });
  await run([], deps);
  assert.deepEqual(order, ['backup', 'update']);
});

test('declining changes nothing and exits 0', async () => {
  let updated = false;
  const deps = baseDeps({
    confirm: async () => false,
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.equal(updated, false);
});

test('--yes skips the prompt entirely', async () => {
  let asked = false;
  const deps = baseDeps({ confirm: async () => { asked = true; return true; } });
  assert.equal(await run(['--yes'], deps), 0);
  assert.equal(asked, false);
});

test('no TTY without --yes refuses with exit 2 rather than hanging', async () => {
  let updated = false;
  const deps = baseDeps({
    confirm: async () => null,
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 2);
  assert.equal(updated, false);
});

test('an unreachable source exits 1 and updates nothing', async () => {
  const deps = baseDeps({ resolveTrees: async () => null });
  assert.equal(await run(['--yes'], deps), 1);
});

test('a failing updater exits 1', async () => {
  const deps = baseDeps({ runUpdate: async () => false });
  assert.equal(await run(['--yes'], deps), 1);
});

test('a skill whose folder vanished upstream is never sent to the updater', async () => {
  const sent = [];
  const deps = baseDeps({
    resolveTrees: async () => new Map([['s/stale', null], ['s/fresh', 'same']]),
    runUpdate: async (names) => { sent.push(...names); return true; },
  });
  const code = await run(['--yes'], deps);
  assert.equal(code, 1);
  assert.deepEqual(sent, [], 'a gone skill has nowhere to update from');
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../src/commands/update.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/commands/update.mjs`:

```js
import { join } from 'node:path';
import { planUpdates, updatableSkills, sourcesOf } from '../skill-updates.mjs';
import { resolveTrees as realResolveTrees } from '../git-trees.mjs';
import { confirm as realConfirm } from '../prompt.mjs';
import { preserveCopy } from '../backup.mjs';
import { runUpdate as realRunUpdate } from '../skills-cli.mjs';
import { readSkillLock, installedSkillNames } from '../skills.mjs';
import { agentsSkillsDir } from '../resolve.mjs';
import { formatRow, section } from '../report.mjs';

const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');

// `local` is informational — a hand-authored skill is not a problem to fix.
// `gone` and `unknown` both need a decision, so they exit non-zero the way
// `status` does when anything needs attention.
//
// Declining is deliberately not an input here: a declined update is not a
// failure, so it returns whatever the plan alone says. That still leaves a
// `gone` skill exiting 1 even when the user said no to updating.
export function exitCode({ plan, updateFailed }) {
  if (updateFailed) return 1;
  if (plan.gone.length > 0 || plan.unknown.length > 0) return 1;
  return 0;
}

// Counts first, in the aggregate style status.mjs uses, then a detail line per
// outdated skill — listing 24 up-to-date skills individually would bury the
// two that matter.
export function reportLines(plan) {
  const lines = [];
  if (plan.current.length) lines.push(formatRow('current', String(plan.current.length), ''));
  if (plan.outdated.length) {
    lines.push(formatRow('outdated', String(plan.outdated.length), plan.outdated.map((o) => o.name).join(', ')));
  }
  if (plan.gone.length) {
    lines.push(formatRow('gone', String(plan.gone.length), plan.gone.map((g) => g.name).join(', ')));
  }
  if (plan.unknown.length) {
    lines.push(formatRow('unreachable', String(plan.unknown.length), plan.unknown.map((u) => u.name).join(', ')));
  }
  if (plan.local.length) {
    lines.push(formatRow('local', String(plan.local.length), plan.local.join(', ')));
  }
  if (!lines.length) lines.push(formatRow('skills', 'none', 'nothing installed to check'));

  if (plan.outdated.length) {
    lines.push('');
    for (const o of plan.outdated) {
      lines.push(formatRow(o.name, 'outdated', `${short(o.from)} -> ${short(o.to)}  ${o.source}`));
    }
  }
  return lines;
}

export async function run(args = [], deps = {}) {
  const {
    resolveTrees = realResolveTrees,
    confirm = realConfirm,
    runUpdate = realRunUpdate,
    preserve = preserveCopy,
    readLock = readSkillLock,
    installed = installedSkillNames,
  } = deps;

  const check = args.includes('--check');
  const yes = args.includes('--yes');

  // --check never prompts, so --yes has nothing to skip. Refusing beats
  // silently ignoring one of them, the same call apply makes on
  // --take-repo --take-local.
  if (check && yes) {
    console.error('nortuscc: --check and --yes are mutually exclusive (--check never prompts)');
    return 2;
  }

  const lock = readLock();
  const installedNames = installed();
  const entries = updatableSkills(lock, installedNames);

  // One clone per source, not per skill. A source that fails to clone is left
  // out of remoteTrees entirely, which is how planUpdates learns to mark just
  // that source's skills unknown while the others still get a real answer.
  const remoteTrees = new Map();
  for (const { sourceUrl, paths } of sourcesOf(entries)) {
    const trees = await resolveTrees(sourceUrl, paths);
    if (trees) remoteTrees.set(sourceUrl, trees);
  }

  const plan = planUpdates({ lock, installedNames, remoteTrees });
  process.stdout.write('\n' + section('update', reportLines(plan)));

  if (check) {
    if (plan.outdated.length) {
      process.stdout.write('\nRun: nortuscc update\n');
      return 1;
    }
    return exitCode({ plan, updateFailed: false });
  }

  if (plan.outdated.length === 0) {
    return exitCode({ plan, updateFailed: false });
  }

  if (!yes) {
    const answer = await confirm(`\nUpdate ${plan.outdated.length} skill(s)?`);
    if (answer === null) {
      console.error(
        '\nnortuscc: no terminal to confirm on. Re-run with --yes to update without asking,\n' +
          '  or with --check to report only.',
      );
      return 2;
    }
    if (!answer) {
      process.stdout.write('nothing updated\n');
      return exitCode({ plan, updateFailed: false });
    }
  }

  // Backups before the updater, never after: once it has overwritten a skill
  // folder in place the previous version is gone, and this copy is the only
  // way back.
  const names = plan.outdated.map((o) => o.name);
  let backupLocation = null;
  for (const name of names) {
    backupLocation = preserve(join(agentsSkillsDir(), name), join('skills', name)) || backupLocation;
  }
  if (backupLocation) process.stdout.write(`\nbacked up -> ${backupLocation}\n`);

  const ok = await runUpdate(names);

  // Re-read the lock rather than assuming the update did what was asked, so
  // the closing report describes what was observed.
  const after = readLock();
  const moved = plan.outdated.filter((o) => after.skills?.[o.name]?.skillFolderHash !== o.from);
  process.stdout.write(
    '\n' + section('updated', moved.length
      ? moved.map((o) => formatRow(o.name, 'updated', `${short(o.from)} -> ${short(after.skills[o.name]?.skillFolderHash)}`))
      : [formatRow('skills', 'unchanged', 'the updater reported no change')]),
  );

  if (!ok) {
    process.stdout.write('\nThe updater failed. See the output above; the backup is listed at the top.\n');
  }

  return exitCode({ plan, updateFailed: !ok });
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/update.mjs test/update.test.mjs
git commit -m "feat: add nortuscc update, checking and confirming before it writes"
```

---

### Task 7: CLI wiring and documentation

**Files:**
- Modify: `bin/nortuscc.mjs:2` (`VERBS`) and the `USAGE` string
- Modify: `README.md` (command table, skills section)
- Test: `test/cli.test.mjs` (append)

**Interfaces:**
- Consumes: `run` from `src/commands/update.mjs` — loaded by the existing dynamic `import(\`../src/commands/${verb}.mjs\`)`, so no dispatch code changes.

- [ ] **Step 1: Write the failing test**

Read `test/cli.test.mjs` first to match how it invokes the binary, then append tests in that same style. If it spawns the binary and asserts on output, use:

```js
test('update is a known verb', () => {
  // --check --yes is refused by update itself with exit 2 and its own message,
  // which proves dispatch reached the command rather than the unknown-verb
  // guard. It is also the only flag pair that cannot touch the network.
  const res = spawnSync(process.execPath, [BIN, 'update', '--check', '--yes'], { encoding: 'utf8' });
  assert.ok(!res.stderr.includes("unknown command 'update'"), 'update must reach its command module');
  assert.match(res.stderr, /mutually exclusive/);
  assert.equal(res.status, 2);
});

test('usage lists update', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(res.stdout, /update \[--check\]/);
});
```

Adjust the `BIN` constant name and spawn style to whatever `test/cli.test.mjs` already uses — do not introduce a second convention in the same file.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm test 2>&1 | tail -20
```

Expected: FAIL — usage does not mention `update`, and the verb is rejected as unknown.

- [ ] **Step 3: Wire the verb**

In `bin/nortuscc.mjs`, add `update` to `VERBS`:

```js
const VERBS = ['setup', 'status', 'apply', 'capture', 'pull', 'push', 'update'];
```

And add these two lines to `USAGE`, after the `apply` block and before `capture`:

```
  update [--check] [--yes]          refresh installed skills from their sources
                                    --check reports what is stale and writes nothing
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npm test 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 5: Document it**

In `README.md`, add a row to the command table after `apply`:

```markdown
| `update [--check] [--yes]` | Refresh installed skills from their sources, after confirmation |
```

And add this to the end of the `## Skills` section (the outer fence below is
four backticks so the inner `bash` block survives the copy — paste only what is
inside it):

````markdown
### Staying current

`apply --skills` installs skills the machine is *missing*. `nortuscc update`
refreshes the ones it already has.

The skill lock records a `skillFolderHash` per skill, which is the git tree SHA
of that skill's folder in its source repo. Comparing it against the repo's
current tree SHA answers "is there an update?" without downloading a single
file: one blobless, no-checkout shallow clone per source repo, then
`git rev-parse HEAD:<folder>`.

```bash
nortuscc update --check   # report only; exits non-zero if anything is stale
nortuscc update           # report, confirm, back up, then update
```

Every skill lands in one of five states: `current`, `outdated`, `gone` (the
folder no longer exists upstream), `unreachable` (the source repo could not be
cloned — only that source's skills are affected), and `local` (hand-authored,
with no source anything could update from).

Outdated skills are copied to `~/.claude/backups/nortuscc-<stamp>/skills/`
before the updater runs, and the closing report is built by re-reading the lock
afterwards, so it describes what happened rather than what was intended.

Without a TTY and without `--yes`, `update` refuses and exits 2 rather than
blocking a scheduled run on a prompt nothing will answer.
````

- [ ] **Step 6: Verify the whole thing end to end**

```bash
npm test
node bin/nortuscc.mjs --help
node bin/nortuscc.mjs update --check
```

Expected: full suite green; help lists `update`; `update --check` prints a real report against this machine's actual skills, writes nothing, and exits 0 or 1 depending on what it found. Confirm `~/.agents/skills` is untouched:

```bash
ls -la ~/.agents/skills | head -5
```

- [ ] **Step 7: Commit**

```bash
git add bin/nortuscc.mjs README.md test/cli.test.mjs
git commit -m "feat: expose update as a verb and document the check"
```

---

## Self-Review

**Spec coverage.** Command and flags → Task 7 and Task 6. `--check --yes` refusal → Task 6. Scope, including sourced extras and `local` skips → Task 1. Blobless clone mechanism → Task 2. Five states → Task 1, reported in Task 6. Exit-code policy including `gone`/`unknown` → Task 6 `exitCode`. Non-TTY refusal → Tasks 3 and 6. Partial failure isolation per source → Tasks 1, 2 and 6. Backup before update → Tasks 4 and 6. Re-read lock and report what moved → Task 6. Every module in the spec's table → Tasks 1–6. `bin` and README → Task 7. The spec's one unverified assumption → Task 5 Step 1, with a written fallback.

**Type consistency.** `planUpdates` returns `{current, outdated, gone, unknown, local}` in Task 1 and is consumed with those exact keys by `exitCode` and `reportLines` in Task 6. `outdated` entries carry `{name, source, from, to}` in both. `resolveTrees(sourceUrl, paths, {run})` returns `Map|null` in Task 2 and is destructured as such in Task 6. `confirm` returns `boolean|null` in Task 3 and all three cases are branched on in Task 6. `preserveCopy(absPath, relative)` in Task 4 matches the `preserve(abs, rel)` call in Task 6. `runUpdate(names, {dryRun})` in Task 5 is called as `runUpdate(names)` in Task 6.

**Known risk carried deliberately.** Task 5 Step 1 is a live command against real skills. It is placed first in that task so the builder is written against verified behaviour, and the fallback is spelled out so an implementer who finds the assumption false does not have to redesign.
