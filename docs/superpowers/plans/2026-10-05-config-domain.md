# Config domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port copied files, settings keys, project trust and file states into a `config` `Domain` on `@nortuscc/machine`, retire the CLI's duplicate `SYNC` table, and cut `nortuscc uninstall` over to TypeScript (issue #55, sub-issue 2/6 of #42).

**Architecture:** `packages/machine/src/config/` holds the domain. `observe.ts` reads one managed file's current condition, which both `inspect` and a step's `run` use. A run re-reads its file and refuses if the state moved since the report. `steps.ts` is the pure planner. `sync.ts` runs apply and capture steps, and `restore.ts` runs uninstall steps. `src/commands/uninstall.ts` wires inspect, plan and execute for the CLI. The managed-file table becomes `packages/profile-engine/src/files.json`, read by the engine and by the legacy `src/manifest.mjs`, so there is one table and it still loads from an `npx` copy.

**Tech Stack:** Node 24+ type stripping, TypeScript (erasable syntax, `.ts` imports), `effect` 4.0.1, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (sections *Decisions settled here* §3, *`@nortuscc/machine`*, *Domains*, *CLI*, *Migration*). Issue #55 and its comment (Backups absence; keep `state.json` in step with `overrides.json`).

## Global Constraints

- Node 24+; no build step. New code is erasable-syntax TypeScript with `.ts` import extensions; legacy `.mjs` is only edited, never added.
- `effect` (pinned 4.0.1) is the only runtime dependency. Use `node:`-prefixed builtins.
- Machine access goes through `@nortuscc/machine` services (`MachinePaths`, `Fs`, `StateStore`, `OverridesStore`, `Backups`). Nothing below `pathsFromEnvironment` reads `process.env` or the home directory.
- Tests: `node:test` with `node:assert/strict`. Package tests are `packages/<name>/checks/*.spec.ts`; CLI tests are `test/*.test.{mjs,ts}`. Commit after every task with a conventional prefix (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Nothing destructive runs without a backup in `<stateRoot>/backups/nortuscc-<stamp>/<agent>/<relative>` (today's layout).
- Preserved for `uninstall`: flags, messages, exit codes (0 clean, 1 dirty or refused, 2 usage), `state.json` format and backup layout, and every text row a test asserts.
- File steps are `interruptible: false`. A domain's `steps` must be deterministic: no timestamps or random ids in a summary or reason.
- The `Domain` contract is fixed. This plan makes one additive change (`Observed.facts?`) and calls it out in the PR.
- The root `npm test` can rewrite `skills-manifest.txt`. Run `git status` after each root-suite run, restore that file with `git checkout -- skills-manifest.txt`, and never commit it. Known pre-existing failures: `apps/desktop/checks/backend.spec.ts` teardown abort on Node 24.19, and the intermittent `test/fresh-machine.test.mjs`.

## Review Focus

1. **A settings file that is a symlink** (dotfiles setups link `~/.claude/settings.json`). Merging keys must keep the link and update its target. Pinned in Task 6.
2. **A file edited between inspect and execute.** The step must fail with a note and leave the file as the user left it. Pinned in Task 6.
3. **Fresh-machine apply, then uninstall, with a multi-key settings document.** The second key's backup call must not save the file the run itself just wrote. Otherwise uninstall later treats it as the original and restores it instead of removing it. Pinned in Tasks 1, 6 and 7.
4. **A malformed `overrides.json` at uninstall.** It must be left byte-for-byte as found, `state.json` still records skills-only, and uninstall exits 1 with a message. Pinned in Task 8.
5. **Machine state that cannot be read** (`state.json` unreadable). Uninstall must change nothing and exit 1. Inspect reports a probe error instead of guessing that every file is unmanaged. Pinned in Tasks 4 and 8.

---

### Task 1: Backups record absence at the first call

The issue #55 comment: a path absent at its first backup call in a run must stay "nothing to back up" for the rest of that run. Otherwise a later call saves content the run itself wrote.

**Files:**
- Modify: `packages/machine/src/backups.ts`
- Modify: `packages/machine/README.md` (the "first backup of a path wins" sentence)
- Test: `packages/machine/checks/backups.spec.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: same `Backups` service shape. New rule: the first call for a destination in a run decides. A repeat returns that first answer (the backup path, or `undefined` if the path was absent then). `moveAside` still removes the live path on a repeat.

- [ ] **Step 1: Write the failing test** (append to `packages/machine/checks/backups.spec.ts`)

```ts
test('a path absent at its first call is never backed up later in the run', async () => {
  const { home, paths, run } = setup();
  const live = join(home, 'CLAUDE.md');
  const results = await run((b) => Effect.gen(function* () {
    const first = yield* b.moveAside(live, 'CLAUDE.md', 'claude');
    writeFileSync(live, 'written by this run');
    const moved = yield* b.moveAside(live, 'CLAUDE.md', 'claude');
    writeFileSync(live, 'written again');
    const kept = yield* b.preserve(live, 'CLAUDE.md', 'claude');
    return [first, moved, kept, yield* b.dir];
  }));
  assert.deepEqual(results, [undefined, undefined, undefined, undefined]);
  assert.equal(readFileSync(live, 'utf8'), 'written again');
  assert.equal(existsSync(paths.backups), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/machine/checks/backups.spec.ts`
Expected: FAIL. `moved` is a backup path under `nortuscc-2026-10-05T12-34-56-789Z/claude/CLAUDE.md`.

- [ ] **Step 3: Implement.** Replace the `Backups` comment and the body of `backupsForRun` in `packages/machine/src/backups.ts`:

```ts
// moveAside/preserve return the backup path, or undefined when nothing was there. Within a run the
// first call for a destination decides: a repeat returns that first answer untouched (the pre-run
// copy, or undefined when the path was absent then), and moveAside still vacates the live path.
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
      // Each destination's first answer this run: its backup, or undefined when the path was absent.
      // Remembering absence keeps a later call from saving content this run wrote.
      const first = yield* Ref.make<ReadonlyMap<string, string | undefined>>(new Map());
      const target = (relative: string, agent?: string) => join(folder, ...(agent ? [agent] : []), relative);
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string) =>
        Effect.gen(function* () {
          const to = target(relative, agent);
          const seen = yield* Ref.get(first);
          if (seen.has(to)) {
            if (op === 'move') yield* fs.remove(path);
            return seen.get(to);
          }
          const present = yield* fs.exists(path);
          if (present) yield* (op === 'move' ? fs.move(path, to) : fs.copy(path, to));
          const answer = present ? to : undefined;
          yield* Ref.update(first, (map) => new Map(map).set(to, answer));
          return answer;
        });
      return {
        dir: Effect.map(Ref.get(first), (map) => ([...map.values()].some((v) => v !== undefined) ? folder : undefined)),
        moveAside: keep('move'),
        preserve: keep('copy'),
      };
    }),
  );
```

In `packages/machine/README.md`, change "within a run the first backup of a path wins." to "within a run the first backup call for a path decides, including that the path was absent."

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/machine`
Expected: PASS (all existing backups/run checks plus the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/machine/src/backups.ts packages/machine/checks/backups.spec.ts packages/machine/README.md
git commit -m "fix: remember a path absent at its first backup call for the rest of the run"
```

---

### Task 2: One managed-file table

The spec retires `SYNC` and makes the engine's table the only one. Legacy `apply`/`status`/`capture` stay unported until #59 and must still run from an `npx` copy, where TypeScript cannot load. So the table becomes JSON, which both sides import.

**Files:**
- Create: `packages/profile-engine/src/files.json`
- Modify: `packages/profile-engine/src/files.ts`
- Modify: `packages/profile-engine/tsconfig.json`, `packages/machine/tsconfig.json`, `tsconfig.json` (add `"resolveJsonModule": true`)
- Modify: `src/manifest.mjs` (the table literal becomes an adapter over the JSON)
- Modify: `package.json` (`files` gains `packages/profile-engine/src/files.json`)
- Modify: `packages/profile-engine/checks/golden.spec.ts` (delete the test pinning `SYNC` to `FILES`)
- Test: `packages/profile-engine/checks/files.spec.ts` (create), `test/package-bootstrap.test.mjs`

**Interfaces:**
- Produces: `FILES: ReadonlyArray<FileEntry>` (unchanged export), now read from `files.json`. `SYNC` in `src/manifest.mjs` keeps its exact legacy shape, derived from the JSON.

- [ ] **Step 1: Write the failing tests**

Create `packages/profile-engine/checks/files.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES, TARGETS } from '../src/index.ts';

// files.json is untyped data, so its shape is checked here instead of by the compiler.
test('every managed file is a well-formed entry keyed by its state-file id', () => {
  const ids = new Set<string>();
  for (const file of FILES) {
    assert.equal(file.id, `${file.target}:${file.dest}`);
    assert.ok((TARGETS as readonly string[]).includes(file.target), file.id);
    assert.ok(['claude', 'codex', 'codex-openrouter'].includes(file.home), file.id);
    assert.ok(file.mode === 'copy' || file.mode === 'merge-keys', file.id);
    assert.equal(typeof file.src, 'string');
    assert.equal(typeof file.preserveProjects, 'boolean');
    assert.equal(typeof file.capture, 'boolean');
    assert.ok(!ids.has(file.id), `duplicate ${file.id}`);
    ids.add(file.id);
  }
  assert.equal(FILES.length, 5);
});
```

In `test/package-bootstrap.test.mjs`, next to the existing `integrations.json` assertion (line 26), add:

```js
  assert.ok(packed.files.some((entry) => entry.path === 'packages/profile-engine/src/files.json'));
```

- [ ] **Step 2: Run tests to verify the packaging one fails**

Run: `node --test test/package-bootstrap.test.mjs && npm test -w packages/profile-engine`
Expected: package-bootstrap FAILS on the new assertion. `files.spec.ts` passes against the current TS table, which is fine: it guards the move.

- [ ] **Step 3: Implement**

Create `packages/profile-engine/src/files.json`, the exact current table:

```json
[
  { "id": "claude:CLAUDE.md", "target": "claude", "home": "claude", "src": "claude/CLAUDE.md", "dest": "CLAUDE.md", "mode": "copy", "preserveProjects": false, "capture": true },
  { "id": "codex:AGENTS.md", "target": "codex", "home": "codex", "src": "codex/AGENTS.md", "dest": "AGENTS.md", "mode": "copy", "preserveProjects": false, "capture": true },
  { "id": "codex:models-static.json", "target": "codex", "home": "codex-openrouter", "src": "codex/openrouter-glm/models-static.json", "dest": "models-static.json", "mode": "copy", "preserveProjects": false, "capture": false },
  { "id": "codex:config.toml", "target": "codex", "home": "codex-openrouter", "src": "codex/openrouter-glm/config.toml", "dest": "config.toml", "mode": "copy", "preserveProjects": true, "capture": false },
  { "id": "claude:settings.json", "target": "claude", "home": "claude", "src": "claude/settings.keys.json", "dest": "settings.json", "mode": "merge-keys", "preserveProjects": false, "capture": true }
]
```

Replace `packages/profile-engine/src/files.ts` with:

```ts
import type { FileEntry } from './model.ts';
import table from './files.json' with { type: 'json' };

export const FILES_SOURCE = 'built-in';

// The base profile's managed files: the only table of them. It is JSON so the legacy CLI
// (src/manifest.mjs) reads the same table from an npx copy, where TypeScript cannot load. `id` is
// the state-file key (`<target>:<dest>`); checks/files.spec.ts checks the shape.
export const FILES = table as ReadonlyArray<FileEntry>;
```

Add `"resolveJsonModule": true,` to `compilerOptions` in `packages/profile-engine/tsconfig.json`, `packages/machine/tsconfig.json` and the root `tsconfig.json`. The machine and root configs type-check engine sources through imports.

Replace the `export const SYNC = [ ... ];` literal at the bottom of `src/manifest.mjs`. Keep the explanatory comment above it, but change its first line from "The single source of truth for what syncs and how." to "What syncs and how, in the shape the legacy commands read. The table itself is the engine's packages/profile-engine/src/files.json; this only renames its fields." Then:

```js
import FILES from '../packages/profile-engine/src/files.json' with { type: 'json' };

export const SYNC = FILES.map((file) => ({
  target: file.target,
  ...(file.home !== file.target ? { machine: file.home } : {}),
  src: file.src,
  dest: file.dest,
  mode: file.mode,
  ...(file.preserveProjects ? { preserveProjects: true } : {}),
  ...(file.capture ? {} : { capture: false }),
}));
```

(The `import` goes at the top of the file, above the comment block.)

In root `package.json` `files`, add `"packages/profile-engine/src/files.json"` after `"src/"`.

In `packages/profile-engine/checks/golden.spec.ts`, delete the test `'the built-in file table equals the CLI SYNC table'`. Keep `toSyncEntry` and the `SYNC` import, because the legacy-state-record test still uses both to pin config-mode parity.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/profile-engine && node --test test/package-bootstrap.test.mjs test/manifest.test.mjs test/apply.test.mjs test/status.test.mjs test/openrouter-config.test.mjs && npm run typecheck`
Expected: PASS. Then run `git status` and restore `skills-manifest.txt` if it changed.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/files.json packages/profile-engine/src/files.ts packages/profile-engine/checks/files.spec.ts packages/profile-engine/checks/golden.spec.ts packages/profile-engine/tsconfig.json packages/machine/tsconfig.json tsconfig.json src/manifest.mjs package.json test/package-bootstrap.test.mjs
git commit -m "refactor: make the engine's files.json the only managed-file table and retire SYNC's copy"
```

---

### Task 3: Pure file states, settings hashing and project trust

Ports `src/state.mjs`'s `fileState`, `src/settings-keys.mjs`'s `canonical`/`hashValue` and `src/project-trust.mjs`'s `splitProjectTrust`.

**Files:**
- Create: `packages/machine/src/config/file-state.ts`
- Create: `packages/machine/src/config/project-trust.ts`
- Test: `packages/machine/checks/config-file-state.spec.ts`

**Interfaces:**
- Produces:
  - `type FileState = 'clean' | 'repo-ahead' | 'local-ahead' | 'conflict' | 'unmanaged' | 'missing-repo'`
  - `fileState(input: { baseline?: string; repo?: string; local?: string }): FileState` (hash strings; `undefined` = absent)
  - `canonical(value: unknown): string`
  - `hashValue(value: unknown): string | undefined`
  - `splitProjectTrust(text: string): { managed: string; projects: string }`

- [ ] **Step 1: Write the failing test** `packages/machine/checks/config-file-state.spec.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, fileState, hashValue } from '../src/config/file-state.ts';
import { splitProjectTrust } from '../src/config/project-trust.ts';
import { hashText } from '../src/hash.ts';

