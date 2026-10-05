# Source Pin and Ignore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the author a data-layer API to pin a source to a chosen revision in `skill-pins.json`, preview which declared skills that pin moves, and ignore a source's latest revision in `source-ignores.json`.

**Architecture:** New files in `packages/source-watch/`.
- `documents.ts` holds a pure, format-preserving edit of `{ version: 1, <field>: { <source>: <value> } }` documents and one backup-then-rename writer.
- `pins.ts` and `ignores.ts` are thin wrappers over that writer.
- `ignores.ts` also has a lenient reader and `isIgnored`.
- `impact.ts` compares a source's skill folders between its baseline and a target revision through the existing `Git` service and watch cache.

**Tech Stack:** TypeScript (erasable syntax only) run directly by Node 22.18+, `effect@4.0.1`, `node:test` with `node:assert/strict`, and git.

**Spec:** `docs/superpowers/specs/2026-10-05-source-pin-ignore-design.md`

## Global Constraints

- **Edits:** only new files in `packages/source-watch/` plus export lines in `packages/source-watch/src/index.ts`. Do not edit any other existing file in that package, nor `src/`, `packages/profile-engine` or `apps/desktop`.
- **Dependencies:** none new. `effect@4.0.1` is the only runtime dependency.
- **Imports:** relative imports end in `.ts`, builtins use the `node:` prefix, and the code is erasable TypeScript (no enums, namespaces or parameter properties).
- **Tests:** `checks/*.spec.ts`, using `node:test` and `node:assert/strict`, offline. Git fixtures use `file://` through `runGit` from `checks/fixtures.ts`.
- **Secrets:** every failure `reason` passes through `redact` from `src/redact.ts`.
- **Files:** `skill-pins.json` is `{ "version": 1, "pins": { "<source>": "<ref>" } }`. `source-ignores.json` is `{ "version": 1, "ignored": { "<source>": "<sha>" } }`. Both live in the repo root.
- **Backup names:** `<backupDir>/<file>.<UTC YYYYMMDDTHHMMSSmmmZ>`, with a `-<n>` suffix if the name is taken.
- **Commits:** conventional-commit prefixes, one commit per task.
- **Commands:** run them from `packages/source-watch/`. `npm ci` is already done there and in `../profile-engine`.

## Review Focus

1. **Invalid existing file.** Pinning into a hand-broken `skill-pins.json` must leave it byte-for-byte intact and make no backup. Task 2 tests this.
2. **Undo of a first pin.** `previous` is `undefined`, and passing it back must remove the entry and restore the original text exactly. Task 2 tests this.
3. **Removing from an absent file.** It must not create a file. Task 2 tests this.
4. **Uppercase sha in `source-ignores.json`.** It must still match the report's lowercase `latest.sha`. Task 3 tests this.
5. **A full-sha target the watch cache has not fetched yet**, for example a commit pushed after the last watch. `pinImpact` must fetch it by id instead of reporting it missing. Task 4 tests this.

---

### Task 1: Format-preserving document edit

**Files:**
- Create: `packages/source-watch/src/documents.ts`
- Create: `packages/source-watch/checks/documents.spec.ts`
- Modify: `packages/source-watch/src/index.ts` (append export lines)

**Interfaces:**
- Produces:
  - `type Field = 'pins' | 'ignored'`
  - `type Edited = { readonly text: string; readonly previous?: string }`
  - `class DocumentInvalid extends Data.TaggedError('DocumentInvalid')<{ readonly reason: string }>`
  - `const PINS_FILE = 'skill-pins.json'`
  - `const IGNORES_FILE = 'source-ignores.json'`
  - `const FILES: Readonly<Record<Field, string>>`
  - `function readEntries(text: string, field: Field): Record<string, string>`, which throws `DocumentInvalid`
  - `function editEntry(text: string | undefined, field: Field, source: string, value: string | undefined): Edited`, which throws `DocumentInvalid`

