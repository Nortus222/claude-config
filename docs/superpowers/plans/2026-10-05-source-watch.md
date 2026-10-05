# Sources Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone `packages/source-watch/` package. For each skill source a setup uses, it reports the latest upstream revision, its relation to the baseline (the pin), the commits between them, the changed skills with `SKILL.md` diffs, and unpushed edits in the author's local checkouts.

**Architecture:** Pure helpers (`redact`, `skillFolders`, `sourcesFrom`) sit underneath an Effect `Git` service with a single `run` operation. `watchUpstream` keeps a bare partial clone per source in a caller-supplied cache directory. `watchCheckout` reads a local work tree without changing it. `watchSources` runs up to four sources at once. Each source's failures stay in that source's report.

**Tech Stack:** TypeScript (erasable syntax, run directly on Node 22.18+), `effect@4.0.1`, the git CLI, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-05-source-watch-design.md`

## Global Constraints

- Everything lives in `packages/source-watch/`. Do not modify `src/`, `packages/profile-engine/`, `apps/desktop/` or the root `package.json`.
- Runtime dependency: `effect` pinned at exactly `4.0.1`. Dev dependencies: `typescript@7.0.2`, `@types/node@25.5.0`, `@nortuscc/profile-engine@file:../profile-engine`. Nothing else.
- The engine is consumed as types only (`import type`).
- `engines.node` is `>=22.18`. Relative imports carry `.ts`. Only erasable syntax is allowed: no `enum`, no `namespace`, no constructor parameter properties.
- Tests live in `checks/*.spec.ts` and use only `node:test` and `node:assert/strict`. No test may touch the network. Every Effect test runs through `runGit` from `checks/fixtures.ts`, which provides `nodeGit({ allowProtocols: 'file' })`.
- Use `node:`-prefixed builtin imports.
- Commit-message prefixes: `feat:`, `test:`, `docs:`, `chore:`. Commit after every task. No `Co-Authored-By` trailer.
- Commit emails are never requested from git. Every URL and every git error reason passes through `redact`.
- Comments state purpose or contract and do not narrate. Match `packages/profile-engine/src` in style.
- Run commands from `packages/source-watch/` unless stated otherwise.

## Review Focus

1. **A credential in a source URL** must never appear in `url`, `reason` or anywhere else in the report. Tested in Task 4 and Task 8.
2. **A pin ref that starts with `-`** (for example `--output=/tmp/x`) must never reach git as an option. It reads as `baseline-missing`. Tested in Task 5.
3. **Non-ASCII skill folder names** (`skills/café`) must be discovered and diffed like any other. Tested in Task 6.
4. **An empty upstream repository** (no commits) is reported `unreachable` with git's reason, not thrown. Tested in Task 5.
5. **A checkout path that is a subfolder of the work tree** reports the whole repository's edits. Tested in Task 7.

---

### Task 1: Package scaffold, model and `redact`

**Files:**
- Create: `packages/source-watch/package.json`
- Create: `packages/source-watch/tsconfig.json`
- Create: `packages/source-watch/src/model.ts`
- Create: `packages/source-watch/src/redact.ts`
- Create: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/redact.spec.ts`
- Generated: `packages/source-watch/package-lock.json`

**Interfaces:**
- Produces: every type in `model.ts` below, and `redact(text: string): string`.

- [ ] **Step 1: Create `package.json` and `tsconfig.json`**

`packages/source-watch/package.json`:
```json
{
  "name": "@nortuscc/source-watch",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Watches the skill sources a setup uses: upstream revisions past each pin, changed skills with SKILL.md diffs, and unpushed local edits",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "node --test \"checks/*.spec.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "effect": "4.0.1"
  },
  "devDependencies": {
    "@nortuscc/profile-engine": "file:../profile-engine",
    "@types/node": "25.5.0",
    "typescript": "7.0.2"
  },
  "engines": {
    "node": ">=22.18"
  }
}
```

`packages/source-watch/tsconfig.json`: an exact copy of `packages/profile-engine/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "allowJs": true,
    "checkJs": false,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "checks"]
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install && (cd ../profile-engine && npm ci)`
Expected: `package-lock.json` is created, and `node_modules/@nortuscc/profile-engine` is a symlink. The engine's own `node_modules` is needed only so `tsc` can follow the engine's imports. It is gitignored, and no tracked file in the engine changes.

- [ ] **Step 3: Write the failing test**

`packages/source-watch/checks/redact.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.ts';

test('strips userinfo from URLs', () => {
  assert.equal(
    redact('fatal: https://ada:s3cret@github.com/a/b.git not found'),
    'fatal: https://github.com/a/b.git not found',
  );
  assert.equal(redact('ssh://git@host.example/x.git'), 'ssh://host.example/x.git');
});

test('masks credential query values, including inside quotes', () => {
  assert.equal(
    redact('https://h/x?token=abc&ref=main&access_token=def'),
    'https://h/x?token=***&ref=main&access_token=***',
  );
  assert.equal(
    redact("fatal: '/nope/x?password=hunter2' does not appear to be a git repository"),
    "fatal: '/nope/x?password=***' does not appear to be a git repository",
  );
});

test('leaves ordinary text alone', () => {
  const text = 'git@github.com:a/b.git, ada@example.com and https://github.com/a/b.git';
  assert.equal(redact(text), text);
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/redact.ts` cannot be found.

- [ ] **Step 5: Write `model.ts`, `redact.ts` and `index.ts`**

`packages/source-watch/src/model.ts`:
```ts
// The watcher's vocabulary: what it is asked to watch and what it reports.

// One skill source as a setup uses it.
export type WatchedSource = {
  readonly source: string; // as the manifest writes it, e.g. 'mattpocock/skills'
  readonly url: string; // what is fetched
  readonly baseline?: string; // a ref: the pin, or whatever the caller compares against
  readonly exact: boolean; // an exact source does not report skills added upstream
  readonly skills: ReadonlyArray<string>; // the setup's skills from this source
  readonly checkout?: string; // absolute path of the author's local git checkout
};

export type Revision = { readonly sha: string; readonly date: string; readonly tags: ReadonlyArray<string> };
// Never carries an email.
export type Commit = { readonly sha: string; readonly subject: string; readonly author: string; readonly date: string };

export type SkillChange = {
  readonly name: string;
  readonly path?: string; // folder at latest, or at baseline when removed
  readonly status: 'unchanged' | 'changed' | 'removed' | 'missing';
  readonly commits: ReadonlyArray<string>; // shas that touched the folder, newest first
  readonly skillMd?: string; // unified diff of SKILL.md, baseline → latest
  readonly files: ReadonlyArray<string>; // other changed files in the folder, repo-relative
};

export type LocalSkill = { readonly name: string; readonly path: string; readonly skillMd?: string };
export type LocalReport = {
  readonly path: string;
  readonly status: 'clean' | 'edits' | 'no-upstream' | 'not-a-repo';
  readonly branch?: string;
  readonly unpushed: ReadonlyArray<Commit>; // @{u}..HEAD, newest first
  readonly uncommitted: ReadonlyArray<string>; // changed, staged or untracked paths, sorted
  readonly skills: ReadonlyArray<LocalSkill>; // skills with local edits, sorted by name
};

export type SourceStatus = 'up-to-date' | 'ahead' | 'diverged' | 'unpinned' | 'baseline-missing' | 'unreachable';
export type SourceReport = {
  readonly source: string;
  readonly url: string; // redacted
  readonly status: SourceStatus;
  readonly reason?: string; // redacted; for baseline-missing and unreachable
  readonly latest?: Revision;
  readonly baseline?: Revision & { readonly ref: string };
  readonly commits: ReadonlyArray<Commit>; // baseline..latest, newest first
  readonly skills: ReadonlyArray<SkillChange>; // one per declared skill, in declared order
  readonly added: ReadonlyArray<string>; // non-exact only: undeclared skills new since baseline
  readonly local?: LocalReport;
};
```

`packages/source-watch/src/redact.ts`:
```ts
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;
const SECRET_PARAM = /([?&](?:token|access_token|password|key)=)[^&\s#'"]+/gi;

// Removes credentials a URL may carry, wherever the URL appears in the text.
export function redact(text: string): string {
  return text.replace(USERINFO, '$1').replace(SECRET_PARAM, '$1***');
}
```

`packages/source-watch/src/index.ts`:
```ts
export * from './model.ts';
export { redact } from './redact.ts';
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 3 tests pass, and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/source-watch
git commit -m "feat: source-watch package with report model and redact"
```

---

### Task 2: Skill folder discovery

**Files:**
- Create: `packages/source-watch/src/discover.ts`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/discover.spec.ts`

**Interfaces:**
- Produces: `skillFolders(paths: Iterable<string>): Map<string, string>`, which maps skill name to folder path. Insertion order is folder path in code-point order.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/discover.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFolders } from '../src/discover.ts';

test('a skill is the shallowest folder holding SKILL.md, named by its basename', () => {
  const folders = skillFolders([
    'README.md',
    'SKILL.md',
    'skills/tdd/SKILL.md',
    'skills/tdd/refs/SKILL.md',
    'skills/tdd/notes.md',
    'skills/tdd-extra/SKILL.md',
    'eng/grill/SKILL.md',
  ]);
  assert.deepEqual([...folders], [
    ['grill', 'eng/grill'],
    ['tdd', 'skills/tdd'],
    ['tdd-extra', 'skills/tdd-extra'],
  ]);
});

test('when two folders share a name, the first in path order wins', () => {
  assert.deepEqual([...skillFolders(['b/x/SKILL.md', 'a/x/SKILL.md'])], [['x', 'a/x']]);
});

test('no SKILL.md means no skills', () => {
  assert.deepEqual([...skillFolders(['README.md', 'skills/tdd/notes.md'])], []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/discover.ts` cannot be found.

- [ ] **Step 3: Implement**

`packages/source-watch/src/discover.ts`:
```ts
const MARKER = '/SKILL.md';

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const depth = (path: string) => path.split('/').length;

// Skill folders among a repository's file paths, by the CLI's rule (`upstreamSkills` in
// src/skill-updates.mjs): a folder holding SKILL.md, never the repository root, with a folder
// nested inside another skill treated as part of it. A skill is named by its folder's basename;
// when two folders share a name, the first in path order wins. Returns name → folder.
export function skillFolders(paths: Iterable<string>): Map<string, string> {
  const folders = [...paths]
    .filter((path) => path.endsWith(MARKER))
    .map((path) => path.slice(0, -MARKER.length))
    .sort((a, b) => depth(a) - depth(b) || byCodePoint(a, b));

  const kept: string[] = [];
  for (const folder of folders) {
    if (!kept.some((parent) => folder.startsWith(`${parent}/`))) kept.push(folder);
  }

  const byName = new Map<string, string>();
  for (const folder of kept.sort(byCodePoint)) {
    const name = folder.slice(folder.lastIndexOf('/') + 1);
    if (!byName.has(name)) byName.set(name, folder);
  }
  return byName;
}
```

Append to `src/index.ts`:
```ts
export { skillFolders } from './discover.ts';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: discover skill folders with the CLI's rule"
```

---

### Task 3: `sourcesFrom` adapter

**Files:**
- Create: `packages/source-watch/src/sources.ts`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/sources.spec.ts`

**Interfaces:**
- Consumes: `DesiredConfig`/`ResolvedSkill` types from `@nortuscc/profile-engine` (type only), and `WatchedSource` from `model.ts`.
- Produces: `sourceUrl(source: string): string` and `sourcesFrom(config: Pick<DesiredConfig, 'skills'>, options?: { readonly checkouts?: Readonly<Record<string, string>> }): WatchedSource[]`.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/sources.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedSkill } from '@nortuscc/profile-engine';
import { sourceUrl, sourcesFrom } from '../src/sources.ts';

const base = { layer: 'base', source: 'skills-manifest.txt' } as const;
const pinned = (ref: string) => ({ ref, from: { layer: 'pin', source: 'skill-pins.json' } as const });
const skill = (name: string, source: string, extra: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  name, source, exact: false, optional: false, install: true, from: base, ...extra,
});

test('groups skills by source in first-seen order, with the pin as baseline', () => {
  const config = {
    skills: [
      skill('tdd', 'mattpocock/skills', { pin: pinned('v1') }),
      skill('explain', 'Nortus222/agent-skills', { optional: true, install: false }),
      skill('grill', 'mattpocock/skills', { pin: pinned('v1') }),
    ],
  };
  assert.deepEqual(sourcesFrom(config), [
    { source: 'mattpocock/skills', url: 'https://github.com/mattpocock/skills.git', baseline: 'v1', exact: false, skills: ['tdd', 'grill'] },
    { source: 'Nortus222/agent-skills', url: 'https://github.com/Nortus222/agent-skills.git', exact: false, skills: ['explain'] },
  ]);
});

test('a source is exact when any of its groups is, and a repeated name is listed once', () => {
  const config = { skills: [skill('a', 'x/y'), skill('b', 'x/y', { exact: true }), skill('a', 'x/y')] };
  assert.deepEqual(sourcesFrom(config), [
    { source: 'x/y', url: 'https://github.com/x/y.git', exact: true, skills: ['a', 'b'] },
  ]);
});

test('checkouts attach by source', () => {
  const config = { skills: [skill('explain', 'Nortus222/agent-skills'), skill('tdd', 'mattpocock/skills')] };
  const sources = sourcesFrom(config, { checkouts: { 'Nortus222/agent-skills': '/work/agent-skills' } });
  assert.equal(sources[0]!.checkout, '/work/agent-skills');
  assert.equal('checkout' in sources[1]!, false);
});

test('a source that is already a URL is fetched as written', () => {
  assert.equal(sourceUrl('https://gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git');
  assert.equal(sourceUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(sourceUrl('a/b'), 'https://github.com/a/b.git');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/sources.ts` cannot be found.

- [ ] **Step 3: Implement**

`packages/source-watch/src/sources.ts`:
```ts
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { WatchedSource } from './model.ts';

type Draft = { source: string; url: string; baseline?: string; exact: boolean; skills: string[]; checkout?: string };

// What a manifest source fetches: a URL as written, otherwise the GitHub shorthand the CLI
// falls back to.
export function sourceUrl(source: string): string {
  return source.includes('://') || source.startsWith('git@') ? source : `https://github.com/${source}.git`;
}

// The sources a resolved setup uses, one per manifest source in first-seen order. Every declared
// skill is included, installed on this machine or not. A source's pin is its baseline.
export function sourcesFrom(
  config: Pick<DesiredConfig, 'skills'>,
  options: { readonly checkouts?: Readonly<Record<string, string>> } = {},
): WatchedSource[] {
  const bySource = new Map<string, Draft>();
  for (const skill of config.skills) {
    let draft = bySource.get(skill.source);
    if (draft === undefined) {
      draft = { source: skill.source, url: sourceUrl(skill.source), exact: false, skills: [] };
      const checkouts = options.checkouts ?? {};
      if (Object.hasOwn(checkouts, skill.source)) draft.checkout = checkouts[skill.source]!;
      bySource.set(skill.source, draft);
    }
    draft.exact ||= skill.exact;
    if (draft.baseline === undefined && skill.pin !== undefined) draft.baseline = skill.pin.ref;
    if (!draft.skills.includes(skill.name)) draft.skills.push(skill.name);
  }
  return [...bySource.values()];
}
```

Append to `src/index.ts`:
```ts
export { sourceUrl, sourcesFrom } from './sources.ts';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0. If typecheck cannot resolve `effect` from inside the engine, run `(cd ../profile-engine && npm ci)` (Task 1, Step 2).

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: derive watched sources from a resolved setup"
```

---

### Task 4: Git service and test fixtures

**Files:**
- Create: `packages/source-watch/src/git.ts`
- Create: `packages/source-watch/checks/fixtures.ts`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/git.spec.ts`

**Interfaces:**
- Consumes: `redact` and `Commit`.
- Produces:
  - `class GitFailed` (tag `'GitFailed'`, `{ reason: string }`, already redacted)
  - `type RunOptions = { readonly cwd?: string; readonly ok?: ReadonlyArray<number> }`
  - `class Git`, a `Context.Service` with `run(args: ReadonlyArray<string>, options?: RunOptions): Effect.Effect<string, GitFailed>`, which returns raw stdout
  - `nodeGit(options?: { readonly allowProtocols?: string }): Layer<Git>`
  - `LOG_FORMAT: string`, `parseLog(out: string): Commit[]` and `DIFF_FLAGS: readonly string[]`
  - Fixtures:
    - `tempDir(t): string`
    - `gitSync(cwd, ...args): string`
    - `writeFiles(dir, files)`
    - `commitFiles(dir, message, files?): string`
    - `makeRepo(root, name?): Repo`, where `Repo = { dir, url, commit(message, files?), tag(name) }`
    - `runGit(effect): Promise<A>`

- [ ] **Step 1: Write the fixtures**

`packages/source-watch/checks/fixtures.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { Effect } from 'effect';
import { Git, nodeGit } from '../src/git.ts';

// Keep the developer's git configuration out of every fixture and every git the tests spawn.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.TZ = 'UTC';

export type Files = Readonly<Record<string, string | null>>; // null deletes the path

// A temporary directory removed when the test ends.
export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'source-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let tick = 0;
// Runs git synchronously with a fixed identity and a clock that advances one minute per call.
export function gitSync(cwd: string, ...args: string[]): string {
  const date = new Date(Date.UTC(2026, 0, 1) + tick++ * 60_000).toISOString().replace('.000', '');
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_COMMITTER_DATE: date,
    },
  }).trim();
}

export function writeFiles(dir: string, files: Files): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    if (text === null) rmSync(full, { recursive: true, force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
}

// Writes the files, commits everything and returns the new commit's sha.
export function commitFiles(dir: string, message: string, files: Files = {}): string {
  writeFiles(dir, files);
  gitSync(dir, 'add', '-A');
  gitSync(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
  return gitSync(dir, 'rev-parse', 'HEAD');
}

export type Repo = {
  readonly dir: string;
  readonly url: string; // file:// URL
  commit(message: string, files?: Files): string;
  tag(name: string): void;
};

export function makeRepo(root: string, name = 'upstream'): Repo {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  gitSync(dir, 'init', '--quiet', '--initial-branch=main');
  return {
    dir,
    url: pathToFileURL(dir).href,
    commit: (message, files) => commitFiles(dir, message, files),
    tag: (tag) => void gitSync(dir, 'tag', tag),
  };
}

// Runs an effect against real git, refusing every transport but file://.
export const runGit = <A, E>(effect: Effect.Effect<A, E, Git>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(nodeGit({ allowProtocols: 'file' }))));
```

- [ ] **Step 2: Write the failing test**

`packages/source-watch/checks/git.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Git, LOG_FORMAT, parseLog, type RunOptions } from '../src/git.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

const run = (args: string[], options?: RunOptions) =>
  Effect.gen(function* () {
    const git = yield* Git;
    return yield* git.run(args, options);
  });

test('returns stdout, and parseLog reads commits without emails', async (t) => {
  const repo = makeRepo(tempDir(t));
  const first = repo.commit('first', { 'a.txt': 'a\n' });
  const second = repo.commit('second: with | odd chars', { 'a.txt': 'b\n' });
  const commits = parseLog(await runGit(run(['log', LOG_FORMAT], { cwd: repo.dir })));
  assert.deepEqual(commits.map((c) => [c.sha, c.subject, c.author]), [
    [second, 'second: with | odd chars', 'Ada'],
    [first, 'first', 'Ada'],
  ]);
  assert.match(commits[0]!.date, /^2026-01-01T\d\d:\d\d:\d\d\+00:00$/);
  assert.doesNotMatch(JSON.stringify(commits), /example\.com/);
});

test('a failing command is a GitFailed carrying git\'s message, redacted', async (t) => {
  const root = tempDir(t);
  const error = await runGit(Effect.flip(run(['ls-remote', `file://${root}/nope?token=s3cret`])));
  assert.equal(error._tag, 'GitFailed');
  assert.match(error.reason, /does not appear to be a git repository/);
  assert.doesNotMatch(error.reason, /s3cret/);
});

test('transports outside allowProtocols are refused without touching the network', async (t) => {
  const root = tempDir(t);
  const error = await runGit(Effect.flip(run(['clone', 'https://ada:s3cret@example.invalid/x.git', join(root, 'x')])));
  assert.match(error.reason, /transport 'https' not allowed/);
  assert.doesNotMatch(error.reason, /s3cret/);
});

test('an exit code listed in ok succeeds', async (t) => {
  const repo = makeRepo(tempDir(t));
  const first = repo.commit('first');
  const second = repo.commit('second');
  assert.equal(await runGit(run(['merge-base', '--is-ancestor', second, first], { cwd: repo.dir, ok: [0, 1] })), '');
  await assert.rejects(runGit(run(['merge-base', '--is-ancestor', second, first], { cwd: repo.dir })));
});

test('a missing working directory is a GitFailed, not a crash', async (t) => {
  const error = await runGit(Effect.flip(run(['status'], { cwd: join(tempDir(t), 'missing') })));
  assert.equal(error._tag, 'GitFailed');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/git.ts` cannot be found.

- [ ] **Step 4: Implement**

`packages/source-watch/src/git.ts`:
```ts
import { spawn } from 'node:child_process';
import { Context, Data, Effect, Layer } from 'effect';
import type { Commit } from './model.ts';
import { redact } from './redact.ts';

// A git command exited outside its accepted codes or could not start. `reason` is redacted.
export class GitFailed extends Data.TaggedError('GitFailed')<{ readonly reason: string }> {}

// `ok` lists the exit codes that count as success; [0] by default.
export type RunOptions = { readonly cwd?: string; readonly ok?: ReadonlyArray<number> };

// git as the watcher needs it: run one command and get its stdout.
export class Git extends Context.Service<
  Git,
  { readonly run: (args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<string, GitFailed> }
>()('source-watch/Git') {}

// Variables a parent git process (a hook, say) may export that would redirect our commands.
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

function environment(allowProtocols: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const name of INHERITED) delete env[name];
  if (allowProtocols !== undefined) env.GIT_ALLOW_PROTOCOL = allowProtocols;
  return env;
}

function failure(stderr: string, args: ReadonlyArray<string>, code: number | null): GitFailed {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l !== '' && !/^(warning|hint):/.test(l));
  return new GitFailed({ reason: redact(line ?? `git ${args[0] ?? ''} exited with code ${code}`) });
}

// Runs the git on PATH without a shell, never prompting. `allowProtocols` limits the transports
// git may use (GIT_ALLOW_PROTOCOL); the user's credential helpers are left in place.
export const nodeGit = (options: { readonly allowProtocols?: string } = {}) =>
  Layer.succeed(Git, {
    run: (args, { cwd, ok = [0] } = {}) =>
      Effect.callback<string, GitFailed>((resume) => {
        const child = spawn('git', [...args], {
          cwd,
          env: environment(options.allowProtocols),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const settle = (effect: Effect.Effect<string, GitFailed>) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', (e) => settle(Effect.fail(new GitFailed({ reason: redact(e.message) }))));
        child.on('close', (code) =>
          settle(
            code !== null && ok.includes(code)
              ? Effect.succeed(Buffer.concat(out).toString('utf8'))
              : Effect.fail(failure(Buffer.concat(err).toString('utf8'), args, code)),
          ),
        );
        return Effect.sync(() => void child.kill());
      }),
  });

// Log output parseLog reads: sha, subject, author name and strict ISO committer date. No email.
export const LOG_FORMAT = '--format=%H%x1f%s%x1f%an%x1f%cI%x1e';

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', subject = '', author = '', date = ''] = record.split('\x1f');
      return { sha, subject, author, date };
    });
}

// Plain unified diffs, whatever diff drivers or colour the user configured.
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv'] as const;
```

Append to `src/index.ts`:
```ts
export { DIFF_FLAGS, Git, GitFailed, LOG_FORMAT, nodeGit, parseLog } from './git.ts';
export type { RunOptions } from './git.ts';
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/source-watch
git commit -m "feat: injectable git service with offline test fixtures"
```

---

### Task 5: Upstream revisions, status and commits

**Files:**
- Create: `packages/source-watch/src/upstream.ts`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/upstream.spec.ts`

**Interfaces:**
- Consumes: `Git`, `GitFailed`, `LOG_FORMAT`, `parseLog`, `skillFolders`, `redact` and the model types.
- Produces: `cacheFolder(cacheDir: string, url: string): string` and `watchUpstream(source: WatchedSource, options: { readonly cacheDir: string }): Effect.Effect<SourceReport, never, Git>`. Task 6 replaces this task's `compareSkill` body and adds `added`.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/upstream.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WatchedSource } from '../src/model.ts';
import { watchUpstream } from '../src/upstream.ts';
import { gitSync, makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 adds tdd and grill; the next commit changes tdd; v2 touches only the README.
function history(root: string) {
  const repo = makeRepo(root);
  const c1 = repo.commit('add skills', { 'skills/tdd/SKILL.md': 'tdd v1\n', 'skills/grill/SKILL.md': 'grill v1\n' });
  repo.tag('v1');
  const c2 = repo.commit('tune tdd', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const c3 = repo.commit('readme', { 'README.md': 'hi\n' });
  repo.tag('v2');
  return { repo, c1, c2, c3 };
}

const watched = (url: string, extra: Partial<WatchedSource> = {}): WatchedSource => ({
  source: 'ada/skills', url, exact: false, skills: ['tdd', 'grill', 'ghost'], ...extra,
});
const watch = (root: string, source: WatchedSource) =>
  runGit(watchUpstream(source, { cacheDir: join(root, 'cache') }));

test('an unpinned source reports its latest revision and where the declared skills are', async (t) => {
  const root = tempDir(t);
  const { repo, c3 } = history(root);
  const report = await watch(root, watched(repo.url));
  assert.equal(report.status, 'unpinned');
  assert.equal(report.url, repo.url);
  assert.equal(report.latest?.sha, c3);
  assert.deepEqual(report.latest?.tags, ['v2']);
  assert.match(report.latest!.date, /^2026-01-01T/);
  assert.equal(report.baseline, undefined);
  assert.deepEqual(report.commits, []);
  assert.deepEqual(report.skills.map((s) => [s.name, s.status, s.path]), [
    ['tdd', 'unchanged', 'skills/tdd'],
    ['grill', 'unchanged', 'skills/grill'],
    ['ghost', 'missing', undefined],
  ]);
});

test('a baseline at latest is up to date', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: 'v2' }));
  assert.equal(report.status, 'up-to-date');
  assert.deepEqual(report.commits, []);
  assert.deepEqual(report.skills.map((s) => s.status), ['unchanged', 'unchanged', 'missing']);
});

test('a tag baseline behind latest is ahead, with the commits between them', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2, c3 } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: 'v1' }));
  assert.equal(report.status, 'ahead');
  assert.equal(report.baseline?.ref, 'v1');
  assert.equal(report.baseline?.sha, c1);
  assert.deepEqual(report.baseline?.tags, ['v1']);
  assert.deepEqual(report.commits.map((c) => [c.sha, c.subject, c.author]), [
    [c3, 'readme', 'Ada'],
    [c2, 'tune tdd', 'Ada'],
  ]);
  assert.deepEqual(report.skills.map((s) => s.status), ['changed', 'unchanged', 'missing']);
  assert.doesNotMatch(JSON.stringify(report), /example\.com/);
});

test('a sha baseline resolves like a tag', async (t) => {
  const root = tempDir(t);
  const { repo, c1 } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: c1 }));
  assert.equal(report.status, 'ahead');
  assert.equal(report.commits.length, 2);
});

test('a full sha on no branch is fetched by id', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  gitSync(repo.dir, 'checkout', '--quiet', '-b', 'side');
  const side = repo.commit('side work', { 'side.txt': 'x\n' });
  gitSync(repo.dir, 'update-ref', 'refs/pull/1/head', side);
  gitSync(repo.dir, 'checkout', '--quiet', 'main');
  gitSync(repo.dir, 'branch', '--quiet', '-D', 'side');
  const report = await watch(root, watched(repo.url, { baseline: side }));
  assert.equal(report.status, 'diverged');
  assert.equal(report.baseline?.sha, side);
});

test('an unknown baseline, or one shaped like an option, is baseline-missing', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  for (const baseline of ['nope', '--output=/tmp/x']) {
    const report = await watch(root, watched(repo.url, { baseline }));
    assert.equal(report.status, 'baseline-missing', baseline);
    assert.match(report.reason!, /baseline/);
    assert.deepEqual(report.skills, []);
  }
});

test('a rewritten history reads as diverged', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2 } = history(root);
  assert.equal((await watch(root, watched(repo.url, { baseline: c2 }))).status, 'ahead');
  gitSync(repo.dir, 'reset', '--quiet', '--hard', c1);
  const redo = repo.commit('redo', { 'skills/tdd/SKILL.md': 'tdd redo\n' });
  const report = await watch(root, watched(repo.url, { baseline: c2 }));
  assert.equal(report.status, 'diverged');
  assert.deepEqual(report.commits.map((c) => c.sha), [redo]);
});

test('a second run fetches into the existing cache', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  await watch(root, watched(repo.url));
  const next = repo.commit('next', { 'skills/grill/SKILL.md': 'grill v2\n' });
  const report = await watch(root, watched(repo.url, { baseline: 'v2' }));
  assert.equal(report.latest?.sha, next);
  assert.deepEqual(report.commits.map((c) => c.subject), ['next']);
});

test('an unreachable or empty upstream is reported, not thrown', async (t) => {
  const root = tempDir(t);
  const missing = await watch(root, watched(pathToFileURL(join(root, 'missing')).href, { baseline: 'v1' }));
  assert.equal(missing.status, 'unreachable');
  assert.match(missing.reason!, /does not appear to be a git repository/);
  assert.deepEqual([missing.commits, missing.skills, missing.added], [[], [], []]);

  const empty = makeRepo(root, 'empty');
  const report = await watch(root, watched(empty.url));
  assert.equal(report.status, 'unreachable');
  assert.ok(report.reason);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/upstream.ts` cannot be found.

- [ ] **Step 3: Implement**

`packages/source-watch/src/upstream.ts`:
```ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { Git, GitFailed, LOG_FORMAT, parseLog } from './git.ts';
import type { Revision, SkillChange, SourceReport, SourceStatus, WatchedSource } from './model.ts';
import { redact } from './redact.ts';

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// Where a source's bare partial clone lives: named by a hash, so no URL (or credential in one)
// reaches the filesystem.
export function cacheFolder(cacheDir: string, url: string): string {
  return join(cacheDir, createHash('sha256').update(url).digest('hex').slice(0, 16));
}

// One source's upstream: its latest revision, how that relates to the baseline, the commits
// between them and what changed in the setup's skills. Any git failure becomes an
// `unreachable` report, so one source never fails another.
export const watchUpstream = (
  source: WatchedSource,
  options: { readonly cacheDir: string },
): Effect.Effect<SourceReport, never, Git> =>
  inspect(source, options.cacheDir).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        source: source.source,
        url: redact(source.url),
        status: 'unreachable',
        reason: error.reason,
        commits: [],
        skills: [],
        added: [],
      } satisfies SourceReport),
    ),
  );

const inspect = (source: WatchedSource, cacheDir: string): Effect.Effect<SourceReport, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const dir = cacheFolder(cacheDir, source.url);
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: dir } : { cwd: dir, ok });

    if (existsSync(dir)) yield* run(['fetch', '--prune', '--tags', '--quiet', 'origin', '+refs/heads/*:refs/heads/*']);
    else yield* git.run(['clone', '--bare', '--filter=blob:none', '--quiet', '--', source.url, dir]);

    const latest = yield* revision(run, 'HEAD');
    const atLatest = yield* skillsAt(run, latest.sha);
    const report = { source: source.source, url: redact(source.url), latest, commits: [], added: [] };

    if (source.baseline === undefined) {
      const skills = source.skills.map((name): SkillChange => {
        const path = atLatest.get(name);
        return path === undefined
          ? { name, status: 'missing', commits: [], files: [] }
          : { name, path, status: 'unchanged', commits: [], files: [] };
      });
      return { ...report, status: 'unpinned', skills } satisfies SourceReport;
    }

    const sha = yield* findCommit(run, source.baseline);
    if (sha === undefined) {
      return {
        ...report,
        status: 'baseline-missing',
        reason: redact(`baseline '${source.baseline}' is not in ${source.url}`),
        skills: [],
      } satisfies SourceReport;
    }

    const mergeBase = (yield* run(['merge-base', sha, latest.sha], [0, 1])).trim();
    const status: SourceStatus = sha === latest.sha ? 'up-to-date' : mergeBase === sha ? 'ahead' : 'diverged';
    const commits = parseLog(yield* run(['log', LOG_FORMAT, `${sha}..${latest.sha}`]));
    const atBaseline = yield* skillsAt(run, sha);
    const skills = yield* Effect.forEach(source.skills, (name) =>
      compareSkill(run, name, sha, latest.sha, atBaseline.get(name), atLatest.get(name)),
    );
    const baseline = { ref: source.baseline, ...(yield* revision(run, sha)) };
    return { ...report, status, baseline, commits, skills } satisfies SourceReport;
  });

// A commit's sha, strict ISO committer date and the tags pointing at it.
const revision = (run: Run, rev: string): Effect.Effect<Revision, GitFailed> =>
  Effect.gen(function* () {
    const [sha = '', date = ''] = (yield* run(['log', '-1', '--format=%H%x1f%cI', rev])).trim().split('\x1f');
    const tags = (yield* run(['tag', '--points-at', sha])).split('\n').filter((tag) => tag !== '');
    return { sha, date, tags };
  });

// Resolves a baseline ref to a commit sha. A full sha the clone lacks (on no branch, say) is
// fetched by id once. A ref that git could read as an option is never passed to it.
const findCommit = (run: Run, ref: string): Effect.Effect<string | undefined, GitFailed> =>
  Effect.gen(function* () {
    if (ref.startsWith('-')) return undefined;
    const resolve = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ''),
    );
    let sha = yield* resolve;
    if (sha === '' && FULL_SHA.test(ref)) {
      yield* run(['fetch', '--quiet', 'origin', ref]).pipe(Effect.ignore);
      sha = yield* resolve;
    }
    return sha === '' ? undefined : sha;
  });

const skillsAt = (run: Run, sha: string) =>
  run(['ls-tree', '-r', '--name-only', '-z', sha]).pipe(
    Effect.map((out) => skillFolders(out.split('\0').filter((path) => path !== ''))),
  );

const treeSha = (run: Run, sha: string, path: string) =>
  run(['rev-parse', `${sha}:${path}`]).pipe(Effect.map((out) => out.trim()));

// One declared skill between two revisions, given its folder at each (undefined when absent).
const compareSkill = (
  run: Run,
  name: string,
  from: string,
  to: string,
  before: string | undefined,
  after: string | undefined,
): Effect.Effect<SkillChange, GitFailed> =>
  Effect.gen(function* () {
    const none = { name, commits: [], files: [] };
    if (after === undefined) {
      return before === undefined
        ? ({ ...none, status: 'missing' } satisfies SkillChange)
        : ({ ...none, path: before, status: 'removed' } satisfies SkillChange);
    }
    if (before !== undefined && (yield* treeSha(run, from, before)) === (yield* treeSha(run, to, after))) {
      return { ...none, path: after, status: 'unchanged' } satisfies SkillChange;
    }
    return { ...none, path: after, status: 'changed' } satisfies SkillChange;
  });
```

Append to `src/index.ts`:
```ts
export { cacheFolder, watchUpstream } from './upstream.ts';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0. If the compiler widens a `status` literal to `string`, add the `satisfies` annotation at that return. Do not loosen the model types.

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: watch a source's upstream against its baseline"
```

---

### Task 6: Skill changes, `SKILL.md` diffs and added skills

**Files:**
- Modify: `packages/source-watch/src/upstream.ts` (replace `compareSkill` and compute `added` in `inspect`)
- Test: `packages/source-watch/checks/skill-changes.spec.ts`

**Interfaces:**
- Consumes: `DIFF_FLAGS` from `git.ts`, plus everything Task 5 produced.
- Produces: `SkillChange` entries filled with `commits`, `files` and `skillMd`, and `SourceReport.added`.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/skill-changes.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SkillChange, WatchedSource } from '../src/model.ts';
import { watchUpstream } from '../src/upstream.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 has six skills. `tune` edits tdd (and a sibling file) and café; `reshape` removes old,
// moves mover, and adds fresh and wanted; a README commit follows.
function history(root: string) {
  const repo = makeRepo(root);
  repo.commit('add skills', {
    'skills/tdd/SKILL.md': 'tdd v1\n',
    'skills/tdd/notes.md': 'n1\n',
    'skills/grill/SKILL.md': 'grill v1\n',
    'skills/old/SKILL.md': 'old\n',
    'skills/mover/SKILL.md': 'move v1\n',
    'skills/café/SKILL.md': 'café v1\n',
  });
  repo.tag('v1');
  const tune = repo.commit('tune', {
    'skills/tdd/SKILL.md': 'tdd v2\n',
    'skills/tdd/notes.md': 'n2\n',
    'skills/café/SKILL.md': 'café v2\n',
  });
  const reshape = repo.commit('reshape', {
    'skills/old': null,
    'skills/mover': null,
    'eng/mover/SKILL.md': 'move v2\n',
    'skills/fresh/SKILL.md': 'fresh\n',
    'skills/wanted/SKILL.md': 'wanted\n',
  });
  repo.commit('readme', { 'README.md': 'hi\n' });
  return { repo, tune, reshape };
}

const watched = (url: string, exact: boolean): WatchedSource => ({
  source: 'ada/skills', url, baseline: 'v1', exact,
  skills: ['tdd', 'grill', 'old', 'mover', 'wanted', 'café', 'ghost'],
});

test('reports each declared skill with its commits, files and SKILL.md diff', async (t) => {
  const root = tempDir(t);
  const { repo, tune, reshape } = history(root);
  const report = await runGit(watchUpstream(watched(repo.url, false), { cacheDir: join(root, 'cache') }));
  const skill = Object.fromEntries(report.skills.map((s) => [s.name, s])) as Record<string, SkillChange>;
  const md = (name: string) => skill[name]!.skillMd ?? '';

  assert.deepEqual(report.skills.map((s) => s.name), ['tdd', 'grill', 'old', 'mover', 'wanted', 'café', 'ghost']);

  assert.deepEqual({ ...skill.tdd, skillMd: undefined }, {
    name: 'tdd', path: 'skills/tdd', status: 'changed', commits: [tune], files: ['skills/tdd/notes.md'], skillMd: undefined,
  });
  assert.match(md('tdd'), /^-tdd v1$/m);
  assert.match(md('tdd'), /^\+tdd v2$/m);

  assert.deepEqual(skill.grill, { name: 'grill', path: 'skills/grill', status: 'unchanged', commits: [], files: [] });
  assert.deepEqual(skill.old, { name: 'old', path: 'skills/old', status: 'removed', commits: [], files: [] });
  assert.deepEqual(skill.ghost, { name: 'ghost', status: 'missing', commits: [], files: [] });

  assert.equal(skill.mover!.status, 'changed');
  assert.equal(skill.mover!.path, 'eng/mover');
  assert.deepEqual(skill.mover!.commits, [reshape]);
  assert.deepEqual(skill.mover!.files, []);
  assert.match(md('mover'), /a\/skills\/mover\/SKILL\.md/);
  assert.match(md('mover'), /b\/eng\/mover\/SKILL\.md/);
  assert.match(md('mover'), /^\+move v2$/m);

  assert.equal(skill.wanted!.status, 'changed');
  assert.deepEqual(skill.wanted!.commits, [reshape]);
  assert.match(md('wanted'), /new file mode/);
  assert.match(md('wanted'), /^\+wanted$/m);

  assert.equal(skill['café']!.path, 'skills/café');
  assert.deepEqual(skill['café']!.commits, [tune]);
  assert.match(md('café'), /^\+café v2$/m);

  assert.deepEqual(report.added, ['fresh']);
});

test('an exact source does not report skills added upstream', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  const report = await runGit(watchUpstream(watched(repo.url, true), { cacheDir: join(root, 'cache') }));
  assert.deepEqual(report.added, []);
  assert.equal(report.skills.find((s) => s.name === 'tdd')!.status, 'changed');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL. The `tdd` deepEqual fails on `commits`/`files` (`[]`), and `added` is `[]` instead of `['fresh']`.

- [ ] **Step 3: Implement**

In `src/upstream.ts`, change the git import to also import `DIFF_FLAGS`:
```ts
import { DIFF_FLAGS, Git, GitFailed, LOG_FORMAT, parseLog } from './git.ts';
```

At the end of `inspect`, replace the final two lines (`const baseline = …` and `return …`) with:
```ts
    const declared = new Set(source.skills);
    const added = source.exact
      ? []
      : [...atLatest.keys()].filter((name) => !atBaseline.has(name) && !declared.has(name)).sort();
    const baseline = { ref: source.baseline, ...(yield* revision(run, sha)) };
    return { ...report, status, baseline, commits, skills, added } satisfies SourceReport;
```

Replace the whole `compareSkill` with:
```ts
// One declared skill between two revisions, given its folder at each (undefined when absent).
// A skill only at `to` is changed, and its SKILL.md diffs against nothing; a moved folder
// diffs its old SKILL.md against its new one.
const compareSkill = (
  run: Run,
  name: string,
  from: string,
  to: string,
  before: string | undefined,
  after: string | undefined,
): Effect.Effect<SkillChange, GitFailed> =>
  Effect.gen(function* () {
    const none = { name, commits: [], files: [] };
    if (after === undefined) {
      return before === undefined
        ? ({ ...none, status: 'missing' } satisfies SkillChange)
        : ({ ...none, path: before, status: 'removed' } satisfies SkillChange);
    }
    if (before !== undefined && (yield* treeSha(run, from, before)) === (yield* treeSha(run, to, after))) {
      return { ...none, path: after, status: 'unchanged' } satisfies SkillChange;
    }

    const folders = before === undefined || before === after ? [after] : [before, after];
    const skillFiles = new Set(folders.map((folder) => `${folder}/SKILL.md`));
    const commits = (yield* run(['log', '--format=%H', `${from}..${to}`, '--', ...folders]))
      .split('\n')
      .filter((sha) => sha !== '');
    const files = (yield* run(['diff', '--name-only', '-z', from, to, '--', ...folders]))
      .split('\0')
      .filter((path) => path !== '' && !skillFiles.has(path));
    const skillMd =
      before === undefined
        ? yield* run(['diff', ...DIFF_FLAGS, from, to, '--', `${after}/SKILL.md`])
        : yield* run(['diff', ...DIFF_FLAGS, `${from}:${before}/SKILL.md`, `${to}:${after}/SKILL.md`]);
    return {
      name,
      path: after,
      status: 'changed',
      commits,
      files,
      ...(skillMd === '' ? {} : { skillMd }),
    } satisfies SkillChange;
  });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, including Task 5's, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: report changed skills with SKILL.md diffs and new upstream skills"
```

---

### Task 7: Local checkout edits

**Files:**
- Create: `packages/source-watch/src/local.ts`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/local.spec.ts`

**Interfaces:**
- Consumes: `Git`, `GitFailed`, `LOG_FORMAT`, `parseLog`, `DIFF_FLAGS`, `skillFolders`, `LocalReport` and `LocalSkill`.
- Produces: `watchCheckout(path: string): Effect.Effect<LocalReport, never, Git>` and `parseStatus(out: string): Array<{ path: string; untracked: boolean }>`.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/local.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatus, watchCheckout } from '../src/local.ts';
import { commitFiles, gitSync, makeRepo, runGit, tempDir, writeFiles } from './fixtures.ts';

function setup(root: string) {
  const upstream = makeRepo(root);
  upstream.commit('add skills', { 'skills/tdd/SKILL.md': 'tdd v1\n', 'skills/grill/SKILL.md': 'grill v1\n' });
  const local = join(root, 'local');
  gitSync(root, 'clone', '--quiet', upstream.url, local);
  return { upstream, local };
}

test('reports unpushed commits and every kind of uncommitted edit, by skill', async (t) => {
  const root = tempDir(t);
  const { upstream, local } = setup(root);
  commitFiles(local, 'tune tdd locally', { 'skills/tdd/SKILL.md': 'tdd local\n' });
  // Upstream moves on and the checkout fetches it; that must not read as a local edit.
  upstream.commit('upstream adds other', { 'skills/other/SKILL.md': 'other\n' });
  gitSync(local, 'fetch', '--quiet');
  writeFiles(local, {
    'skills/grill/SKILL.md': 'grill local\n',
    'skills/grill/extra.md': 'extra\n',
    'skills/brand-new/SKILL.md': 'brand new\n',
  });
  gitSync(local, 'add', 'skills/grill/extra.md');

  const report = await runGit(watchCheckout(local));
  assert.equal(report.path, local);
  assert.equal(report.status, 'edits');
  assert.equal(report.branch, 'main');
  assert.deepEqual(report.unpushed.map((c) => c.subject), ['tune tdd locally']);
  assert.deepEqual(report.uncommitted, ['skills/brand-new/SKILL.md', 'skills/grill/SKILL.md', 'skills/grill/extra.md']);
  assert.deepEqual(report.skills.map((s) => [s.name, s.path]), [
    ['brand-new', 'skills/brand-new'],
    ['grill', 'skills/grill'],
    ['tdd', 'skills/tdd'],
  ]);
  const md = Object.fromEntries(report.skills.map((s) => [s.name, s.skillMd ?? '']));
  assert.match(md['brand-new']!, /^\+brand new$/m);
  assert.match(md.grill!, /^-grill v1$/m);
  assert.match(md.grill!, /^\+grill local$/m);
  assert.match(md.tdd!, /^\+tdd local$/m);
});

test('a checkout with nothing to push is clean', async (t) => {
  const { local } = setup(tempDir(t));
  assert.deepEqual(await runGit(watchCheckout(local)), {
    path: local, status: 'clean', branch: 'main', unpushed: [], uncommitted: [], skills: [],
  });
});

test('a subfolder of the work tree reports the whole repository', async (t) => {
  const { local } = setup(tempDir(t));
  writeFiles(local, { 'skills/grill/SKILL.md': 'grill local\n' });
  const report = await runGit(watchCheckout(join(local, 'skills')));
  assert.equal(report.status, 'edits');
  assert.deepEqual(report.skills.map((s) => s.name), ['grill']);
  assert.deepEqual(report.uncommitted, ['skills/grill/SKILL.md']);
});

test('a checkout with no upstream measures edits from HEAD', async (t) => {
  const solo = makeRepo(tempDir(t), 'solo');
  solo.commit('add', { 'skills/grill/SKILL.md': 'grill v1\n' });
  writeFiles(solo.dir, { 'skills/grill/SKILL.md': 'grill local\n' });
  const report = await runGit(watchCheckout(solo.dir));
  assert.equal(report.status, 'no-upstream');
  assert.deepEqual(report.unpushed, []);
  assert.match(report.skills[0]!.skillMd!, /^\+grill local$/m);
});

test('a folder that is not a work tree, or is missing, is not-a-repo', async (t) => {
  const root = tempDir(t);
  const plain = join(root, 'plain');
  mkdirSync(plain);
  for (const path of [plain, join(root, 'missing')]) {
    assert.deepEqual(await runGit(watchCheckout(path)), {
      path, status: 'not-a-repo', unpushed: [], uncommitted: [], skills: [],
    });
  }
});

test('parseStatus reads -z porcelain, skipping a rename\'s original path', () => {
  assert.deepEqual(parseStatus(' M a.txt\0R  new.txt\0old.txt\0?? n/SKILL.md\0'), [
    { path: 'a.txt', untracked: false },
    { path: 'new.txt', untracked: false },
    { path: 'n/SKILL.md', untracked: true },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/local.ts` cannot be found.

- [ ] **Step 3: Implement**

`packages/source-watch/src/local.ts`:
```ts
import { Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { DIFF_FLAGS, Git, GitFailed, LOG_FORMAT, parseLog } from './git.ts';
import type { LocalReport, LocalSkill } from './model.ts';

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

// Paths from `git status --porcelain=v1 -z`. A rename or copy entry is followed by its original
// path, which is skipped.
export function parseStatus(out: string): Array<{ path: string; untracked: boolean }> {
  const tokens = out.split('\0');
  const entries: Array<{ path: string; untracked: boolean }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const xy = token.slice(0, 2);
    entries.push({ path: token.slice(3), untracked: xy === '??' });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return entries;
}

// Edits in the author's checkout not yet pushed: commits ahead of its upstream and uncommitted
// paths, with each touched skill's SKILL.md diff. Read-only: it never fetches. Edits are
// measured from the merge base with the upstream, or from HEAD when there is none. A path that
// is not a git work tree, or any git failure, reads as `not-a-repo`.
export const watchCheckout = (path: string): Effect.Effect<LocalReport, never, Git> =>
  inspect(path).pipe(
    Effect.catch(() =>
      Effect.succeed({ path, status: 'not-a-repo', unpushed: [], uncommitted: [], skills: [] } satisfies LocalReport),
    ),
  );

const inspect = (path: string): Effect.Effect<LocalReport, GitFailed, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const top = (yield* git.run(['rev-parse', '--show-toplevel'], { cwd: path })).trim();
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: top } : { cwd: top, ok });

    const branch = yield* run(['rev-parse', '--abbrev-ref', 'HEAD']).pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => ''),
    );
    const entries = parseStatus(yield* run(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    const hasUpstream = yield* run(['rev-parse', '--verify', '--quiet', '@{u}']).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const since = hasUpstream ? (yield* run(['merge-base', 'HEAD', '@{u}'])).trim() : 'HEAD';
    const unpushed = hasUpstream ? parseLog(yield* run(['log', LOG_FORMAT, '@{u}..HEAD'])) : [];

    const tracked = (yield* run(['diff', '--name-only', '-z', since]).pipe(Effect.orElseSucceed(() => '')))
      .split('\0')
      .filter((p) => p !== '');
    const changed = [...tracked, ...entries.map((e) => e.path)];
    const untracked = new Set(entries.filter((e) => e.untracked).map((e) => e.path));
    const folders = skillFolders(
      (yield* run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter((p) => p !== ''),
    );

    const skills: LocalSkill[] = [];
    for (const [name, folder] of [...folders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!changed.some((p) => p.startsWith(`${folder}/`))) continue;
      const file = `${folder}/SKILL.md`;
      const skillMd = untracked.has(file)
        ? yield* run(['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], [0, 1])
        : yield* run(['diff', ...DIFF_FLAGS, since, '--', file]);
      skills.push(skillMd === '' ? { name, path: folder } : { name, path: folder, skillMd });
    }

    const uncommitted = entries.map((e) => e.path).sort();
    const status = !hasUpstream ? 'no-upstream' : unpushed.length > 0 || uncommitted.length > 0 ? 'edits' : 'clean';
    return {
      path,
      status,
      ...(branch === '' ? {} : { branch }),
      unpushed,
      uncommitted,
      skills,
    } satisfies LocalReport;
  });
```

Append to `src/index.ts`:
```ts
export { parseStatus, watchCheckout } from './local.ts';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: report unpushed edits in local skill checkouts"
```

---

### Task 8: `watchSources`, end-to-end checks and README

**Files:**
- Create: `packages/source-watch/src/watch.ts`
- Create: `packages/source-watch/README.md`
- Modify: `packages/source-watch/src/index.ts`
- Test: `packages/source-watch/checks/watch.spec.ts`

**Interfaces:**
- Consumes: `watchUpstream`, `watchCheckout`, `sourcesFrom` and `WatchedSource`.
- Produces: `watchSource(source: WatchedSource, options: { readonly cacheDir: string }): Effect.Effect<SourceReport, never, Git>` and `watchSources(sources: ReadonlyArray<WatchedSource>, options: { readonly cacheDir: string }): Effect.Effect<SourceReport[], never, Git>`.

- [ ] **Step 1: Write the failing test**

`packages/source-watch/checks/watch.spec.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { WatchedSource } from '../src/model.ts';
import { sourcesFrom } from '../src/sources.ts';
import { watchSources } from '../src/watch.ts';
import { gitSync, makeRepo, runGit, tempDir, writeFiles } from './fixtures.ts';

test('watches every source in input order, confining failures and attaching checkouts', async (t) => {
  const root = tempDir(t);
  const upstream = makeRepo(root);
  upstream.commit('add', { 'skills/tdd/SKILL.md': 'tdd v1\n' });
  upstream.tag('v1');
  upstream.commit('tune', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const local = join(root, 'local');
  gitSync(root, 'clone', '--quiet', upstream.url, local);
  writeFiles(local, { 'skills/tdd/SKILL.md': 'tdd local\n' });

  const sources: WatchedSource[] = [
    { source: 'ada/private', url: 'https://ada:s3cret@example.invalid/private.git', exact: false, skills: ['x'] },
    { source: 'ada/skills', url: upstream.url, baseline: 'v1', exact: false, skills: ['tdd'], checkout: local },
  ];
  const reports = await runGit(watchSources(sources, { cacheDir: join(root, 'cache') }));

  assert.deepEqual(reports.map((r) => [r.source, r.status]), [
    ['ada/private', 'unreachable'],
    ['ada/skills', 'ahead'],
  ]);
  assert.equal(reports[0]!.url, 'https://example.invalid/private.git');
  assert.match(reports[0]!.reason!, /transport 'https' not allowed/);
  assert.equal(reports[0]!.local, undefined);
  assert.equal(reports[1]!.skills[0]!.status, 'changed');
  assert.equal(reports[1]!.local?.status, 'edits');
  assert.deepEqual(reports[1]!.local?.skills.map((s) => s.name), ['tdd']);

  const json = JSON.stringify(reports);
  assert.doesNotMatch(json, /s3cret/);
  assert.doesNotMatch(json, /ada@example\.com/);
});

test('sources derived from a setup default to GitHub, which tests refuse rather than fetch', async (t) => {
  const root = tempDir(t);
  const from = { layer: 'base', source: 'skills-manifest.txt' } as const;
  const sources = sourcesFrom({
    skills: [{ name: 'tdd', source: 'mattpocock/skills', exact: false, optional: false, install: true, from }],
  });
  const [report] = await runGit(watchSources(sources, { cacheDir: join(root, 'cache') }));
  assert.equal(report!.url, 'https://github.com/mattpocock/skills.git');
  assert.equal(report!.status, 'unreachable');
  assert.match(report!.reason!, /transport 'https' not allowed/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`
Expected: FAIL, because `../src/watch.ts` cannot be found.

- [ ] **Step 3: Implement**

`packages/source-watch/src/watch.ts`:
```ts
import { Effect } from 'effect';
import type { Git } from './git.ts';
import { watchCheckout } from './local.ts';
import type { SourceReport, WatchedSource } from './model.ts';
import { watchUpstream } from './upstream.ts';

export type WatchOptions = { readonly cacheDir: string }; // holds one bare clone per source URL

// One source's upstream report, with its local checkout's edits when it has one.
export const watchSource = (source: WatchedSource, options: WatchOptions): Effect.Effect<SourceReport, never, Git> =>
  Effect.gen(function* () {
    const report = yield* watchUpstream(source, options);
    if (source.checkout === undefined) return report;
    return { ...report, local: yield* watchCheckout(source.checkout) };
  });

// Every source's report, in input order, watching up to four at once. Never fails: a source
// that cannot be read says so in its own report.
export const watchSources = (
  sources: ReadonlyArray<WatchedSource>,
  options: WatchOptions,
): Effect.Effect<SourceReport[], never, Git> =>
  Effect.forEach(sources, (source) => watchSource(source, options), { concurrency: 4 });
```

Append to `src/index.ts`:
```ts
export { watchSource, watchSources } from './watch.ts';
export type { WatchOptions } from './watch.ts';
```

`packages/source-watch/README.md`:
````markdown
# Sources watcher

Watches the skill sources a setup uses. For each source it reports the latest upstream revision,
whether it is ahead of the source's baseline (its pin), the commits between them, the setup's
skills that changed with their `SKILL.md` diffs, and, for the author's own checkouts, edits not
yet pushed. It is the data layer behind the desktop app's Sources screen (#52). Nothing uses it
yet. Design: `docs/superpowers/specs/2026-10-05-source-watch-design.md`.

```ts
import { Effect } from 'effect';
import { nodeGit, sourcesFrom, watchSources } from '@nortuscc/source-watch';

const sources = sourcesFrom(desiredConfig, { checkouts: { 'Nortus222/agent-skills': '/work/agent-skills' } });
const reports = await Effect.runPromise(
  watchSources(sources, { cacheDir: '/path/to/cache' }).pipe(Effect.provide(nodeGit())),
);
```

Each source keeps a bare partial clone in `cacheDir`, refreshed on every run. If an upstream
renames its default branch, delete that source's cache folder. Local checkouts are only read,
never fetched.

Sources are TypeScript run directly by Node 22.18+, so there is no build step. Tests build git
fixtures in a temporary directory and allow only `file://` transport, so they never reach the
network. Type-checking follows the profile engine's imports, so install both packages first.

```sh
npm ci && (cd ../profile-engine && npm ci)
npm test
npm run typecheck
```
````

- [ ] **Step 4: Run the package's tests and typecheck, then the root suite**

Run: `npm test && npm run typecheck`
Expected: all tests pass, and typecheck exits 0.

Run from the repository root: `NORTUSCC_REPO_DIR="$PWD" npm test`
Expected: the root suite passes with the same count as on `main`. This package's `checks/*.spec.ts` files are not discovered by the root runner.

- [ ] **Step 5: Commit**

```bash
git add packages/source-watch
git commit -m "feat: watch every source of a setup, with local edits"
```