const A = 'sha256:a';
const B = 'sha256:b';
const C = 'sha256:c';

test('each side moving alone is that side being ahead; both apart is a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: A }), 'clean');
  assert.equal(fileState({ baseline: A, repo: B, local: A }), 'repo-ahead');
  assert.equal(fileState({ baseline: A, repo: A, local: B }), 'local-ahead');
  assert.equal(fileState({ baseline: A, repo: B, local: C }), 'conflict');
});

test('both sides moving to the same content is clean, not a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: B }), 'clean');
});

test('no baseline is unmanaged; no repo side is missing-repo regardless of the rest', () => {
  assert.equal(fileState({ repo: A, local: B }), 'unmanaged');
  assert.equal(fileState({ repo: A }), 'unmanaged');
  assert.equal(fileState({ baseline: A, local: A }), 'missing-repo');
  assert.equal(fileState({}), 'missing-repo');
});

test('a local file deleted since its baseline is repo-ahead, even when the repo moved too', () => {
  assert.equal(fileState({ baseline: A, repo: A }), 'repo-ahead');
  assert.equal(fileState({ baseline: A, repo: B }), 'repo-ahead');
});

test('canonical ignores key order and keeps array order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: null } }), canonical({ a: { c: null, d: [2, 1] }, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical('x'), '"x"');
  assert.equal(canonical(true), 'true');
});

test('an absent value hashes to undefined, which fileState reads as absent', () => {
  assert.equal(hashValue(undefined), undefined);
  assert.equal(hashValue({ b: 1, a: 2 }), hashText('{"a":2,"b":1}'));
});

test('project tables are split out, and a table after them rejoins the managed part', () => {
  const text = 'model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[other]\nk = 1\n';
  assert.deepEqual(splitProjectTrust(text), {
    managed: 'model = "x"\n\n[other]\nk = 1\n',
    projects: '[projects."/a"]\ntrust_level = "trusted"\n\n',
  });
  assert.deepEqual(splitProjectTrust('a = 1\n\n\n'), { managed: 'a = 1\n', projects: '' });
});