- [ ] **Step 1: Write the failing test** at `checks/documents.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentInvalid, editEntry } from '../src/documents.ts';

const pins = (entries: object, indent: string | number = 2) =>
  JSON.stringify({ version: 1, pins: entries }, null, indent) + '\n';
const crlf = (text: string) => text.replace(/\n/g, '\r\n');

test('an absent file becomes a new document holding the entry', () => {
  assert.deepEqual(editEntry(undefined, 'pins', 'ada/skills', 'v1'), { text: pins({ 'ada/skills': 'v1' }) });
  assert.equal(
    editEntry(undefined, 'ignored', 'ada/skills', 'abc').text,
    JSON.stringify({ version: 1, ignored: { 'ada/skills': 'abc' } }, null, 2) + '\n',
  );
});

test('replacing an entry keeps its position and reports the old value', () => {
  assert.deepEqual(editEntry(pins({ a: '1', b: '2', c: '3' }), 'pins', 'b', '9'), {
    text: pins({ a: '1', b: '9', c: '3' }),
    previous: '2',
  });
});

test('a new entry is appended', () => {
  assert.deepEqual(editEntry(pins({ a: '1' }), 'pins', 'z', '2'), { text: pins({ a: '1', z: '2' }) });
});

test('removing an entry deletes only that key', () => {
  assert.deepEqual(editEntry(pins({ a: '1', b: '2' }), 'pins', 'a', undefined), { text: pins({ b: '2' }), previous: '1' });
  assert.deepEqual(editEntry(pins({ a: '1' }), 'pins', 'a', undefined), { text: pins({}), previous: '1' });
});

test('removing an absent entry or setting the same value returns the text unchanged', () => {
  const text = '{"version":1,"pins":{"a":"1"}}';
  assert.deepEqual(editEntry(text, 'pins', 'b', undefined), { text });
  assert.deepEqual(editEntry(text, 'pins', 'a', '1'), { text, previous: '1' });
});

test('unknown fields and their order are kept, and a missing field is appended', () => {
  const doc = (value: string) => JSON.stringify({ note: 'hi', version: 1, pins: { a: value }, extra: [1] }, null, 2) + '\n';
  assert.equal(editEntry(doc('1'), 'pins', 'a', '2').text, doc('2'));
  assert.equal(editEntry('{\n  "version": 1\n}\n', 'pins', 'a', '1').text, pins({ a: '1' }));
});

test('indentation, CRLF and a missing final newline are kept', () => {
  for (const indent of ['\t', '    ']) {
    assert.equal(editEntry(pins({ a: '1' }, indent), 'pins', 'a', '2').text, pins({ a: '2' }, indent));
  }
  assert.equal(editEntry(crlf(pins({ a: '1' })), 'pins', 'b', '2').text, crlf(pins({ a: '1', b: '2' })));
  assert.equal(editEntry(pins({ a: '1' }).trimEnd(), 'pins', 'a', '2').text, pins({ a: '2' }).trimEnd());
});

test('a compact document comes back with two-space indentation', () => {
  assert.equal(editEntry('{"version":1,"pins":{"a":"1"}}', 'pins', 'b', '2').text, pins({ a: '1', b: '2' }).trimEnd());
});

for (const [label, text, reason] of [
  ['text that is not JSON', '{', /^skill-pins\.json is not JSON/],
  ['an array', '[]', /^skill-pins\.json is not a JSON object$/],
  ['another version', '{"version":2,"pins":{}}', /^skill-pins\.json has a version other than 1$/],
  ['a field that is not an object', '{"version":1,"pins":[]}', /^skill-pins\.json pins is not an object$/],
  ['a value that is not a string', '{"version":1,"pins":{"a":1}}', /non-empty string keys and values$/],
  ['an empty value', '{"version":1,"pins":{"a":""}}', /non-empty string keys and values$/],
  ['an empty key', '{"version":1,"pins":{"":"v1"}}', /non-empty string keys and values$/],
] as const) {
  test(`a document with ${label} is refused`, () => {
    assert.throws(
      () => editEntry(text, 'pins', 'a', '1'),
      (error) => error instanceof DocumentInvalid && reason.test(error.reason),
    );
  });
}

test('an invalid ignores document names its own file', () => {
  assert.throws(
    () => editEntry('{', 'ignored', 'a', '1'),
    (error) => error instanceof DocumentInvalid && /^source-ignores\.json is not JSON/.test(error.reason),
  );
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `node --test checks/documents.spec.ts`
Expected: FAIL. It cannot find module `../src/documents.ts`.

- [ ] **Step 3: Implement** `src/documents.ts`:

```ts
import { Data } from 'effect';
import { redact } from './redact.ts';

// The author's decisions about sources, as repo documents: `pins` in skill-pins.json (source → ref)
// and `ignored` in source-ignores.json (source → sha).
export type Field = 'pins' | 'ignored';
export type Edited = { readonly text: string; readonly previous?: string }; // previous: the entry's old value

// A document that cannot be edited safely, or input that must not be written. `reason` is redacted.
export class DocumentInvalid extends Data.TaggedError('DocumentInvalid')<{ readonly reason: string }> {}

export const PINS_FILE = 'skill-pins.json';
export const IGNORES_FILE = 'source-ignores.json';
export const FILES: Readonly<Record<Field, string>> = { pins: PINS_FILE, ignored: IGNORES_FILE };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (field: Field, problem: string) =>
  new DocumentInvalid({ reason: redact(`${FILES[field]} ${problem}`) });