test('project-like headers inside a multiline string or an array stay managed', () => {
  const multiline = 'a = """\n[projects."/x"]\n"""\n';
  assert.deepEqual(splitProjectTrust(multiline), { managed: multiline, projects: '' });
  const array = 'paths = [\n  [ "projects" ],\n]\n';
  assert.deepEqual(splitProjectTrust(array), { managed: array, projects: '' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/machine/checks/config-file-state.spec.ts`
Expected: FAIL with "Cannot find module .../src/config/file-state.ts".

- [ ] **Step 3: Implement**

`packages/machine/src/config/file-state.ts`:

```ts
import { hashText } from '../hash.ts';

export type FileState = 'clean' | 'repo-ahead' | 'local-ahead' | 'conflict' | 'unmanaged' | 'missing-repo';

// The three-way state of one copied file or settings key, from hashes; undefined means absent.
export const fileState = (input: { readonly baseline?: string; readonly repo?: string; readonly local?: string }): FileState => {
  const { baseline, repo, local } = input;
  if (repo === undefined) return 'missing-repo';
  if (baseline === undefined) return 'unmanaged';
  // A deleted local file is recoverable from the repo, so it reads as the repo being ahead.
  if (local === undefined) return 'repo-ahead';
  // Both sides converged: nothing to reconcile, only a stale baseline.
  if (repo === local) return 'clean';
  if (local === baseline) return 'repo-ahead';
  if (repo === baseline) return 'local-ahead';
  return 'conflict';
};

// A JSON value's text with object keys sorted: agents rewrite settings in place, and key order is
// not a change. Array order is.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// undefined for an absent value, which fileState reads as "not on this side".
export const hashValue = (value: unknown): string | undefined =>
  value === undefined ? undefined : hashText(canonical(value));
```

`packages/machine/src/config/project-trust.ts` is a typed port of `src/project-trust.mjs`. Keep its logic line for line:

```ts
type Context = { readonly multiline: string | null; readonly depth: number };

// Separates Codex's machine-local project tables from the rest of a config.toml without
// reserialising its TOML. `managed` is trimmed and ends with one newline.
export const splitProjectTrust = (text: string): { managed: string; projects: string } => {
  const managed: string[] = [];
  const projects: string[] = [];
  let inProjects = false;
  let context: Context = { multiline: null, depth: 0 };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (!context.multiline && context.depth === 0 && /^\s*\[/.test(line)) {
      const next = /^\s*\[\[?\s*(?:projects|"projects"|'projects')\s*[.\]]/.test(line);
      if (next !== inProjects) {
        while (managed.length && !managed.at(-1)!.trim()) managed.pop();
        if (!next && managed.length) managed.push('\n');
      }
      inProjects = next;
    }
    (inProjects ? projects : managed).push(line);
    context = contextAfter(line, context);
  }
  return { managed: managed.join('').trimEnd() + '\n', projects: projects.join('') };
};

// Brackets inside strings and arrays cannot open a table.
const contextAfter = (line: string, { multiline, depth }: Context): Context => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    if (multiline) {
      if (multiline === '"""' && line[i] === '\\') {
        i += 1;
        continue;
      }
      if (line.startsWith(multiline, i)) {
        const char = multiline[0];
        i += 2;
        while (line[i + 1] === char) i += 1;
        multiline = null;
      }
    } else if (quote) {
      if (quote === '"' && line[i] === '\\') i += 1;
      else if (line[i] === quote) quote = null;
    } else if (line[i] === '#') {
      break;
    } else if (line[i] === '"' || line[i] === "'") {
      const delimiter = line[i]!.repeat(3);
      if (line.startsWith(delimiter, i)) {
        multiline = delimiter;
        i += 2;
      } else {
        quote = line[i]!;
      }
    } else if (line[i] === '[' || line[i] === '{') {
      depth += 1;
    } else if (line[i] === ']' || line[i] === '}') {
      depth -= 1;
    }
  }
  return { multiline, depth };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/machine/checks/config-file-state.spec.ts && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine/src/config/file-state.ts packages/machine/src/config/project-trust.ts packages/machine/checks/config-file-state.spec.ts
git commit -m "feat: port file states, settings hashing and project trust to the machine package"
```

---

### Task 4: Observe managed files and inspect them

`observe.ts` reads one managed file as it stands now. `inspect.ts` turns those readings into `Observed` items. This task adds the one contract field, `Observed.facts`. `steps` is pure and gets only items, but it needs four facts that `state` cannot carry:

- `recorded`: nortuscc holds a baseline (uninstall acts on it).
- `local-changed`: the machine side differs from the baseline (uninstall's "changed since apply"). A deleted file counts.
- `local-absent`: nothing on the machine side (capture has nothing to take).
- `baseline-stale`: both sides converged on new content, so the baseline must be refreshed. If it isn't, the next repo change reads as a conflict.

**Files:**
- Modify: `packages/machine/src/model.ts` (add `facts?` to `Observed`)
- Create: `packages/machine/src/config/observe.ts`
- Create: `packages/machine/src/config/inspect.ts`
- Create: `packages/machine/checks/config-machine.ts` (test fixture, not a spec)
- Test: `packages/machine/checks/config-inspect.spec.ts`

**Interfaces:**
- Consumes: Task 3's `fileState`, `hashValue`, `splitProjectTrust`; `hashText`, `homeDir`, `MachinePaths`, `Fs`, `StateStore`, `Baseline`.
- Produces (`observe.ts`):
  - `type Fact = 'recorded' | 'local-changed' | 'local-absent' | 'baseline-stale'`
  - `type Reading = { key: string; label: string; state: string; facts: ReadonlyArray<Fact>; from: Origin; note?: string }`
  - `type CopyReading = Reading & { repoText?: string; localText?: string }`
  - `type Document = { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'object'; value: Readonly<Record<string, unknown>> }`
  - `type DocumentReading = { readings: ReadonlyArray<Reading>; local: Document; repoText?: string }`
  - `itemKey(fileId: string, settingsKey?: string): string` → `config:<id>` or `config:<id>#<key>`
  - `configFileId(key: string): string` (the file id of an item or step key)
  - `settingsKeyOf(key: string): string | undefined`
  - `filePaths(paths: MachinePathsValue, file: Pick<FileEntry, 'home' | 'src' | 'dest'>): { src: string; dest: string }`
  - `contentHash(file: Pick<FileEntry, 'preserveProjects'>, text: string | undefined): string | undefined`
  - `parseDocument(text: string | undefined): Document`
  - `readCopy(file: ResolvedFile, baselines): Effect<CopyReading, FsFailed, Fs | MachinePaths>`
  - `readMerge(file: ResolvedFile, desired: DesiredConfig, baselines): Effect<DocumentReading, FsFailed, Fs | MachinePaths>`
- Produces (`inspect.ts`): `inspectConfig(desired: DesiredConfig): Effect<{ items: Observed[]; probeErrors: string[] }, never, StateStore | Fs | MachinePaths>`
- Produces (fixture): `REPO_FILES`, `configMachine(repoFiles?)` returning `{ root, paths, write, read, desired, layer, observe, state }`.

- [ ] **Step 1: Add the contract field.** In `packages/machine/src/model.ts`, inside `Observed` after `note?`:

```ts
  // Facts only the owning domain's `steps` reads (for config: "recorded", "local-absent"). Deterministic, like `state`.
  readonly facts?: ReadonlyArray<string>;
```

- [ ] **Step 2: Write the fixture** `packages/machine/checks/config-machine.ts`

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { loadProfile, nodeFiles, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import { backupsForRun, machinePaths, nodeFs, stateStore, type MachinePathsValue } from '../src/index.ts';
import { inspectConfig } from '../src/config/inspect.ts';

export const REPO_FILES: Readonly<Record<string, string>> = {
  'claude/CLAUDE.md': '# repo claude\n',
  'codex/AGENTS.md': '# repo codex\n',
  'codex/openrouter-glm/models-static.json': '{"models":[]}\n',
  'codex/openrouter-glm/config.toml': 'model = "glm"\n',
  'claude/settings.keys.json': JSON.stringify({ theme: 'dark', model: 'opus' }, null, 2) + '\n',
};

// A temporary repo checkout and agent homes, with the services a config run needs.
export const configMachine = (repoFiles: Readonly<Record<string, string>> = REPO_FILES) => {
  const root = mkdtempSync(join(tmpdir(), 'machine-config-'));
  const paths: MachinePathsValue = {
    repo: join(root, 'repo'), claude: join(root, '.claude'), codex: join(root, '.codex'),
    codexOpenRouter: join(root, '.codex-openrouter'), agentsSkills: join(root, 'skills'),
    stateRoot: join(root, 'state'), backups: join(root, 'state', 'backups'),
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
  for (const [relative, text] of Object.entries(repoFiles)) write(join(paths.repo, relative), text);

  let runs = 0;
  // A fresh backups layer per run, each with its own stamp, as a command builds one per run.
  const layer = () => Layer.mergeAll(stateStore, backupsForRun(new Date(Date.UTC(2026, 9, 5, 12, 0, runs++))))
    .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const desired = (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(loadProfile(paths.repo, { overrides }).pipe(Effect.provide(nodeFiles)));
  const observe = async (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(inspectConfig(await desired(overrides)).pipe(Effect.provide(layer())));
  const state = (): { files: Record<string, { hash: string }>; skillsOnly?: boolean } =>
    JSON.parse(read(join(paths.stateRoot, 'state.json')) ?? '{"files":{}}');
  const baselines = (files: Record<string, string>) =>
    write(join(paths.stateRoot, 'state.json'), JSON.stringify({
      version: 1, repo: null, skillsOnly: false,
      files: Object.fromEntries(Object.entries(files).map(([key, hash]) => [key, { hash, appliedAt: '2026-10-05T00:00:00.000Z' }])),
    }));
  return { root, paths, write, read, desired, layer, observe, state, baselines };
};
```

- [ ] **Step 3: Write the failing test** `packages/machine/checks/config-inspect.spec.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashText } from '../src/hash.ts';
import { hashValue } from '../src/config/file-state.ts';
import { splitProjectTrust } from '../src/config/project-trust.ts';
import { configMachine, REPO_FILES } from './config-machine.ts';

const find = <T extends { key: string }>(items: ReadonlyArray<T>, key: string): T => items.find((i) => i.key === key)!;

test('a fresh machine reports every managed file and settings key as unmanaged, to apply', async () => {
  const m = configMachine();
  const { items, probeErrors } = await m.observe();
  assert.deepEqual(probeErrors, []);
  assert.deepEqual(items.map((i) => [i.key, i.state, i.disposition, i.facts]), [
    ['config:claude:CLAUDE.md', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:AGENTS.md', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:models-static.json', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:config.toml', 'unmanaged', 'apply', ['local-absent']],
    ['config:claude:settings.json#theme', 'unmanaged', 'apply', ['local-absent']],
    ['config:claude:settings.json#model', 'unmanaged', 'apply', ['local-absent']],
  ]);
  assert.deepEqual([items[0]!.label, items[0]!.group, items[0]!.domain, items[0]!.target], ['CLAUDE.md', 'claude', 'config', 'claude']);
  assert.equal(items[4]!.label, 'settings.json#theme');
});

test('recorded files: clean, converged with a stale baseline, edited locally, deleted locally', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), REPO_FILES['claude/CLAUDE.md']!);
  m.write(join(m.paths.codex, 'AGENTS.md'), REPO_FILES['codex/AGENTS.md']!);
  m.write(join(m.paths.codexOpenRouter, 'models-static.json'), '{"mine":true}\n');
  m.baselines({
    'claude:CLAUDE.md': hashText(REPO_FILES['claude/CLAUDE.md']!),
    'codex:AGENTS.md': hashText('# older\n'),
    'codex:models-static.json': hashText(REPO_FILES['codex/openrouter-glm/models-static.json']!),
    'codex:config.toml': hashText(REPO_FILES['codex/openrouter-glm/config.toml']!),
  });
  const { items } = await m.observe();
  const view = (key: string) => { const i = find(items, key); return [i.state, i.disposition, i.facts]; };
  assert.deepEqual(view('config:claude:CLAUDE.md'), ['clean', 'in-sync', ['recorded']]);
  assert.deepEqual(view('config:codex:AGENTS.md'), ['clean', 'in-sync', ['recorded', 'local-changed', 'baseline-stale']]);
  assert.deepEqual(view('config:codex:models-static.json'), ['local-ahead', 'capture', ['recorded', 'local-changed']]);
  assert.deepEqual(view('config:codex:config.toml'), ['repo-ahead', 'apply', ['recorded', 'local-changed', 'local-absent']]);
});

test('project tables never count as drift', async () => {
  const m = configMachine();
  const repo = REPO_FILES['codex/openrouter-glm/config.toml']!;
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), `${repo}\n[projects."/w"]\ntrust_level = "trusted"\n`);
  m.baselines({ 'codex:config.toml': hashText(splitProjectTrust(repo).managed) });
  const { items } = await m.observe();
  assert.equal(find(items, 'config:codex:config.toml').state, 'clean');
});

test('settings keys: an edited key is local-ahead, and keys the repo does not name are not items', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus', mine: 1 }));
  m.baselines({ 'claude:settings.json#theme': hashValue('dark')!, 'claude:settings.json#model': hashValue('opus')! });
  const { items } = await m.observe();
  const settings = items.filter((i) => i.key.startsWith('config:claude:settings.json'));
  assert.deepEqual(settings.map((i) => [i.key, i.state, i.disposition, i.facts]), [
    ['config:claude:settings.json#theme', 'local-ahead', 'capture', ['recorded', 'local-changed']],
    ['config:claude:settings.json#model', 'clean', 'in-sync', ['recorded']],
  ]);
});

test('an invalid, absent or locally unparseable settings document is one blocked item', async () => {
  const invalid = configMachine({ ...REPO_FILES, 'claude/settings.keys.json': '{"env":{"API_KEY":"x"}}' });
  const one = find((await invalid.observe()).items, 'config:claude:settings.json');
  assert.deepEqual([one.state, one.disposition], ['invalid', 'blocked']);
  assert.match(one.note ?? '', /looks like a secret/);

  const { 'claude/settings.keys.json': _dropped, ...withoutSettings } = REPO_FILES;
  const absent = configMachine(withoutSettings);
  assert.equal(find((await absent.observe()).items, 'config:claude:settings.json').state, 'missing-repo');

  const broken = configMachine();
  broken.write(join(broken.paths.claude, 'settings.json'), '{ broken');
  const items = (await broken.observe()).items.filter((i) => i.key.startsWith('config:claude:settings.json'));
  assert.deepEqual(items.map((i) => [i.key, i.state, i.disposition]), [['config:claude:settings.json', 'unparseable-local', 'blocked']]);
});

test('a skills-only machine still reads every file but excludes it', async () => {
  const m = configMachine();
  const { items } = await m.observe({ value: { manageConfig: false }, source: 'overrides.json', issues: [] });
  assert.ok(items.length === 6 && items.every((i) => i.disposition === 'excluded' && i.state === 'unmanaged'));
  assert.deepEqual(items[0]!.from, { layer: 'machine', source: 'overrides.json' });
});

test('unreadable machine state is a probe error, not a guess', async () => {
  const m = configMachine();
  mkdirSync(join(m.paths.stateRoot, 'state.json'), { recursive: true });
  const { items, probeErrors } = await m.observe();
  assert.deepEqual(items, []);
  assert.equal(probeErrors.length, 1);
  assert.match(probeErrors[0]!, /^config: /);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node --test packages/machine/checks/config-inspect.spec.ts`
Expected: FAIL with "Cannot find module .../src/config/inspect.ts".

- [ ] **Step 5: Implement** `packages/machine/src/config/observe.ts`

```ts
import { join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig, FileEntry, Origin, ResolvedFile } from '@nortuscc/profile-engine';
import { Fs } from '../fs.ts';
import { hashText } from '../hash.ts';
import { homeDir, MachinePaths, type MachinePathsValue } from '../paths.ts';
import type { Baseline } from '../state.ts';
import { fileState, hashValue } from './file-state.ts';
import { splitProjectTrust } from './project-trust.ts';

// What `steps` needs beyond `state`. recorded: nortuscc holds a baseline. local-changed: the machine
// side differs from it (uninstall's "changed since apply"). local-absent: nothing on the machine
// side. baseline-stale: both sides agree, but on content newer than the baseline.
export type Fact = 'recorded' | 'local-changed' | 'local-absent' | 'baseline-stale';

// One copied file or settings key as it stands now.
export type Reading = {
  readonly key: string;
  readonly label: string;
  readonly state: string;
  readonly facts: ReadonlyArray<Fact>;
  readonly from: Origin;
  readonly note?: string;
};
export type CopyReading = Reading & { readonly repoText?: string; readonly localText?: string };
export type Document =
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'object'; readonly value: Readonly<Record<string, unknown>> };
export type DocumentReading = { readonly readings: ReadonlyArray<Reading>; readonly local: Document; readonly repoText?: string };

export const itemKey = (fileId: string, settingsKey?: string): string =>
  settingsKey === undefined ? `config:${fileId}` : `config:${fileId}#${settingsKey}`;

// The managed file an item or step key belongs to. File ids never contain '#'.
export const configFileId = (key: string): string => key.slice('config:'.length).split('#')[0]!;

export const settingsKeyOf = (key: string): string | undefined => {
  const at = key.indexOf('#');
  return at === -1 ? undefined : key.slice(at + 1);
};

export const filePaths = (paths: MachinePathsValue, file: Pick<FileEntry, 'home' | 'src' | 'dest'>) => ({
  src: join(paths.repo, file.src),
  dest: join(homeDir(paths, file.home), file.dest),
});

// What a copied file's hash covers: its whole text, or with preserveProjects only the managed part.
export const contentHash = (file: Pick<FileEntry, 'preserveProjects'>, text: string | undefined): string | undefined =>
  text === undefined ? undefined : hashText(file.preserveProjects ? splitProjectTrust(text).managed : text);

// Absent and unparseable differ: a missing settings file is ordinary, a broken one is the user's to fix.
export const parseDocument = (text: string | undefined): Document => {
  if (text === undefined) return { kind: 'absent' };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' };
    return { kind: 'object', value: value as Record<string, unknown> };
  } catch {
    return { kind: 'corrupt' };
  }
};

const factsFor = (baseline: string | undefined, repo: string | undefined, local: string | undefined, state: string): Fact[] => [
  ...(baseline !== undefined ? ['recorded' as const] : []),
  ...(baseline !== undefined && local !== baseline ? ['local-changed' as const] : []),
  ...(local === undefined ? ['local-absent' as const] : []),
  ...(state === 'clean' && baseline !== repo ? ['baseline-stale' as const] : []),
];

export const readCopy = (file: ResolvedFile, baselines: Readonly<Record<string, Baseline>>) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const repoText = yield* fs.readText(src);
    const localText = yield* fs.readText(dest);
    const baseline = baselines[file.id]?.hash;
    const repo = contentHash(file, repoText);
    const local = contentHash(file, localText);
    const state = fileState({ baseline, repo, local });
    const reading: CopyReading = {
      key: itemKey(file.id), label: file.dest, state, facts: factsFor(baseline, repo, local, state), from: file.from, repoText, localText,
    };
    return reading;
  });

// One reading per owned key, or a single document reading when the repo side owns nothing
// (absent or refused) or the machine side will not parse.
export const readMerge = (file: ResolvedFile, desired: DesiredConfig, baselines: Readonly<Record<string, Baseline>>) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const repoText = yield* fs.readText(src);
    const local = parseDocument(yield* fs.readText(dest));
    const localValue = (key: string) => (local.kind === 'object' && Object.hasOwn(local.value, key) ? local.value[key] : undefined);
    const recorded = Object.keys(baselines).filter((k) => k.startsWith(`${file.id}#`));
    const changed = local.kind === 'corrupt'
      || recorded.some((k) => hashValue(localValue(k.slice(file.id.length + 1))) !== baselines[k]!.hash);
    const documentFacts: Fact[] = [
      ...(recorded.length ? ['recorded' as const] : []),
      ...(recorded.length && changed ? ['local-changed' as const] : []),
      ...(local.kind === 'absent' ? ['local-absent' as const] : []),
    ];
    const whole = (state: string, note?: string): DocumentReading => ({
      readings: [{ key: itemKey(file.id), label: file.dest, state, facts: documentFacts, from: file.from, ...(note ? { note } : {}) }],
      local,
      repoText,
    });

    const keys = file.keys ?? {};
    if (Object.keys(keys).length === 0) {
      const issues = desired.issues.filter((i) => i.layer === 'base' && i.source === file.src);
      return issues.length ? whole('invalid', issues.map((i) => i.message).join('; ')) : whole('missing-repo');
    }
    if (local.kind === 'corrupt') return whole('unparseable-local');

    const readings = Object.entries(keys).map(([key, { value, from }]): Reading => {
      const baseline = baselines[`${file.id}#${key}`]?.hash;
      const repo = hashValue(value);
      const localHash = hashValue(localValue(key));
      const state = fileState({ baseline, repo, local: localHash });
      return { key: itemKey(file.id, key), label: `${file.dest}#${key}`, state, facts: factsFor(baseline, repo, localHash, state), from };
    });
    const reading: DocumentReading = { readings, local, repoText };
    return reading;
  });
```

`packages/machine/src/config/inspect.ts`:

```ts
import { Cause, Effect, Exit } from 'effect';
import type { DesiredConfig, ResolvedFile } from '@nortuscc/profile-engine';
import type { FsFailed } from '../errors.ts';
import type { Fs } from '../fs.ts';
import type { Disposition, Observed } from '../model.ts';
import type { MachinePaths } from '../paths.ts';
import { StateStore } from '../state.ts';
import { readCopy, readMerge, type Reading } from './observe.ts';

const disposition = (file: ResolvedFile, state: string): Disposition => {
  if (!file.managed) return 'excluded';
  if (state === 'clean') return 'in-sync';
  if (state === 'repo-ahead' || state === 'unmanaged') return 'apply';
  if (state === 'local-ahead') return 'capture';
  return 'blocked';
};

const problem = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return `config: ${error instanceof Error && error.message ? error.message : String(error)}`;
};

// Every managed file's state, including files this machine does not manage: uninstall still needs
// those. A file that cannot be read is a probe error, never a guessed state.
export const inspectConfig = (desired: DesiredConfig) =>
  Effect.gen(function* () {
    const items: Observed[] = [];
    const probeErrors: string[] = [];
    const state = yield* Effect.exit((yield* StateStore).read);
    if (Exit.isFailure(state)) return { items, probeErrors: [problem(state.cause)] };

    for (const file of desired.files) {
      const read: Effect.Effect<ReadonlyArray<Reading>, FsFailed, Fs | MachinePaths> = file.mode === 'copy'
        ? Effect.map(readCopy(file, state.value.files), (reading) => [reading])
        : Effect.map(readMerge(file, desired, state.value.files), (document) => document.readings);
      const result = yield* Effect.exit(read);
      if (Exit.isFailure(result)) {
        probeErrors.push(problem(result.cause));
        continue;
      }
      for (const r of result.value) {
        items.push({
          key: r.key, domain: 'config', target: file.target, label: r.label, group: file.target, state: r.state,
          disposition: disposition(file, r.state), facts: r.facts, from: r.from, ...(r.note ? { note: r.note } : {}),
        });
      }
    }
    return { items, probeErrors };
  });
```

The annotation on `read` gives both branches one type, so `Effect.exit` sees a single `Effect` rather than a union. Confirm with `npm run typecheck -w packages/machine` that `configDomain` (Task 6) accepts `inspectConfig` as its `inspect`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test packages/machine/checks/config-inspect.spec.ts && npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/machine/src/model.ts packages/machine/src/config/observe.ts packages/machine/src/config/inspect.ts packages/machine/checks/config-machine.ts packages/machine/checks/config-inspect.spec.ts
git commit -m "feat: inspect copied files and settings keys into config items with facts"
```

---

### Task 5: Plan config steps

**Files:**
- Create: `packages/machine/src/config/steps.ts`
- Test: `packages/machine/checks/config-steps.spec.ts`