// The whole document, checked the way the profile engine reads skill-pins.json.
function parse(text: string, field: Field): Json {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw invalid(field, `is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(document)) throw invalid(field, 'is not a JSON object');
  if (document.version !== 1) throw invalid(field, 'has a version other than 1');
  const entries = document[field];
  if (entries === undefined) return document;
  if (!isObject(entries)) throw invalid(field, `${field} is not an object`);
  for (const [key, value] of Object.entries(entries)) {
    if (key === '' || typeof value !== 'string' || value === '') {
      throw invalid(field, `${field} needs non-empty string keys and values`);
    }
  }
  return document;
}

// A document's entries; throws DocumentInvalid when the document is not valid.
export function readEntries(text: string, field: Field): Record<string, string> {
  return { ...((parse(text, field)[field] as Record<string, string> | undefined) ?? {}) };
}

// Sets (or, with `value` undefined, removes) one source's entry. Pure; throws DocumentInvalid
// rather than touch an invalid document. Key order, unknown fields, indentation, line endings
// and the final newline are kept. An absent document starts as `{ version: 1, <field>: {} }`.
export function editEntry(text: string | undefined, field: Field, source: string, value: string | undefined): Edited {
  const original = text ?? JSON.stringify({ version: 1, [field]: {} }, null, 2) + '\n';
  const document = parse(original, field);
  const entries = { ...((document[field] as Record<string, string> | undefined) ?? {}) };
  const previous = Object.hasOwn(entries, source) ? entries[source] : undefined;
  const edited = (next: string): Edited => (previous === undefined ? { text: next } : { text: next, previous });
  if (value === previous) return edited(original);

  if (value === undefined) delete entries[source];
  else entries[source] = value;

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(original)?.[1] ?? '  ';
  let next = JSON.stringify({ ...document, [field]: entries }, null, indent);
  if (eol === '\r\n') next = next.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(original)) next += eol;
  return edited(next);
}
```

Append to `src/index.ts`:

```ts
export { DocumentInvalid, IGNORES_FILE, PINS_FILE, editEntry } from './documents.ts';
export type { Edited, Field } from './documents.ts';
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test checks/documents.spec.ts && npm run typecheck`
Expected: every test passes, and the typecheck reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/documents.ts checks/documents.spec.ts src/index.ts
git commit -m "feat: format-preserving edit of pin and ignore documents"
```

---

### Task 2: Backed-up writes: `pinSource` and `ignoreRevision`

**Files:**
- Modify: `packages/source-watch/src/documents.ts`, which this branch created in Task 1. Append the writer.
- Create: `packages/source-watch/src/pins.ts`
- Create: `packages/source-watch/src/ignores.ts`
- Create: `packages/source-watch/checks/writes.spec.ts`
- Modify: `packages/source-watch/src/index.ts`

**Interfaces:**
- Consumes: `Field`, `FILES`, `DocumentInvalid`, `editEntry` (Task 1)
- Produces:
  - `type WriteOptions = { readonly backupDir: string }`
  - `type Written = { readonly previous?: string; readonly backup?: string }`
  - `class WriteFailed extends Data.TaggedError('WriteFailed')<{ readonly reason: string }>`
  - `writeEntry(repoDir: string, field: Field, source: string, value: string | undefined, options: WriteOptions): Effect.Effect<Written, DocumentInvalid | WriteFailed>`, in `documents.ts`
  - `pinSource(repoDir: string, source: string, ref: string | undefined, options: WriteOptions): Effect.Effect<Written, DocumentInvalid | WriteFailed>`, in `pins.ts`
  - `ignoreRevision(repoDir: string, source: string, sha: string | undefined, options: WriteOptions): Effect.Effect<Written, DocumentInvalid | WriteFailed>`, in `ignores.ts`

- [ ] **Step 1: Write the failing test** at `checks/writes.spec.ts`:

```ts
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { ignoreRevision } from '../src/ignores.ts';
import { pinSource } from '../src/pins.ts';
import { tempDir } from './fixtures.ts';

const SHA = 'a'.repeat(40);
const pins = (entries: object) => JSON.stringify({ version: 1, pins: entries }, null, 2) + '\n';
const ignored = (entries: object) => JSON.stringify({ version: 1, ignored: entries }, null, 2) + '\n';

function setup(t: TestContext, pinsText?: string) {
  const root = tempDir(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  if (pinsText !== undefined) writeFileSync(join(repo, 'skill-pins.json'), pinsText);
  return { root, repo, options: { backupDir: join(root, 'backups') } };
}
const read = (repo: string, file = 'skill-pins.json') => readFileSync(join(repo, file), 'utf8');
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

test('pinning in a repo without a pin file creates it, with no backup', async (t) => {
  const { repo, options } = setup(t);
  assert.deepEqual(await Effect.runPromise(pinSource(repo, 'ada/skills', 'v1', options)), {});
  assert.equal(read(repo), pins({ 'ada/skills': 'v1' }));
  assert.equal(existsSync(options.backupDir), false);
  assert.deepEqual(readdirSync(repo), ['skill-pins.json']);
});

test('changing a pin backs up the old file first and reports the previous ref', async (t) => {
  const original = pins({ 'ada/skills': 'v1', 'bob/tools': 'v3' });
  const { repo, options } = setup(t, original);
  const written = await Effect.runPromise(pinSource(repo, 'ada/skills', 'v2', options));
  assert.equal(written.previous, 'v1');
  assert.match(written.backup!, /skill-pins\.json\.\d{8}T\d{9}Z(-\d+)?$/);
  assert.ok(written.backup!.startsWith(options.backupDir));
  assert.equal(readFileSync(written.backup!, 'utf8'), original);
  assert.equal(read(repo), pins({ 'ada/skills': 'v2', 'bob/tools': 'v3' }));
  assert.deepEqual(readdirSync(repo), ['skill-pins.json']);
});

test('calling again with the previous value undoes a change and a first pin', async (t) => {
  const original = pins({ 'ada/skills': 'v1', 'bob/tools': 'v3' });
  const { repo, options } = setup(t, original);
  const changed = await Effect.runPromise(pinSource(repo, 'ada/skills', 'v2', options));
  await Effect.runPromise(pinSource(repo, 'ada/skills', changed.previous, options));
  assert.equal(read(repo), original);

  const first = await Effect.runPromise(pinSource(repo, 'new/source', 'v9', options));
  assert.equal(first.previous, undefined);
  await Effect.runPromise(pinSource(repo, 'new/source', first.previous, options));
  assert.equal(read(repo), original);
});

test('two changes in a row keep two distinct backups', async (t) => {
  const { repo, options } = setup(t, pins({ a: 'v1' }));
  const one = await Effect.runPromise(pinSource(repo, 'a', 'v2', options));
  const two = await Effect.runPromise(pinSource(repo, 'a', 'v3', options));
  assert.notEqual(one.backup, two.backup);
  assert.equal(readdirSync(options.backupDir).length, 2);
  assert.equal(readFileSync(two.backup!, 'utf8'), pins({ a: 'v2' }));
});

test('an unchanged pin, or removing a pin from a repo without a pin file, writes nothing', async (t) => {
  const { repo, options } = setup(t, pins({ a: 'v1' }));
  assert.deepEqual(await Effect.runPromise(pinSource(repo, 'a', 'v1', options)), { previous: 'v1' });
  assert.equal(existsSync(options.backupDir), false);

  const empty = setup(t);
  assert.deepEqual(await Effect.runPromise(pinSource(empty.repo, 'a', undefined, empty.options)), {});
  assert.equal(existsSync(join(empty.repo, 'skill-pins.json')), false);
});

test('an invalid pin file is left untouched and not backed up', async (t) => {
  const broken = '{"version":2,"pins":{"a":"v1"}}';
  const { repo, options } = setup(t, broken);
  const error = await failure(pinSource(repo, 'a', 'v2', options));
  assert.equal(error._tag, 'DocumentInvalid');
  assert.equal(read(repo), broken);
  assert.equal(existsSync(options.backupDir), false);
});

test('empty sources and refs that are empty or read as options are refused', async (t) => {
  const { repo, options } = setup(t);
  for (const [source, ref] of [['a', ''], ['a', '--upload-pack=x'], ['', 'v1']] as const) {
    const error = await failure(pinSource(repo, source, ref, options));
    assert.equal(error._tag, 'DocumentInvalid');
  }
  assert.deepEqual(readdirSync(repo), []);
});

test('a write that cannot happen is a WriteFailed', async (t) => {
  const { root, options } = setup(t);
  const error = await failure(pinSource(join(root, 'missing'), 'a', 'v1', options));
  assert.equal(error._tag, 'WriteFailed');
});

test('ignoring a revision writes source-ignores.json, and removing it backs up first', async (t) => {
  const { repo, options } = setup(t);
  assert.deepEqual(await Effect.runPromise(ignoreRevision(repo, 'ada/skills', SHA, options)), {});
  assert.equal(read(repo, 'source-ignores.json'), ignored({ 'ada/skills': SHA }));

  const removed = await Effect.runPromise(ignoreRevision(repo, 'ada/skills', undefined, options));
  assert.equal(removed.previous, SHA);
  assert.match(removed.backup!, /source-ignores\.json\.\d{8}T\d{9}Z(-\d+)?$/);
  assert.equal(read(repo, 'source-ignores.json'), ignored({}));
});

test('only full commit shas can be ignored', async (t) => {
  const { repo, options } = setup(t);
  for (const sha of ['v1', 'abc123', 'g'.repeat(40)]) {
    const error = await failure(ignoreRevision(repo, 'a', sha, options));
    assert.equal(error._tag, 'DocumentInvalid');
  }
  await Effect.runPromise(ignoreRevision(repo, 'a', 'B'.repeat(40), options));
  await Effect.runPromise(ignoreRevision(repo, 'b', 'c'.repeat(64), options));
  assert.equal(read(repo, 'source-ignores.json'), ignored({ a: 'B'.repeat(40), b: 'c'.repeat(64) }));
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `node --test checks/writes.spec.ts`
Expected: FAIL. It cannot find module `../src/ignores.ts`.

- [ ] **Step 3: Implement.** Append to `src/documents.ts`, merging the new imports into the top of the file:

```ts
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Data, Effect } from 'effect';
```

```ts
export type WriteOptions = { readonly backupDir: string }; // where the old file is copied first
export type Written = { readonly previous?: string; readonly backup?: string }; // backup: absolute path

// Reading, backing up or replacing a document failed. `reason` is redacted.
export class WriteFailed extends Data.TaggedError('WriteFailed')<{ readonly reason: string }> {}

const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) => new WriteFailed({ reason: redact(error instanceof Error ? error.message : String(error)) }),
  });

const readText = (path: string) =>
  readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? undefined : Promise.reject(error),
  );

// Copies the file to `<dir>/<name>.<UTC timestamp>`, adding `-<n>` when that name is taken.
async function backUp(path: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${basename(path)}.${new Date().toISOString().replace(/[-:.]/g, '')}`);
  for (let n = 0; ; n++) {
    const target = n === 0 ? base : `${base}-${n}`;
    try {
      await copyFile(path, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

// Writes beside the file, then renames over it, so no reader sees a half-written document.
async function replace(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Sets or removes one source's entry in the repo's document for `field`. The existing file is
// backed up before it changes; an invalid document is never rewritten; an edit that changes
// nothing writes nothing. Undo by calling again with the returned `previous`.
export const writeEntry = (
  repoDir: string,
  field: Field,
  source: string,
  value: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  Effect.gen(function* () {
    if (source === '') return yield* Effect.fail(invalid(field, 'cannot hold an empty source'));
    const path = join(repoDir, FILES[field]);
    const old = yield* io(() => readText(path));
    const { text, previous } = yield* Effect.try({
      try: () => editEntry(old, field, source, value),
      catch: (error) =>
        error instanceof DocumentInvalid ? error : new DocumentInvalid({ reason: redact(String(error)) }),
    });
    const unchanged = previous === undefined ? {} : { previous };
    if (text === old || (old === undefined && value === undefined)) return unchanged;
    const backup = old === undefined ? undefined : yield* io(() => backUp(path, options.backupDir));
    yield* io(() => replace(path, text));
    return backup === undefined ? unchanged : { ...unchanged, backup };
  });
```

Create `src/pins.ts`:

```ts
import { Effect } from 'effect';
import { DocumentInvalid, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';

// Brings a revision into the setup: pins `source` to `ref` in skill-pins.json, or unpins it when
// `ref` is undefined. The pin moves every skill from that source; preview with `pinImpact`.
export const pinSource = (
  repoDir: string,
  source: string,
  ref: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  ref !== undefined && (ref === '' || ref.startsWith('-'))
    ? Effect.fail(new DocumentInvalid({ reason: redact(`'${ref}' cannot be pinned`) }))
    : writeEntry(repoDir, 'pins', source, ref, options);
```

Create `src/ignores.ts`:

```ts
import { Effect } from 'effect';
import { DocumentInvalid, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// Records that the author has seen `sha` (a source's latest revision) and does not want it
// flagged; undefined clears the source's entry. One sha per source, in source-ignores.json.
export const ignoreRevision = (
  repoDir: string,
  source: string,
  sha: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  sha !== undefined && !FULL_SHA.test(sha)
    ? Effect.fail(new DocumentInvalid({ reason: redact(`'${sha}' is not a full commit sha`) }))
    : writeEntry(repoDir, 'ignored', source, sha, options);
```

In `src/index.ts`, replace the two lines Task 1 added with:

```ts
export { DocumentInvalid, IGNORES_FILE, PINS_FILE, WriteFailed, editEntry } from './documents.ts';
export type { Edited, Field, WriteOptions, Written } from './documents.ts';
export { pinSource } from './pins.ts';
export { ignoreRevision } from './ignores.ts';
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test checks/writes.spec.ts checks/documents.spec.ts && npm run typecheck`
Expected: every test passes, and the typecheck reports no errors. If `import { ..., type X, ... }` trips `verbatimModuleSyntax`, split it into separate `import type` lines.

- [ ] **Step 5: Commit**

```bash
git add src/documents.ts src/pins.ts src/ignores.ts checks/writes.spec.ts src/index.ts
git commit -m "feat: pin a source or ignore a revision, backing up the document first"
```

---

### Task 3: Read ignores and flag ignored reports

**Files:**
- Modify: `packages/source-watch/src/ignores.ts`, which Task 2 created
- Create: `packages/source-watch/checks/ignores.spec.ts`
- Modify: `packages/source-watch/src/index.ts`

**Interfaces:**
- Consumes: `readEntries`, `DocumentInvalid` (Task 1), and `SourceReport` from `src/model.ts`
- Produces:
  - `type Ignores = Readonly<Record<string, string>>`
  - `readIgnores(text: string | undefined): { readonly ignores: Ignores; readonly problem?: string }`
  - `isIgnored(report: SourceReport, ignores: Ignores): boolean`

- [ ] **Step 1: Write the failing test** at `checks/ignores.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, readIgnores } from '../src/ignores.ts';
import type { SourceReport, SourceStatus } from '../src/model.ts';

const SHA = 'c'.repeat(40);
const report = (status: SourceStatus, sha: string | undefined = SHA, source = 'ada/skills'): SourceReport => ({
  source,
  url: 'https://github.com/ada/skills.git',
  status,
  ...(sha === undefined ? {} : { latest: { sha, date: '2026-01-01T00:00:00Z', tags: [] } }),
  commits: [],
  skills: [],
  added: [],
});

test('an absent ignores file ignores nothing', () => {
  assert.deepEqual(readIgnores(undefined), { ignores: {} });
});

test('a valid ignores file maps each source to its ignored sha', () => {
  const text = JSON.stringify({ version: 1, ignored: { 'ada/skills': SHA } });
  assert.deepEqual(readIgnores(text), { ignores: { 'ada/skills': SHA } });
  assert.deepEqual(readIgnores('{"version":1}'), { ignores: {} });
});

test('an invalid ignores file ignores nothing and says why', () => {
  const { ignores, problem } = readIgnores('{');
  assert.deepEqual(ignores, {});
  assert.match(problem!, /^source-ignores\.json is not JSON/);
});

test('a new revision equal to the ignored sha is ignored', () => {
  const ignores = { 'ada/skills': SHA };
  assert.equal(isIgnored(report('ahead'), ignores), true);
  assert.equal(isIgnored(report('diverged'), ignores), true);
  assert.equal(isIgnored(report('ahead'), { 'ada/skills': SHA.toUpperCase() }), true);
});

test('anything else is not ignored', () => {
  const ignores = { 'ada/skills': SHA };
  for (const status of ['up-to-date', 'unpinned', 'baseline-missing', 'unreachable'] as const) {
    assert.equal(isIgnored(report(status), ignores), false, status);
  }
  assert.equal(isIgnored(report('ahead', 'd'.repeat(40)), ignores), false, 'upstream moved on');
  assert.equal(isIgnored(report('ahead', SHA, 'bob/tools'), ignores), false, 'another source');
  assert.equal(isIgnored(report('ahead', undefined), ignores), false, 'no latest');
  assert.equal(isIgnored(report('ahead'), {}), false, 'nothing ignored');
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `node --test checks/ignores.spec.ts`
Expected: FAIL. `readIgnores` is not exported, so the import fails or the call is not a function.

- [ ] **Step 3: Implement.** Add to `src/ignores.ts`, extending its imports with `readEntries` from `./documents.ts` and `import type { SourceReport } from './model.ts';`:

```ts
export type Ignores = Readonly<Record<string, string>>; // source → ignored sha

// The ignored revisions in source-ignores.json. Lenient like the engine's pin reader: an absent
// or invalid file ignores nothing, and an invalid one says why.
export function readIgnores(text: string | undefined): { readonly ignores: Ignores; readonly problem?: string } {
  if (text === undefined) return { ignores: {} };
  try {
    return { ignores: readEntries(text, 'ignored') };
  } catch (error) {
    if (error instanceof DocumentInvalid) return { ignores: {}, problem: error.reason };
    throw error;
  }
}

// Whether a report's new revision is one the author ignored. Only `ahead` and `diverged` reports
// flag something new; once upstream moves past the ignored sha, it is flagged again.
export function isIgnored(report: SourceReport, ignores: Ignores): boolean {
  if (report.status !== 'ahead' && report.status !== 'diverged') return false;
  const sha = Object.hasOwn(ignores, report.source) ? ignores[report.source] : undefined;
  return sha !== undefined && report.latest?.sha.toLowerCase() === sha.toLowerCase();
}
```

In `src/index.ts`, replace `export { ignoreRevision } from './ignores.ts';` with:

```ts
export { ignoreRevision, isIgnored, readIgnores } from './ignores.ts';
export type { Ignores } from './ignores.ts';
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test checks/ignores.spec.ts checks/writes.spec.ts && npm run typecheck`
Expected: every test passes, and the typecheck reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ignores.ts checks/ignores.spec.ts src/index.ts
git commit -m "feat: read ignored revisions and flag ignored source reports"
```

---

### Task 4: Pin impact preview

**Files:**
- Create: `packages/source-watch/src/impact.ts`
- Create: `packages/source-watch/checks/impact.spec.ts`
- Modify: `packages/source-watch/src/index.ts`

**Interfaces:**
- Consumes:
  - `Git` and `GitFailed` from `src/git.ts`
  - `skillFolders(paths: Iterable<string>): Map<string, string>` from `src/discover.ts`
  - `cacheFolder(cacheDir: string, url: string): string` from `src/upstream.ts`
  - `WatchedSource` from `src/model.ts`
  - `redact` from `src/redact.ts`
  - `makeRepo`, `runGit` and `tempDir` from `checks/fixtures.ts`
- Produces:
  - `type SkillMove = { readonly name: string; readonly status: 'unchanged' | 'changed' | 'removed' | 'missing' }`
  - `type PinImpact = { readonly source: string; readonly from?: { readonly ref: string; readonly sha: string }; readonly to: { readonly ref: string; readonly sha: string }; readonly skills: ReadonlyArray<SkillMove> }`
  - `class RefMissing extends Data.TaggedError('RefMissing')<{ readonly reason: string }>`
  - `pinImpact(source: WatchedSource, ref: string, options: { readonly cacheDir: string }): Effect.Effect<PinImpact, GitFailed | RefMissing, Git>`

- [ ] **Step 1: Write the failing test** at `checks/impact.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Effect } from 'effect';
import { pinImpact } from '../src/impact.ts';
import type { WatchedSource } from '../src/model.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 has tdd, grill and plan; c2 changes tdd; v2 removes grill and adds fresh; c4 is a README.
function history(root: string) {
  const repo = makeRepo(root);
  const c1 = repo.commit('add skills', {
    'skills/tdd/SKILL.md': 'tdd v1\n',
    'skills/grill/SKILL.md': 'grill v1\n',
    'skills/plan/SKILL.md': 'plan v1\n',
  });
  repo.tag('v1');
  const c2 = repo.commit('tune tdd', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const c3 = repo.commit('swap skills', { 'skills/grill': null, 'skills/fresh/SKILL.md': 'fresh\n' });
  repo.tag('v2');
  const c4 = repo.commit('readme', { 'README.md': 'hi\n' });
  return { repo, c1, c2, c3, c4 };
}

const watched = (url: string, baseline?: string): WatchedSource => ({
  source: 'ada/skills',
  url,
  exact: false,
  skills: ['tdd', 'grill', 'plan', 'fresh', 'ghost'],
  ...(baseline === undefined ? {} : { baseline }),
});
const impact = (root: string, source: WatchedSource, ref: string) =>
  runGit(pinImpact(source, ref, { cacheDir: join(root, 'cache') }));
const statuses = (result: { skills: ReadonlyArray<{ name: string; status: string }> }) =>
  result.skills.map((s) => [s.name, s.status]);

test('moving a pin to an intermediate commit moves only the skills changed by then', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2 } = history(root);
  const result = await impact(root, watched(repo.url, 'v1'), c2);
  assert.equal(result.source, 'ada/skills');
  assert.deepEqual(result.from, { ref: 'v1', sha: c1 });
  assert.deepEqual(result.to, { ref: c2, sha: c2 });
  assert.deepEqual(statuses(result), [
    ['tdd', 'changed'], ['grill', 'unchanged'], ['plan', 'unchanged'], ['fresh', 'missing'], ['ghost', 'missing'],
  ]);
});

test('moving a pin to a tag reports removed and newly present skills', async (t) => {
  const root = tempDir(t);
  const { repo, c3 } = history(root);
  const result = await impact(root, watched(repo.url, 'v1'), 'v2');
  assert.deepEqual(result.to, { ref: 'v2', sha: c3 });
  assert.deepEqual(statuses(result), [
    ['tdd', 'changed'], ['grill', 'removed'], ['plan', 'unchanged'], ['fresh', 'changed'], ['ghost', 'missing'],
  ]);
});

test('an unpinned source compares against HEAD and has no from', async (t) => {
  const root = tempDir(t);
  const { repo, c2 } = history(root);
  const result = await impact(root, watched(repo.url), c2);
  assert.equal(result.from, undefined);
  assert.deepEqual(statuses(result), [
    ['tdd', 'unchanged'], ['grill', 'changed'], ['plan', 'unchanged'], ['fresh', 'removed'], ['ghost', 'missing'],
  ]);
});

test('a full sha pushed after the cache was made is fetched by id', async (t) => {
  const root = tempDir(t);
  const { repo, c4 } = history(root);
  await impact(root, watched(repo.url, 'v1'), c4);
  const c5 = repo.commit('tune plan', { 'skills/plan/SKILL.md': 'plan v2\n' });
  const result = await impact(root, watched(repo.url, 'v1'), c5);
  assert.equal(result.to.sha, c5);
  assert.deepEqual(statuses(result).find(([name]) => name === 'plan'), ['plan', 'changed']);
});

test('a target or baseline that does not resolve is RefMissing', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  for (const [baseline, ref, named] of [
    ['v1', 'nope', 'nope'],
    ['v1', '--upload-pack=x', '--upload-pack=x'],
    ['gone', 'v2', 'gone'],
  ] as const) {
    const error = await runGit(Effect.flip(pinImpact(watched(repo.url, baseline), ref, { cacheDir: join(root, 'cache') })));
    assert.equal(error._tag, 'RefMissing');
    assert.ok(error.reason.includes(`'${named}'`), error.reason);
  }
});

test('a source that cannot be cloned fails with a redacted GitFailed', async (t) => {
  const root = tempDir(t);
  const source = watched(`file://${root}/nope?token=s3cret`, 'v1');
  const error = await runGit(Effect.flip(pinImpact(source, 'v2', { cacheDir: join(root, 'cache') })));
  assert.equal(error._tag, 'GitFailed');
  assert.ok(!error.reason.includes('s3cret'), error.reason);
});
```

- [ ] **Step 2: Run the test and check it fails**

Run: `node --test checks/impact.spec.ts`
Expected: FAIL. It cannot find module `../src/impact.ts`.

- [ ] **Step 3: Implement** `src/impact.ts`:

```ts
import { existsSync } from 'node:fs';
import { Data, Effect } from 'effect';
import { skillFolders } from './discover.ts';
import { Git, type GitFailed } from './git.ts';
import type { WatchedSource } from './model.ts';
import { redact } from './redact.ts';
import { cacheFolder } from './upstream.ts';

export type SkillMove = { readonly name: string; readonly status: 'unchanged' | 'changed' | 'removed' | 'missing' };
export type PinImpact = {
  readonly source: string; // redacted
  readonly from?: { readonly ref: string; readonly sha: string }; // absent when unpinned: compared against HEAD
  readonly to: { readonly ref: string; readonly sha: string };
  readonly skills: ReadonlyArray<SkillMove>; // every declared skill, in declared order
};

// A pin's target or baseline is not a commit in the source. `reason` is redacted.
export class RefMissing extends Data.TaggedError('RefMissing')<{ readonly reason: string }> {}

type Run = (args: ReadonlyArray<string>, ok?: ReadonlyArray<number>) => Effect.Effect<string, GitFailed>;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// What pinning `source` to `ref` does to each of its declared skills, compared with its current
// pin (or HEAD, which an unpinned source installs). Pins are per source, so one skill's update
// moves them all. Reuses the watcher's cache, cloning it when absent and never refreshing it,
// except to fetch a full-sha target or baseline by id.
export const pinImpact = (
  source: WatchedSource,
  ref: string,
  options: { readonly cacheDir: string },
): Effect.Effect<PinImpact, GitFailed | RefMissing, Git> =>
  Effect.gen(function* () {
    const git = yield* Git;
    const dir = cacheFolder(options.cacheDir, source.url);
    const run: Run = (args, ok) => git.run(args, ok === undefined ? { cwd: dir } : { cwd: dir, ok });
    if (!existsSync(dir)) yield* git.run(['clone', '--bare', '--filter=blob:none', '--quiet', '--', source.url, dir]);

    const resolve = (rev: string) =>
      findCommit(run, rev).pipe(
        Effect.flatMap((sha) =>
          sha === undefined
            ? Effect.fail(new RefMissing({ reason: redact(`'${rev}' is not in ${source.url}`) }))
            : Effect.succeed(sha),
        ),
      );
    const to = yield* resolve(ref);
    const from = source.baseline === undefined ? (yield* run(['rev-parse', 'HEAD'])).trim() : yield* resolve(source.baseline);

    const before = yield* skillsAt(run, from);
    const after = yield* skillsAt(run, to);
    const skills = yield* Effect.forEach(source.skills, (name) =>
      move(run, from, to, before.get(name), after.get(name)).pipe(Effect.map((status): SkillMove => ({ name, status }))),
    );
    return {
      source: redact(source.source),
      ...(source.baseline === undefined ? {} : { from: { ref: source.baseline, sha: from } }),
      to: { ref, sha: to },
      skills,
    } satisfies PinImpact;
  });

// The watcher's rule: a ref git could read as an option is never passed to it, and a full sha
// the cache lacks is fetched by id once.
const findCommit = (run: Run, ref: string): Effect.Effect<string | undefined, GitFailed> =>
  Effect.gen(function* () {
    if (ref.startsWith('-')) return undefined;
    const resolve = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1]).pipe(
      Effect.map((out) => out.trim()),
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

// One skill between two revisions, given its folder at each (undefined when absent).
const move = (
  run: Run,
  from: string,
  to: string,
  before: string | undefined,
  after: string | undefined,
): Effect.Effect<SkillMove['status'], GitFailed> =>
  Effect.gen(function* () {
    if (after === undefined) return before === undefined ? 'missing' : 'removed';
    if (before === undefined) return 'changed';
    const tree = (sha: string, path: string) => run(['rev-parse', `${sha}:${path}`]).pipe(Effect.map((out) => out.trim()));
    return (yield* tree(from, before)) === (yield* tree(to, after)) ? 'unchanged' : 'changed';
  });
```

Append to `src/index.ts`:

```ts
export { RefMissing, pinImpact } from './impact.ts';
export type { PinImpact, SkillMove } from './impact.ts';
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `node --test checks/impact.spec.ts && npm run typecheck`
Expected: every test passes, and the typecheck reports no errors. If the fetch-by-id test fails because the fixture's upstream refuses unadvertised shas, check how `checks/upstream.spec.ts` tests a sha baseline the clone lacks, and set the same upstream config in that one test.

- [ ] **Step 5: Commit**

```bash
git add src/impact.ts checks/impact.spec.ts src/index.ts
git commit -m "feat: preview which declared skills a pin change moves"
```

---

### Task 5: Full verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run the package suite and typecheck**

Run: `npm test && npm run typecheck`, from `packages/source-watch/`
Expected: every check passes, the 40 existing ones plus the new ones, and the typecheck reports no errors.

- [ ] **Step 2: Run the root suite**

Run: `npm test`, from the repository root
Expected: it passes.

- [ ] **Step 3: Check the scope of the change**

Run: `git diff main...HEAD --stat`
Expected: changes only in `docs/superpowers/`, in new files under `packages/source-watch/src/` and `packages/source-watch/checks/`, and in `packages/source-watch/src/index.ts`.