**Interfaces:**
- Consumes: `FILES`, `FileEntry` from the engine; `configFileId`, `itemKey` from Task 4; `Observed`, `PlanKind`, `Selection`, `Skipped`, `Step`, `StepAction`.
- Produces:
  - `CHANGED_SINCE_APPLY = 'changed since nortuscc wrote it'` (the skip reason uninstall's refusal matches)
  - `configSteps(items, selection, kind): { steps: Step[]; skipped: Skipped[] }`
  - Step keys: apply and capture use the item key. Uninstall uses the document key `config:<id>`, with action `restore`. Touches are `<home>:<dest>` for the machine side and `repo:<src>` for the repo side.

- [ ] **Step 1: Write the failing test** `packages/machine/checks/config-steps.spec.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAll, type Observed } from '../src/index.ts';
import { CHANGED_SINCE_APPLY, configSteps } from '../src/config/steps.ts';

const DISPOSITION: Record<string, Observed['disposition']> = {
  clean: 'in-sync', 'repo-ahead': 'apply', unmanaged: 'apply', 'local-ahead': 'capture',
};
const item = (key: string, state: string, facts: string[] = [], over: Partial<Observed> = {}): Observed => ({
  key, domain: 'config', target: key.startsWith('config:codex') ? 'codex' : 'claude',
  label: key.slice(key.lastIndexOf(':') + 1), group: 'g', state, disposition: DISPOSITION[state] ?? 'blocked', facts, ...over,
});
const keys = (list: ReadonlyArray<{ key: string }>) => list.map((s) => s.key);

test('apply writes what the repo is ahead on, as file or key steps', () => {
  const result = configSteps([
    item('config:claude:CLAUDE.md', 'unmanaged', ['local-absent']),
    item('config:claude:settings.json#theme', 'repo-ahead', ['recorded']),
  ], selectAll, 'apply');
  assert.deepEqual(result.steps, [
    { key: 'config:claude:CLAUDE.md', domain: 'config', action: 'write-file', summary: 'copy CLAUDE.md from the repo', touches: ['claude:CLAUDE.md'], interruptible: false },
    { key: 'config:claude:settings.json#theme', domain: 'config', action: 'merge-keys', summary: 'set settings.json#theme from the repo', touches: ['claude:settings.json'], interruptible: false },
  ]);
  assert.deepEqual(result.skipped, []);
});

test('a clean item is no step, unless its baseline is stale', () => {
  assert.deepEqual(configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded'])], selectAll, 'apply'), { steps: [], skipped: [] });
  const stale = configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded', 'local-changed', 'baseline-stale'])], selectAll, 'apply');
  assert.deepEqual(stale.steps.map((s) => [s.action, s.summary]), [['write-file', 'record CLAUDE.md as in sync']]);
});

test('conflicts and local edits are skipped; force takes the repo for files, never for local-ahead keys', () => {
  const items = [
    item('config:claude:CLAUDE.md', 'conflict', ['recorded', 'local-changed']),
    item('config:codex:AGENTS.md', 'local-ahead', ['recorded', 'local-changed']),
    item('config:claude:settings.json#theme', 'local-ahead', ['recorded', 'local-changed']),
  ];
  const plain = configSteps(items, selectAll, 'apply');
  assert.deepEqual(plain.steps, []);
  assert.deepEqual(plain.skipped, [
    { key: 'config:claude:CLAUDE.md', reason: 'changed on both sides; --take-repo keeps the repo version' },
    { key: 'config:codex:AGENTS.md', reason: 'changed on this machine; capture keeps it' },
    { key: 'config:claude:settings.json#theme', reason: 'changed on this machine; capture keeps it' },
  ]);
  const forced = configSteps(items, { ...selectAll, force: true }, 'apply');
  assert.deepEqual(keys(forced.steps), ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md']);
  assert.deepEqual(keys(forced.skipped), ['config:claude:settings.json#theme']);
});

test('blocked states and excluded or unselected items are skipped with their reason', () => {
  const result = configSteps([
    item('config:codex:AGENTS.md', 'missing-repo'),
    item('config:claude:settings.json', 'unparseable-local'),
    item('config:claude:settings.json', 'invalid', [], { note: "settings key 'env.API_KEY' looks like a secret" }),
    item('config:codex:config.toml', 'unmanaged', [], { disposition: 'excluded' }),
  ], selectAll, 'apply');
  assert.deepEqual(result.skipped.map((s) => s.reason), [
    'missing from the repo',
    'not valid JSON on this machine; fix it by hand',
    "settings key 'env.API_KEY' looks like a secret",
    'not managed on this machine',
  ]);
  const narrowed = configSteps([item('config:claude:CLAUDE.md', 'unmanaged')], { ...selectAll, targets: ['codex'] }, 'apply');
  assert.deepEqual(narrowed, { steps: [], skipped: [{ key: 'config:claude:CLAUDE.md', reason: 'target not selected' }] });
});

test('capture takes local edits, never repo-owned files, and has nothing to take from an absent file', () => {
  const result = configSteps([
    item('config:claude:CLAUDE.md', 'local-ahead', ['recorded', 'local-changed']),
    item('config:codex:AGENTS.md', 'unmanaged', ['local-absent']),
    item('config:codex:config.toml', 'local-ahead', ['recorded', 'local-changed']),
    item('config:claude:settings.json#theme', 'repo-ahead', ['recorded']),
    item('config:claude:settings.json#model', 'unmanaged'),
    item('config:claude:settings.json#tui', 'conflict', ['recorded', 'local-changed']),
  ], selectAll, 'capture');
  assert.deepEqual(result.steps.map((s) => [s.key, s.action, s.summary, s.touches]), [
    ['config:claude:CLAUDE.md', 'capture-file', 'capture CLAUDE.md into the repo', ['repo:claude/CLAUDE.md']],
    ['config:claude:settings.json#model', 'capture-file', 'capture settings.json#model into the repo', ['repo:claude/settings.keys.json']],
  ]);
  assert.deepEqual(result.skipped, [
    { key: 'config:codex:config.toml', reason: 'repo-owned: local changes are never captured' },
    { key: 'config:claude:settings.json#theme', reason: 'the repo is ahead; apply takes it' },
    { key: 'config:claude:settings.json#tui', reason: 'changed on both sides; --take-local keeps the local version' },
  ]);
  const forced = configSteps([item('config:claude:settings.json#tui', 'conflict', ['recorded', 'local-changed'])], { ...selectAll, force: true }, 'capture');
  assert.deepEqual(keys(forced.steps), ['config:claude:settings.json#tui']);
});

test('uninstall restores each recorded document once, refusing a changed one unless forced', () => {
  const items = [
    item('config:claude:CLAUDE.md', 'clean', ['recorded']),
    item('config:codex:AGENTS.md', 'unmanaged', ['local-absent']),
    item('config:claude:settings.json#theme', 'clean', ['recorded']),
    item('config:claude:settings.json#model', 'local-ahead', ['recorded', 'local-changed']),
    item('config:codex:config.toml', 'clean', ['recorded'], { disposition: 'excluded' }),
  ];
  const plain = configSteps(items, selectAll, 'uninstall');
  assert.deepEqual(keys(plain.steps), ['config:claude:CLAUDE.md', 'config:codex:config.toml']);
  assert.deepEqual(plain.skipped, [{ key: 'config:claude:settings.json', reason: CHANGED_SINCE_APPLY }]);
  const forced = configSteps(items, { ...selectAll, force: true }, 'uninstall');
  assert.deepEqual(forced.steps.map((s) => [s.key, s.action, s.summary, s.touches]), [
    ['config:claude:CLAUDE.md', 'restore', 'restore CLAUDE.md to its state before nortuscc', ['claude:CLAUDE.md']],
    ['config:claude:settings.json', 'restore', 'restore settings.json to its state before nortuscc', ['claude:settings.json']],
    ['config:codex:config.toml', 'restore', 'restore config.toml to its state before nortuscc', ['codex-openrouter:config.toml']],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/machine/checks/config-steps.spec.ts`
Expected: FAIL with "Cannot find module .../src/config/steps.ts".

- [ ] **Step 3: Implement** `packages/machine/src/config/steps.ts`

```ts
import { FILES, type FileEntry } from '@nortuscc/profile-engine';
import type { Observed, PlanKind, Selection, Skipped, Step, StepAction } from '../model.ts';
import { configFileId, itemKey } from './observe.ts';

// The skip reason a refused uninstall is recognised by.
export const CHANGED_SINCE_APPLY = 'changed since nortuscc wrote it';

type Decision = Step | Skipped | undefined;

const has = (item: Observed, fact: string) => item.facts?.includes(fact) ?? false;
const machineSide = (file: FileEntry) => `${file.home}:${file.dest}`;
const repoSide = (file: FileEntry) => `repo:${file.src}`;
const skip = (item: Observed, reason: string): Skipped => ({ key: item.key, reason });
const step = (key: string, action: StepAction, summary: string, touches: string): Step =>
  ({ key, domain: 'config', action, summary, touches: [touches], interruptible: false });

const blocked = (item: Observed): Skipped => skip(item,
  item.state === 'missing-repo' ? 'missing from the repo'
    : item.state === 'unparseable-local' ? 'not valid JSON on this machine; fix it by hand'
    : item.state === 'invalid' ? item.note ?? 'the repo file is invalid'
    : `nothing to do for ${item.state}`);

// repo -> machine. A local-only change is capture's; force (--take-repo) discards it for a whole
// file but never for a settings key, as the legacy merge never did.
const applyDecision = (item: Observed, file: FileEntry, force: boolean): Decision => {
  const action: StepAction = file.mode === 'copy' ? 'write-file' : 'merge-keys';
  const write = () => step(item.key, action, `${file.mode === 'copy' ? 'copy' : 'set'} ${item.label} from the repo`, machineSide(file));
  switch (item.state) {
    case 'repo-ahead':
    case 'unmanaged':
      return write();
    case 'clean':
      return has(item, 'baseline-stale') ? step(item.key, action, `record ${item.label} as in sync`, machineSide(file)) : undefined;
    case 'local-ahead':
      return force && file.mode === 'copy' ? write() : skip(item, 'changed on this machine; capture keeps it');
    case 'conflict':
      return force ? write() : skip(item, 'changed on both sides; --take-repo keeps the repo version');
    default:
      return blocked(item);
  }
};

// machine -> repo, for files the repo lets a machine publish.
const captureDecision = (item: Observed, file: FileEntry, force: boolean): Decision => {
  if (!file.capture) return skip(item, 'repo-owned: local changes are never captured');
  const capture = () => step(item.key, 'capture-file', `capture ${item.label} into the repo`, repoSide(file));
  switch (item.state) {
    case 'local-ahead':
      return capture();
    case 'unmanaged':
      return has(item, 'local-absent') ? undefined : capture();
    case 'clean':
      return has(item, 'baseline-stale') ? step(item.key, 'capture-file', `record ${item.label} as in sync`, repoSide(file)) : undefined;
    case 'repo-ahead':
      return skip(item, 'the repo is ahead; apply takes it');
    case 'conflict':
      return force ? capture() : skip(item, 'changed on both sides; --take-local keeps the local version');
    default:
      return blocked(item);
  }
};

// Machine-wide: every document nortuscc recorded, managed here or not. One changed item refuses
// its whole document unless forced.
const uninstallSteps = (items: ReadonlyArray<Observed>, force: boolean) => {
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  for (const id of new Set(items.map((i) => configFileId(i.key)))) {
    const file = FILES.find((f) => f.id === id);
    const mine = items.filter((i) => configFileId(i.key) === id);
    if (!file || !mine.some((i) => has(i, 'recorded'))) continue;
    const key = itemKey(id);
    if (!force && mine.some((i) => has(i, 'local-changed'))) skipped.push({ key, reason: CHANGED_SINCE_APPLY });
    else steps.push(step(key, 'restore', `restore ${file.dest} to its state before nortuscc`, machineSide(file)));
  }
  return { steps, skipped };
};

export const configSteps = (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind) => {
  if (kind === 'uninstall') return uninstallSteps(items, selection.force);
  const steps: Step[] = [];
  const skipped: Skipped[] = [];
  for (const item of items) {
    const file = FILES.find((f) => f.id === configFileId(item.key));
    const decision: Decision = !file ? skip(item, 'not a managed file')
      : !selection.targets.includes(item.target) ? skip(item, 'target not selected')
      : item.disposition === 'excluded' ? skip(item, 'not managed on this machine')
      : kind === 'apply' ? applyDecision(item, file, selection.force)
      : captureDecision(item, file, selection.force);
    if (decision === undefined) continue;
    if ('action' in decision) steps.push(decision);
    else skipped.push(decision);
  }
  return { steps, skipped };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/machine/checks/config-steps.spec.ts && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine/src/config/steps.ts packages/machine/checks/config-steps.spec.ts
git commit -m "feat: plan apply, capture and uninstall steps for config items"
```

---

### Task 6: Run apply and capture steps; assemble the domain

Each run re-reads its file, refuses with a note if the state moved since the report, and otherwise writes the file and persists the baseline. This ports `applyCopy`/`captureCopy` (`src/copy.mjs`) and `applyMerge`/`captureMerge` (`src/merge-keys.mjs`). One deliberate difference, which the spec requires: a refused conflict is a skipped item, so it no longer takes a backup copy.

**Files:**
- Create: `packages/machine/src/config/outcome.ts`
- Create: `packages/machine/src/config/sync.ts`
- Create: `packages/machine/src/config/domain.ts`
- Modify: `packages/machine/src/index.ts` (export the domain's public surface)
- Modify: `packages/machine/checks/config-machine.ts` (add `report`, `plan`, `execute`, `sync`)
- Test: `packages/machine/checks/config-sync.spec.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `outcomeNote(action: string, backedUp?: string): string` → `'copied'` or `'copied; backed up -> <path>'`
  - `splitOutcome(note: string): { action: string; backedUp?: string }`
  - `syncFile(step: Step, report: MachineReport): Effect<StepResult, FsFailed, MachinePaths | Fs | StateStore | Backups>`
  - `configDomain: Domain<MachinePaths | Fs | StateStore | Backups>`
  - From `@nortuscc/machine`: `configDomain`, `CHANGED_SINCE_APPLY`, `splitOutcome`, `configFileId`.
  - Fixture additions: `report(overrides?)`, `plan(report, kind?, selection?)`, `execute(plan, report)`, `sync(kind?, selection?)`. `sync` returns `{ report, plan, events, notes }`, where `notes[key]` is `'<outcome>: <note>'`.

- [ ] **Step 1: Extend the fixture.** In `checks/config-machine.ts`, add imports `Stream`, and from `../src/index.ts` add `configDomain, execute, inspect, plan, selectAll, type MachineReport, type Plan, type PlanKind, type Selection`. Inside `configMachine`, before `return`:

```ts
  const report = async (overrides?: Input<MachineOverrides>) =>
    Effect.runPromise(inspect(await desired(overrides), [configDomain]).pipe(Effect.provide(layer())));
  const planFor = (r: MachineReport, kind: PlanKind = 'apply', selection: Partial<Selection> = {}) =>
    plan(kind, r, { ...selectAll, ...selection }, [configDomain]);
  const executePlan = (p: Plan, r: MachineReport) =>
    Effect.runPromise(Stream.runCollect(execute(p, r, [configDomain])).pipe(Effect.map((c) => [...c]), Effect.provide(layer())));
  // Inspect, plan and execute in one go, as a command does.
  const sync = async (kind: PlanKind = 'apply', selection: Partial<Selection> = {}) => {
    const r = await report();
    const p = planFor(r, kind, selection);
    const events = await executePlan(p, r);
    const notes = Object.fromEntries(events.flatMap((e) => (e.type === 'finished' ? [[e.key, `${e.outcome}: ${e.note}`]] : [])));
    return { report: r, plan: p, events, notes };
  };
```

and add `report, plan: planFor, execute: executePlan, sync` to the returned object.

- [ ] **Step 2: Write the failing test** `packages/machine/checks/config-sync.spec.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hashText } from '../src/hash.ts';
import { hashValue } from '../src/config/file-state.ts';
import { configMachine, REPO_FILES } from './config-machine.ts';

const backupIn = (note: string | undefined) => note?.match(/^ok: copied; backed up -> (.+)$/)?.[1];

test('applying a fresh machine writes every file, records each baseline, and backs up nothing', async () => {
  const m = configMachine();
  const { events } = await m.sync();
  assert.deepEqual(events.at(-1), { type: 'done', ok: 6, failed: 0, backups: undefined });
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), REPO_FILES['claude/CLAUDE.md']);
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), REPO_FILES['codex/openrouter-glm/config.toml']);
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'dark', model: 'opus' });
  assert.deepEqual(Object.keys(m.state().files).sort(), [
    'claude:CLAUDE.md', 'claude:settings.json#model', 'claude:settings.json#theme',
    'codex:AGENTS.md', 'codex:config.toml', 'codex:models-static.json',
  ]);
  assert.deepEqual((await m.sync()).plan.steps, []);
});

test('a pre-existing file is backed up before it is replaced', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# mine\n');
  const { notes } = await m.sync();
  const backup = backupIn(notes['config:claude:CLAUDE.md']);
  assert.ok(backup?.endsWith(join('claude', 'CLAUDE.md')), notes['config:claude:CLAUDE.md']);
  assert.equal(m.read(backup!), '# mine\n');
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), REPO_FILES['claude/CLAUDE.md']);
});

test('settings keys are merged, leaving every other key alone, after a copy of the original', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ mine: 1, theme: 'light' }));
  const { notes } = await m.sync();
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { mine: 1, theme: 'dark', model: 'opus' });
  assert.deepEqual(JSON.parse(m.read(backupIn(notes['config:claude:settings.json#theme'])!)!), { mine: 1, theme: 'light' });
});

test('a conflict is skipped and left alone; --take-repo resolves it after backing up the local side', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# local moved\n');
  const refused = await m.sync();
  assert.match(refused.plan.skipped.find((s) => s.key === 'config:claude:CLAUDE.md')!.reason, /both sides/);
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# local moved\n');
  const forced = await m.sync('apply', { force: true });
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# repo moved\n');
  assert.equal(m.read(backupIn(forced.notes['config:claude:CLAUDE.md'])!), '# local moved\n');
});

test('apply carries local project tables through and hashes only the managed part', async () => {
  const m = configMachine();
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "old"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  await m.sync();
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "glm"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  assert.equal(m.state().files['codex:config.toml']!.hash, hashText('model = "glm"\n'));
});

test('a converged file only refreshes its baseline', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# new\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# new\n');
  const { plan } = await m.sync();
  assert.deepEqual(plan.steps.map((s) => s.summary), ['record CLAUDE.md as in sync']);
  assert.equal(m.state().files['claude:CLAUDE.md']!.hash, hashText('# new\n'));
  assert.deepEqual((await m.sync()).plan.steps, []);
});

test('a file edited after inspect is not overwritten: its step fails with a note', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  const report = await m.report();
  const plan = m.plan(report);
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# edited meanwhile\n');
  const events = await m.execute(plan, report);
  const finished = events.find((e) => e.type === 'finished' && e.key === 'config:claude:CLAUDE.md');
  assert.deepEqual(finished && finished.type === 'finished' ? [finished.outcome, finished.note] : [], ['failed', 'changed since it was inspected; inspect again']);
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# edited meanwhile\n');
});

test('a symlinked settings file stays a link, and its target gains the keys', async () => {
  const m = configMachine();
  const target = join(m.root, 'dotfiles', 'settings.json');
  m.write(target, '{"mine":1}');
  mkdirSync(m.paths.claude, { recursive: true });
  symlinkSync(target, join(m.paths.claude, 'settings.json'));
  await m.sync();
  assert.ok(lstatSync(join(m.paths.claude, 'settings.json')).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { mine: 1, theme: 'dark', model: 'opus' });
});

test('a key the repo no longer owns loses its baseline at the next write of its document', async () => {
  const m = configMachine();
  await m.sync();
  const state = m.state();
  m.baselines({ ...Object.fromEntries(Object.entries(state.files).map(([k, v]) => [k, v.hash])), 'claude:settings.json#gone': hashValue(1)! });
  m.write(join(m.paths.repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
  await m.sync();
  assert.equal(Object.hasOwn(m.state().files, 'claude:settings.json#gone'), false);
  assert.equal(m.state().files['claude:settings.json#theme']!.hash, hashValue('light'));
});

test('capture takes a local edit into the repo after backing up the repo file', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# from machine\n');
  const { notes } = await m.sync('capture');
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# from machine\n');
  assert.equal(m.read(backupIn(notes['config:claude:CLAUDE.md'])!), REPO_FILES['claude/CLAUDE.md']);
  assert.equal(m.state().files['claude:CLAUDE.md']!.hash, hashText('# from machine\n'));
  assert.deepEqual((await m.sync('capture')).plan.steps, []);
});

test('capture on a fresh machine plans nothing and never publishes OpenRouter files', async () => {
  const m = configMachine();
  const { plan } = await m.sync('capture');
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped.map((s) => s.key), ['config:codex:models-static.json', 'config:codex:config.toml']);
});

test('capture writes back only the locally edited settings key', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus', mine: 1 }));
  const { notes } = await m.sync('capture');
  assert.deepEqual(JSON.parse(m.read(join(m.paths.repo, 'claude/settings.keys.json'))!), { theme: 'light', model: 'opus' });
  assert.ok(backupIn(notes['config:claude:settings.json#theme'])?.endsWith(join('claude', 'settings.json.repo')));
});

test('capture refuses a credential-looking value and leaves the repo alone', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'ghp_abcdefgh123', model: 'opus' }));
  const { notes } = await m.sync('capture');
  assert.match(notes['config:claude:settings.json#theme']!, /^failed: refused: .*secret/);
  assert.equal(m.read(join(m.paths.repo, 'claude/settings.keys.json')), REPO_FILES['claude/settings.keys.json']);
});

test('a capture conflict is skipped, and --take-local resolves it', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# local moved\n');
  assert.match((await m.sync('capture')).plan.skipped.find((s) => s.key === 'config:claude:CLAUDE.md')!.reason, /--take-local/);
  await m.sync('capture', { force: true });
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# local moved\n');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test packages/machine/checks/config-sync.spec.ts`
Expected: FAIL. `configDomain` is not exported from `../src/index.ts`.

- [ ] **Step 4: Implement**

`packages/machine/src/config/outcome.ts`:

```ts
const BACKED_UP = '; backed up -> ';

// A config step's note: what happened to the file, then where the displaced copy went.
export const outcomeNote = (action: string, backedUp?: string): string => (backedUp ? `${action}${BACKED_UP}${backedUp}` : action);

export const splitOutcome = (note: string): { readonly action: string; readonly backedUp?: string } => {
  const at = note.indexOf(BACKED_UP);
  return at === -1 ? { action: note } : { action: note.slice(0, at), backedUp: note.slice(at + BACKED_UP.length) };
};
```

`packages/machine/src/config/sync.ts`:

```ts
import { Effect } from 'effect';
import { parseSettingsKeys, type DesiredConfig, type ResolvedFile } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { Fs } from '../fs.ts';
import type { MachineReport, Step, StepResult } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { StateStore, withBaseline, withoutBaseline, type MachineState } from '../state.ts';
import { hashValue } from './file-state.ts';
import { configFileId, contentHash, filePaths, parseDocument, readCopy, readMerge, settingsKeyOf } from './observe.ts';
import { outcomeNote } from './outcome.ts';
import { splitProjectTrust } from './project-trust.ts';

const MOVED: StepResult = { ok: false, note: 'changed since it was inspected; inspect again' };
const IN_SYNC: StepResult = { ok: true, note: 'in sync' };
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

// One copied file, either direction. Converged: only the baseline moves.
const syncCopy = (step: Step, file: ResolvedFile, expected: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const store = yield* StateStore;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const now = yield* readCopy(file, (yield* store.read).files);
    if (now.state !== expected) return MOVED;
    if (now.state === 'clean') {
      yield* store.update((s) => withBaseline(s, file.id, contentHash(file, now.localText)!));
      return IN_SYNC;
    }
    if (step.action === 'capture-file') {
      if (now.localText === undefined) return { ok: true, note: 'nothing to capture' };
      // The repo file is a working-tree file: an uncommitted edit is not recoverable from git.
      const backedUp = yield* backups.moveAside(src, file.dest, file.target);
      yield* fs.writeTextAtomic(src, now.localText);
      yield* store.update((s) => withBaseline(s, file.id, contentHash(file, now.localText)!));
      return { ok: true, note: outcomeNote('copied', backedUp) };
    }
    if (now.repoText === undefined) return { ok: false, note: 'missing from the repo' };
    const projects = file.preserveProjects && now.localText !== undefined ? splitProjectTrust(now.localText).projects : '';
    const text = file.preserveProjects ? splitProjectTrust(now.repoText).managed + (projects ? `\n${projects}` : '') : now.repoText;
    const backedUp = yield* backups.moveAside(dest, file.dest, file.target);
    yield* fs.writeTextAtomic(dest, text);
    yield* store.update((s) => withBaseline(s, file.id, contentHash(file, text)!));
    return { ok: true, note: outcomeNote('copied', backedUp) };
  });

// Baselines of keys the repo document no longer owns: nothing will reconcile them again.
const pruned = (file: ResolvedFile) => (state: MachineState): MachineState =>
  Object.keys(state.files)
    .filter((k) => k.startsWith(`${file.id}#`) && !Object.hasOwn(file.keys ?? {}, k.slice(file.id.length + 1)))
    .reduce(withoutBaseline, state);

// One settings key, either direction. Keys the repo does not name are never touched.
const syncKey = (step: Step, file: ResolvedFile, desired: DesiredConfig, expected: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const store = yield* StateStore;
    const { src, dest } = filePaths(yield* MachinePaths, file);
    const key = settingsKeyOf(step.key)!;
    const owned = file.keys?.[key];
    const now = yield* readMerge(file, desired, (yield* store.read).files);
    if (!owned || now.readings.find((r) => r.key === step.key)?.state !== expected) return MOVED;
    const record = (hash: string) => store.update((s) => pruned(file)(withBaseline(s, `${file.id}#${key}`, hash)));
    const local = now.local.kind === 'object' ? now.local.value : {};
    if (expected === 'clean') {
      yield* record(hashValue(owned.value)!);
      return IN_SYNC;
    }
    if (step.action === 'merge-keys') {
      // A copy, not a move: the rest of the document stays where it is.
      const backedUp = yield* backups.preserve(dest, file.dest, file.target);
      yield* fs.writeTextAtomic(dest, json({ ...local, [key]: owned.value }));
      yield* record(hashValue(owned.value)!);
      return { ok: true, note: outcomeNote('copied', backedUp) };
    }
    const value = Object.hasOwn(local, key) ? local[key] : undefined;
    if (value === undefined) return { ok: true, note: 'nothing to capture' };
    const repo = parseDocument(now.repoText);
    if (repo.kind !== 'object') return { ok: false, note: `${file.src} is not a JSON object` };
    const next = { ...repo.value, [key]: value };
    // The repo file is committed: a local credential must never land in it.
    const issues = parseSettingsKeys(json(next), file.src).issues;
    if (issues.length) return { ok: false, note: `refused: ${issues.map((i) => i.message).join('; ')}` };
    const backedUp = yield* backups.preserve(src, `${file.dest}.repo`, file.target);
    yield* fs.writeTextAtomic(src, json(next));
    yield* record(hashValue(value)!);
    return { ok: true, note: outcomeNote('copied', backedUp) };
  });

// apply and capture: re-read the file, refuse if its state moved since the report, then write.
export const syncFile = (step: Step, report: MachineReport) => {
  const item = report.items.find((i) => i.key === step.key);
  const file = report.desired.files.find((f) => f.id === configFileId(step.key));
  if (!item || !file) return Effect.succeed<StepResult>({ ok: false, note: 'not in the inspected report' });
  return file.mode === 'copy' ? syncCopy(step, file, item.state) : syncKey(step, file, report.desired, item.state);
};
```

`packages/machine/src/config/domain.ts`:

```ts
import { Effect } from 'effect';
import type { Backups } from '../backups.ts';
import type { Fs } from '../fs.ts';
import type { Domain, StepResult } from '../model.ts';
import type { MachinePaths } from '../paths.ts';
import type { StateStore } from '../state.ts';
import { inspectConfig } from './inspect.ts';
import { configSteps } from './steps.ts';
import { syncFile } from './sync.ts';

export { CHANGED_SINCE_APPLY } from './steps.ts';

const SYNC_ACTIONS = new Set(['write-file', 'merge-keys', 'capture-file']);

// Copied files and settings keys from `DesiredConfig.files`.
export const configDomain: Domain<MachinePaths | Fs | StateStore | Backups> = {
  name: 'config',
  inspect: inspectConfig,
  steps: configSteps,
  run: (step, report) =>
    SYNC_ACTIONS.has(step.action)
      ? syncFile(step, report)
      : Effect.succeed<StepResult>({ ok: false, note: `config does not run ${step.action}` }),
};
```

`packages/machine/src/index.ts`, append:

```ts
export { CHANGED_SINCE_APPLY, configDomain } from './config/domain.ts';
export { splitOutcome } from './config/outcome.ts';
export { configFileId } from './config/observe.ts';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test packages/machine/checks/config-sync.spec.ts && npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS. If the fresh-machine test reports a `backups` folder, Task 1's fix is missing or wrong. Do not weaken the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/machine/src/config/outcome.ts packages/machine/src/config/sync.ts packages/machine/src/config/domain.ts packages/machine/src/index.ts packages/machine/checks/config-machine.ts packages/machine/checks/config-sync.spec.ts
git commit -m "feat: run config apply and capture steps and expose the config domain"
```

---

### Task 7: Run uninstall steps

Ports `restoreCopy`/`restoreMerged` and `originalBackup` from `src/commands/uninstall.mjs`. The original is the earliest run's backup at `<backups>/nortuscc-*/<target>/<dest>`. Uninstall's own displaced copies go to `<target>/uninstall/<dest>`, so an earlier uninstall is never mistaken for an original.

**Files:**
- Create: `packages/machine/src/config/restore.ts`
- Modify: `packages/machine/src/config/domain.ts` (dispatch `restore`)
- Test: `packages/machine/checks/config-uninstall.spec.ts`

**Interfaces:**
- Consumes: `filePaths`, `configFileId`, `parseDocument`, `splitProjectTrust`, `outcomeNote`, `Backups`, `Fs`, `StateStore`, `withoutBaseline`.
- Produces: `restoreFile(step: Step, report: MachineReport): Effect<StepResult, FsFailed, MachinePaths | Fs | StateStore | Backups>`. Notes: `restored`, `removed` or `preserved`, each optionally `; backed up -> <path>`. Failure: `the backup <path> is not a JSON object`. `nothing recorded` when no baseline exists at run time.

- [ ] **Step 1: Write the failing test** `packages/machine/checks/config-uninstall.spec.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGED_SINCE_APPLY } from '../src/index.ts';
import { configMachine } from './config-machine.ts';

test('uninstalling a fresh-machine apply removes every file and baseline', async () => {
  const m = configMachine();
  await m.sync();
  const { notes, events } = await m.sync('uninstall');
  assert.deepEqual(events.at(-1)?.type, 'done');
  for (const path of [
    join(m.paths.claude, 'CLAUDE.md'), join(m.paths.claude, 'settings.json'), join(m.paths.codex, 'AGENTS.md'),
    join(m.paths.codexOpenRouter, 'config.toml'), join(m.paths.codexOpenRouter, 'models-static.json'),
  ]) assert.equal(existsSync(path), false, path);
  assert.deepEqual(m.state().files, {});
  assert.match(notes['config:claude:settings.json']!, /^ok: removed; backed up -> .*uninstall/);
});

test('originals come back, and unrelated edits and project tables stay', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# original\n');
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "original"\n');
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', mine: 'before' }));
  await m.sync();
  const settings = JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!);
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ ...settings, mine: 'after' }));
  m.write(join(m.paths.codexOpenRouter, 'config.toml'),
    `${m.read(join(m.paths.codexOpenRouter, 'config.toml'))}\n[projects."/added"]\ntrust_level = "trusted"\n`);

  const { events } = await m.sync('uninstall');
  assert.deepEqual(events.at(-1)?.type, 'done');
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# original\n');
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "original"\n\n[projects."/added"]\ntrust_level = "trusted"\n');
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'light', mine: 'after' });
});

test('a changed file is refused until forced, and the forced run keeps a copy of it', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# changed\n');
  const refused = m.plan(await m.report(), 'uninstall');
  assert.deepEqual(refused.skipped, [{ key: 'config:claude:CLAUDE.md', reason: CHANGED_SINCE_APPLY }]);
  assert.equal(refused.steps.some((s) => s.key === 'config:claude:CLAUDE.md'), false);

  const { notes } = await m.sync('uninstall', { force: true });
  const backup = notes['config:claude:CLAUDE.md']!.match(/^ok: removed; backed up -> (.+)$/)?.[1];
  assert.equal(m.read(backup!), '# changed\n');
  assert.equal(existsSync(join(m.paths.claude, 'CLAUDE.md')), false);
});

test('a pre-existing symlink is restored as the same link', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'mine.md'), '# mine\n');
  symlinkSync('mine.md', join(m.paths.claude, 'CLAUDE.md'));
  await m.sync();
  await m.sync('uninstall');
  const restored = join(m.paths.claude, 'CLAUDE.md');
  assert.ok(lstatSync(restored).isSymbolicLink());
  assert.equal(readlinkSync(restored), 'mine.md');
});

test('deleted managed files come back whole from their originals under force', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', mine: 'original' }));
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "original"\n\n[projects."/o"]\ntrust_level = "trusted"\n');
  await m.sync();
  rmSync(join(m.paths.claude, 'settings.json'));
  rmSync(join(m.paths.codexOpenRouter, 'config.toml'));
  await m.sync('uninstall', { force: true });
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'light', mine: 'original' });
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "original"\n\n[projects."/o"]\ntrust_level = "trusted"\n');
});

test('malformed settings are moved aside under force, and an empty original comes back empty', async () => {
  const broken = configMachine();
  await broken.sync();
  broken.write(join(broken.paths.claude, 'settings.json'), '{ malformed');
  const { notes } = await broken.sync('uninstall', { force: true });
  assert.equal(readFileSync(notes['config:claude:settings.json']!.match(/backed up -> (.+)$/)![1]!, 'utf8'), '{ malformed');
  assert.equal(existsSync(join(broken.paths.claude, 'settings.json')), false);

  const empty = configMachine();
  mkdirSync(empty.paths.claude, { recursive: true });
  empty.write(join(empty.paths.claude, 'settings.json'), '{}\n');
  await empty.sync();
  await empty.sync('uninstall');
  assert.deepEqual(JSON.parse(empty.read(join(empty.paths.claude, 'settings.json'))!), {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/machine/checks/config-uninstall.spec.ts`
Expected: FAIL. The first test's notes say `failed: config does not run restore`.

- [ ] **Step 3: Implement** `packages/machine/src/config/restore.ts`

```ts
import { join } from 'node:path';
import { Effect } from 'effect';
import type { ResolvedFile } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import { Fs } from '../fs.ts';
import type { MachineReport, Step, StepResult } from '../model.ts';
import { MachinePaths } from '../paths.ts';
import { StateStore, withoutBaseline } from '../state.ts';
import { configFileId, filePaths, parseDocument } from './observe.ts';
import { outcomeNote } from './outcome.ts';
import { splitProjectTrust } from './project-trust.ts';

type Restored = { readonly action: 'restored' | 'removed' | 'preserved'; readonly backedUp?: string } | { readonly failed: string };
// Typed constructors, so each helper's generator returns exactly `Restored`.
const restored = (action: 'restored' | 'removed' | 'preserved', backedUp?: string): Restored => ({ action, backedUp });
const failed = (note: string): Restored => ({ failed: note });

// The earliest run's backup of a file: what was there before nortuscc first replaced it.
const originalBackup = (file: ResolvedFile) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { backups } = yield* MachinePaths;
    for (const run of (yield* fs.list(backups)) ?? []) {
      if (!run.startsWith('nortuscc-') || (yield* fs.stat(join(backups, run)))?.kind !== 'directory') continue;
      const candidate = join(backups, run, file.target, file.dest);
      if (yield* fs.stat(candidate)) return candidate;
    }
    return undefined;
  });

// A link is restored as the same link, anything else as a copy.
const putBack = (origin: string, dest: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    if ((yield* fs.stat(origin))?.kind === 'symlink') yield* fs.symlink(yield* fs.readLink(origin), dest);
    else yield* fs.copy(origin, dest);
  });

const restoreCopy = (file: ResolvedFile, dest: string, origin: string | undefined, relative: string) =>
  Effect.gen(function* () {
    const backedUp = yield* (yield* Backups).moveAside(dest, relative, file.target);
    if (origin) yield* putBack(origin, dest);
    return restored(origin ? 'restored' : 'removed', backedUp);
  });

// The original's managed part, with whatever project tables the machine holds now.
const restoreProjects = (file: ResolvedFile, dest: string, origin: string | undefined, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const current = yield* fs.readText(dest);
    if (current === undefined) {
      if (origin) yield* putBack(origin, dest);
      return restored(origin ? 'restored' : 'removed');
    }
    const projects = splitProjectTrust(current).projects;
    const managed = origin ? splitProjectTrust((yield* fs.readText(origin)) ?? '').managed : '';
    const next = managed && projects ? `${managed}\n${projects}` : managed || projects;
    if (!next) return restored('removed', yield* backups.moveAside(dest, relative, file.target));
    const backedUp = yield* backups.preserve(dest, relative, file.target);
    yield* fs.writeTextAtomic(dest, next);
    return restored(origin ? 'restored' : 'preserved', backedUp);
  });

// Each recorded key goes back to its original value, or away; every other key stays as it is now.
const restoreMerged = (file: ResolvedFile, dest: string, origin: string | undefined, recorded: ReadonlyArray<string>, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const backups = yield* Backups;
    const current = parseDocument(yield* fs.readText(dest));
    if (current.kind !== 'object') {
      const backedUp = current.kind === 'corrupt' ? yield* backups.moveAside(dest, relative, file.target) : undefined;
      if (origin) yield* putBack(origin, dest);
      return restored(origin ? 'restored' : 'removed', backedUp);
    }
    const original = origin ? parseDocument(yield* fs.readText(origin)) : { kind: 'object' as const, value: {} };
    if (original.kind !== 'object') return failed(`the backup ${origin} is not a JSON object`);
    const next: Record<string, unknown> = { ...current.value };
    for (const recordedKey of recorded) {
      if (!recordedKey.startsWith(`${file.id}#`)) continue;
      const key = recordedKey.slice(file.id.length + 1);
      if (Object.hasOwn(original.value, key)) next[key] = original.value[key];
      else delete next[key];
    }
    if (Object.keys(next).length === 0 && !origin) return restored('removed', yield* backups.moveAside(dest, relative, file.target));
    const backedUp = yield* backups.preserve(dest, relative, file.target);
    yield* fs.writeTextAtomic(dest, JSON.stringify(next, null, 2) + '\n');
    return restored('restored', backedUp);
  });

// uninstall: put one recorded file back as it was before nortuscc, then forget its baselines.
export const restoreFile = (step: Step, report: MachineReport) =>
  Effect.gen(function* () {
    const file = report.desired.files.find((f) => f.id === configFileId(step.key));
    if (!file) return { ok: false, note: 'not in the inspected report' } satisfies StepResult;
    const store = yield* StateStore;
    const recorded = Object.keys((yield* store.read).files).filter((k) => k === file.id || k.startsWith(`${file.id}#`));
    if (recorded.length === 0) return { ok: true, note: 'nothing recorded' } satisfies StepResult;
    const origin = yield* originalBackup(file);
    const { dest } = filePaths(yield* MachinePaths, file);
    const relative = join('uninstall', file.dest);
    const result = file.mode === 'merge-keys' ? yield* restoreMerged(file, dest, origin, recorded, relative)
      : file.preserveProjects ? yield* restoreProjects(file, dest, origin, relative)
      : yield* restoreCopy(file, dest, origin, relative);
    if ('failed' in result) return { ok: false, note: result.failed } satisfies StepResult;
    yield* store.update((s) => recorded.reduce(withoutBaseline, s));
    return { ok: true, note: outcomeNote(result.action, result.backedUp) } satisfies StepResult;
  });
```

Confirm with `npm run typecheck -w packages/machine` that `configDomain` still type-checks, which means `restoreFile` requires only `Fs | MachinePaths | StateStore | Backups`.

In `domain.ts`, import `restoreFile` from `./restore.ts` and change `run` to:

```ts
  run: (step, report) =>
    step.action === 'restore' ? restoreFile(step, report)
      : SYNC_ACTIONS.has(step.action) ? syncFile(step, report)
      : Effect.succeed<StepResult>({ ok: false, note: `config does not run ${step.action}` }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/machine/src/config/restore.ts packages/machine/src/config/domain.ts packages/machine/checks/config-uninstall.spec.ts
git commit -m "feat: restore or remove recorded config files on uninstall"
```

---

### Task 8: Cut `uninstall` over to TypeScript

**Files:**
- Create: `src/commands/uninstall.ts`
- Delete: `src/commands/uninstall.mjs`
- Modify: `bin/commands.mjs` (`PORTED = ['uninstall']`)
- Modify: `src/lock.mjs` (`writeLock` keeps an existing `overrides.json` in step)
- Modify: `test/main.test.ts`, `test/uninstall.test.mjs`, `test/lock.test.mjs`
- Modify: `packages/machine/README.md`, `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`

**Interfaces:**
- Consumes: from `@nortuscc/machine`: `backupsForRun, CHANGED_SINCE_APPLY, configDomain, configFileId, execute, inspect, machinePaths, nodeFs, OverridesStore, overridesStore, pathsFromEnvironment, plan, selectAll, splitOutcome, StateStore, stateStore`. From `@nortuscc/profile-engine`: `loadProfile, nodeFiles`. Legacy `parseTarget` (`src/targets.mjs`) and `formatRow`, `section` (`src/report.mjs`), until #59 ports them.
- Produces: `run(args: string[]): Promise<number>` in `src/commands/uninstall.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/uninstall.test.mjs`:

```js
test('uninstall records skills-only in overrides.json as well as state.json', async () => {
  const env = fixture();
  assert.equal((await runCli(['apply'], env)).code, 0);
  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(env.state, 'overrides.json'), 'utf8')), { version: 1, manageConfig: false });
  assert.equal(JSON.parse(readFileSync(join(env.state, 'state.json'), 'utf8')).skillsOnly, true);
});

test('uninstall leaves a malformed overrides.json alone and says so', async () => {
  const env = fixture();
  assert.equal((await runCli(['apply'], env)).code, 0);
  writeFileSync(join(env.state, 'overrides.json'), '{');
  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /overrides\.json is not valid/);
  assert.equal(readFileSync(join(env.state, 'overrides.json'), 'utf8'), '{');
  assert.equal(existsSync(join(env.claude, 'CLAUDE.md')), false);
  assert.equal(JSON.parse(readFileSync(join(env.state, 'state.json'), 'utf8')).skillsOnly, true);
});

test('uninstall changes nothing when machine state cannot be read', async () => {
  const env = fixture();
  assert.equal((await runCli(['apply'], env)).code, 0);
  rmSync(join(env.state, 'state.json'));
  mkdirSync(join(env.state, 'state.json'));
  const result = await runCli(['uninstall', '--yes'], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /state\.json/);
  assert.ok(existsSync(join(env.claude, 'CLAUDE.md')));
  assert.ok(existsSync(join(env.codex, 'AGENTS.md')));
});
```

Append to `test/lock.test.mjs`:

```js
test('writeLock keeps an existing overrides.json in step with skillsOnly and configTargets', () => {
  clearState();
  const overridesPath = join(stateRoot(), 'overrides.json');
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(overridesPath, JSON.stringify({ version: 1, manageConfig: false, skills: { a: true } }));
  writeLock({ version: 1, repo: null, skillsOnly: false, configTargets: ['claude'], files: {} });
  assert.deepEqual(JSON.parse(readFileSync(overridesPath, 'utf8')), { version: 1, skills: { a: true }, configTargets: ['claude'] });
  writeLock({ version: 1, repo: null, skillsOnly: true, files: {} });
  assert.deepEqual(JSON.parse(readFileSync(overridesPath, 'utf8')), { version: 1, skills: { a: true }, manageConfig: false });
  rmSync(overridesPath);
});

test('writeLock never creates overrides.json and leaves a malformed one alone', () => {
  clearState();
  const overridesPath = join(stateRoot(), 'overrides.json');
  writeLock({ version: 1, repo: null, skillsOnly: true, files: {} });
  assert.equal(existsSync(overridesPath), false);
  writeFileSync(overridesPath, '{');
  writeLock({ version: 1, repo: null, skillsOnly: false, files: {} });
  assert.equal(readFileSync(overridesPath, 'utf8'), '{');
  rmSync(overridesPath);
});
```

In `test/main.test.ts`, keep the `uninstall --target all` test but rename it to `'a ported command reaches its TypeScript module through main.ts'`, and add `assert.ok(PORTED.includes('uninstall'));` (import `PORTED` from `'../bin/commands.mjs'`). Then add a legacy-route test that touches only a temporary state directory:

```ts
test('an unported command reaches its legacy module through main.ts', () => {
  const state = mkdtempSync(join(tmpdir(), 'nortuscc-main-'));
  const result = spawnSync(process.execPath, [bin, 'apply', '--take-local'], {
    encoding: 'utf8',
    env: { ...process.env, NORTUSCC_STATE_DIR: state, NORTUSCC_CLAUDE_DIR: join(state, 'claude') },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--take-local has no effect on apply/);
});
```

(Add `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test test/uninstall.test.mjs test/lock.test.mjs test/main.test.ts`
Expected: FAIL. No `overrides.json` is written, `writeLock` does not mirror, and `PORTED` is empty. The existing nine uninstall tests still pass on the legacy module, which is the "before" half of the parity requirement.

- [ ] **Step 3: Implement**

`src/commands/uninstall.ts`:

```ts
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Cause, Effect, Layer, Stream } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import {
  backupsForRun, CHANGED_SINCE_APPLY, configDomain, configFileId, execute, inspect, machinePaths, nodeFs,
  OverridesStore, overridesStore, pathsFromEnvironment, plan, selectAll, splitOutcome, StateStore, stateStore,
} from '@nortuscc/machine';
import { formatRow, section } from '../report.mjs';
import { parseTarget } from '../targets.mjs';

const CHECKOUT = fileURLToPath(new URL('../..', import.meta.url));

// Restores or removes every file nortuscc recorded, then records this machine as skills-only.
const uninstall = (force: boolean, signal: AbortSignal) =>
  Effect.gen(function* () {
    const paths = yield* pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, warn: (m) => console.error(m),
    });
    const services = Layer.mergeAll(stateStore, overridesStore, backupsForRun())
      .pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));

    return yield* Effect.gen(function* () {
      const overridesFile = yield* OverridesStore;
      const desired = yield* loadProfile(paths.repo, { overrides: yield* overridesFile.read }).pipe(Effect.provide(nodeFiles));
      const report = yield* inspect(desired, [configDomain]);
      if (report.probeErrors.length > 0) {
        for (const error of report.probeErrors) console.error(`nortuscc: ${error}`);
        console.error('nortuscc: nothing was uninstalled.');
        return 1;
      }

      const label = (key: string) => desired.files.find((f) => f.id === configFileId(key))?.dest ?? key;
      const planned = plan('uninstall', report, { ...selectAll, force }, [configDomain]);
      const changed = planned.skipped.filter((s) => s.reason === CHANGED_SINCE_APPLY);
      if (changed.length > 0) {
        process.stdout.write(
          '\n' + section('uninstall', changed.map((s) => formatRow(label(s.key), 'changed', 'left untouched')))
            + `\n${changed.length} managed file(s) changed; nothing was uninstalled. Re-run with --force to preserve and replace them.\n`,
        );
        return 1;
      }

      const lines: string[] = [];
      const run = { complete: true };
      yield* Stream.runForEach(execute(planned, report, [configDomain], { signal }), (event) => Effect.sync(() => {
        if (event.type === 'cancelled') run.complete = false;
        if (event.type !== 'finished') return;
        if (event.outcome !== 'ok') {
          run.complete = false;
          lines.push(formatRow(label(event.key), event.outcome, event.note));
          return;
        }
        const { action, backedUp } = splitOutcome(event.note);
        lines.push(formatRow(label(event.key), action, backedUp ? `backed up -> ${backedUp}` : ''));
      }));
      process.stdout.write('\n' + section('uninstall', lines));
      if (!run.complete) return 1;

      // overrides.json holds the choice; state.json keeps the legacy copy until cutover (#59).
      const overrides = yield* overridesFile.read;
      yield* (yield* StateStore).update((state) => ({ ...state, skillsOnly: true }));
      if (overrides.issues.length > 0) {
        console.error(`nortuscc: ${overrides.source} is not valid, so it was left as it is; set "manageConfig": false there by hand.`);
        return 1;
      }
      yield* overridesFile.write({ ...overrides.value, manageConfig: false });
      return 0;
    }).pipe(Effect.provide(services));
  });

export async function run(args: string[] = []): Promise<number> {
  const { target, rest, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  if (target !== 'all') {
    console.error('nortuscc: uninstall applies to the whole machine; --target must be all');
    return 2;
  }
  const unknown = rest.filter((arg: string) => arg !== '--yes' && arg !== '--force');
  if (unknown.length > 0) {
    console.error(`nortuscc: unknown uninstall option '${unknown[0]}'`);
    return 2;
  }
  if (!rest.includes('--yes')) {
    console.error('nortuscc: uninstall changes files. Re-run with --yes to confirm.');
    return 2;
  }

  // SIGINT finishes the current file, then stops: bookkeeping always matches the files.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    return await Effect.runPromise(uninstall(rest.includes('--force'), controller.signal).pipe(
      Effect.catchCause((cause) => Effect.sync(() => {
        const failure = Cause.squash(cause);
        console.error(`nortuscc: ${failure instanceof Error ? failure.message : String(failure)}`);
        return 1;
      })),
    ));
  } finally {
    process.off('SIGINT', cancel);
  }
}
```

Delete `src/commands/uninstall.mjs` (`git rm`). In `bin/commands.mjs` set `export const PORTED = ['uninstall'];`.

In `src/lock.mjs`, add this function and call `mirrorOverrides(lock);` at the end of the `try` block in `writeLock`, after `renameSync`:

```js
// overrides.json, once a TypeScript command has written it, records the same two choices. Until
// cutover (#59) every state write keeps it in step. It is never created here, and a malformed one
// is left for its owner.
function mirrorOverrides(lock) {
  const path = join(stateRoot(), 'overrides.json');
  let current;
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return;
  const next = { ...current };
  delete next.manageConfig;
  delete next.configTargets;
  if (lock.skillsOnly === true) next.manageConfig = false;
  if (Array.isArray(lock.configTargets)) next.configTargets = lock.configTargets;
  if (next.manageConfig === current.manageConfig
    && JSON.stringify(next.configTargets) === JSON.stringify(current.configTargets)) return;
  const temp = join(stateRoot(), `.overrides.json.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}
```

Docs:
- `packages/machine/README.md`: add a bullet: "The config domain (`configDomain`) owns copied files and settings keys from `DesiredConfig.files`. Its items carry `facts` that only its `steps` reads (`recorded`, `local-changed`, `local-absent`, `baseline-stale`). A step re-reads its file and fails, writing nothing, if the file's state moved since the report. Uninstall restores the earliest run's backup of each recorded file."
- Spec `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md`:
  - In the `Observed` type block, add `facts?: string[]  // read only by the owning domain's steps`.
  - In Decision 3, after "is the only table of managed files", add: "It is kept as JSON (`packages/profile-engine/src/files.json`) so the legacy commands read the same table from an `npx` copy until cutover."

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/uninstall.test.mjs test/lock.test.mjs test/main.test.ts test/launcher.test.mjs && npm run typecheck`
Expected: PASS. All twelve uninstall black-box tests now run on `src/commands/uninstall.ts`, which is the "after" half of parity.

- [ ] **Step 5: Run every suite**

Run: `npm test; git status --short; npm run test:packages; npm run typecheck`
Expected: PASS, except the known pre-existing failures named in Global Constraints. Restore `skills-manifest.txt` if `git status` shows it.

- [ ] **Step 6: Commit**

```bash
git add src/commands/uninstall.ts bin/commands.mjs src/lock.mjs test/main.test.ts test/uninstall.test.mjs test/lock.test.mjs packages/machine/README.md docs/superpowers/specs/2026-10-05-machine-rebuild-design.md
git rm src/commands/uninstall.mjs
git commit -m "feat: cut uninstall over to the config domain and record skills-only in overrides.json"
```

---

## Known edges, deliberately not handled

- A settings key dropped from `settings.keys.json` keeps its baseline until the next write of `settings.json`. Uninstall acts on the document's recorded keys at run time, so it still restores such a key. The plan only decides whether a document is uninstalled from its owned keys' facts.
- The legacy apply took a backup copy of a refused conflict's local side. In the new model a blocked item is a skipped item and changes nothing (spec: "A blocked item never becomes a step").
- `status`/`apply`/`capture` text rendering of these items arrives with their cutover (#59).
