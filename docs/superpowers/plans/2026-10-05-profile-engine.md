# Profile Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared TypeScript/Effect 4 package that resolves a machine's desired configuration from a base profile, revision pins and machine overrides, records the provenance of every value, and agrees with the current CLI on this repository's files.

**Architecture:** Pure readers turn each document into data plus issues. A pure `resolveProfile` layers base → pins → machine and stamps every value with an `Origin`. Effect owns only loading, through a small `ProfileFiles` service with a Node layer and an in-memory layer. Golden tests import the CLI's own `src/*.mjs` modules as the oracle.

**Tech Stack:** TypeScript (erasable syntax only, run directly by Node 24's type stripping), `effect@4.0.1` (Schema, Context, Layer, Data), `node:test`, `typescript@7.0.2` for typechecking.

**Spec:** `docs/superpowers/specs/2026-10-05-profile-engine-design.md`

## Global Constraints

- Package lives at `packages/profile-engine/`, independent npm package with its own `package-lock.json`; the root `package.json` is not modified.
- Runtime dependency: exactly `"effect": "4.0.1"`. Dev: exactly `"typescript": "7.0.2"`, `"@types/node": "25.5.0"`. Nothing else.
- `engines.node` is `">=22.18"`. No build step; sources are `.ts`, relative imports carry `.ts` extensions, `erasableSyntaxOnly` is on (no enums, namespaces, parameter properties).
- Tests use `node:test` and `node:assert/strict` only, in `packages/profile-engine/checks/*.spec.ts` (not `test/`, so the root `node --test` does not discover them).
- Run package tests with `npm test` from `packages/profile-engine` (`node --test "checks/*.spec.ts"`); typecheck with `npm run typecheck`.
- Root suite: `NORTUSCC_REPO_DIR=$PWD npm test` from the repo root; baseline is 725/725 passing.
- Comments state purpose or contract, not narration. Conventional-commit prefixes. Commit after every task. Never stage files outside the task.
- Layer names: `'base' | 'pin' | 'machine'`. Origin sources: `'built-in'` (file table), `'skills-manifest.txt'`, `'integrations.json'`, the settings file's repo path (`'claude/settings.keys.json'`), `'skill-pins.json'`, and the overrides input's `source` (e.g. `'state.json'`).

## Review Focus

- A machine override naming something the base does not declare (unknown skill, integration id, settings document or key) must surface as an issue and change nothing — never a silent no-op or a new owned key. (Task 6 tests.)
- The same skill name listed under two sources must resolve as two entries, each with its own source and pin, and a skill override must apply to both. (Task 6 test.)
- A settings override whose value hides a credential inside a nested object must be refused, keeping the base value. (Task 6 test.)
- A refused `claude/settings.keys.json` combined with overrides of its keys must yield no keys plus one issue per overridden key, not a crash. (Task 6 test.)
- An unreadable file (e.g. a directory where a file is expected) must fail with `ReadFailed`, distinct from an absent file resolving as "nothing declared". (Task 7 test.)

---

## File Structure

```
packages/profile-engine/
  package.json, package-lock.json, tsconfig.json, README.md
  src/model.ts         types and closed lists shared by every module
  src/issues.ts        issue constructor, JSON parse and Schema decode helpers
  src/secrets.ts       port of src/secrets.mjs + nested walk from src/settings-keys.mjs
  src/skills.ts        skills-manifest.txt reader
  src/pins.ts          skill-pins.json reader
  src/files.ts         built-in managed-file table (SYNC as data)
  src/settings.ts      merge-keys document reader (settings.keys.json)
  src/integrations.ts  integrations.json reader (port of the CLI validator)
  src/overrides.ts     MachineOverrides decoder + legacy state.json adapter
  src/base.ts          assembles the base profile from document texts
  src/resolve.ts       pure layering with provenance
  src/errors.ts        ReadFailed, ProfileInvalid
  src/load.ts          ProfileFiles service, nodeFiles, memoryFiles, loadProfile, requireValid
  src/index.ts         public exports
  checks/*.spec.ts     unit and golden tests
```

---

### Task 1: Package scaffold, model, issue helpers and secret checks

**Files:**
- Create: `packages/profile-engine/package.json`, `packages/profile-engine/tsconfig.json`, `packages/profile-engine/src/model.ts`, `packages/profile-engine/src/issues.ts`, `packages/profile-engine/src/secrets.ts`
- Test: `packages/profile-engine/checks/secrets.spec.ts`, `packages/profile-engine/checks/issues.spec.ts`
- Generated: `packages/profile-engine/package-lock.json`

**Interfaces:**
- Produces (`model.ts`): `TARGETS`, `Target`, `Home`, `CATEGORIES`, `Category`, `LayerName`, `Origin`, `Issue`, `Input<T>`, `FileEntry`, `SkillGroup`, `Integration`, `Allow`, `Settings`, `BaseProfile`, `Pins`, `MachineOverrides`, `ResolvedFile`, `ResolvedSkill`, `ResolvedIntegration`, `DesiredConfig` — exactly as written below.
- Produces (`issues.ts`): `issue(layer, source, path, message): Issue`; `parseJson(text, layer, source): { ok: true; value: unknown } | { ok: false; issue: Issue }`; `decode<T>(schema: Schema.Codec<T, unknown>, value, layer, source): { ok: true; value: T } | { ok: false; issue: Issue }`; `isPlainObject(value): value is Record<string, unknown>`.
- Produces (`secrets.ts`): `looksLikeSecretName(name: string): boolean`; `looksLikeSecretValue(text: string): boolean`; `nestedSecretComplaints(value: unknown, path: string): string[]`.

- [ ] **Step 1: Create package files**

`packages/profile-engine/package.json`:

```json
{
  "name": "@nortuscc/profile-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Resolves a machine's desired agent configuration from a base profile, revision pins and machine overrides, with provenance",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "node --test \"checks/*.spec.ts\"",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "effect": "4.0.1"
  },
  "devDependencies": {
    "@types/node": "25.5.0",
    "typescript": "7.0.2"
  },
  "engines": {
    "node": ">=22.18"
  }
}
```

`packages/profile-engine/tsconfig.json`:

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

Run: `cd packages/profile-engine && npm install`
Expected: creates `node_modules/` (ignored by the root `.gitignore`) and `package-lock.json`.

- [ ] **Step 2: Write `src/model.ts`** (types only; needed by the tests' imports)

```ts
// The shared vocabulary of a profile: what each layer declares and what resolution produces.

export const TARGETS = ['claude', 'codex'] as const;
export type Target = (typeof TARGETS)[number];
// The agent home a file lands in. Usually its target; the OpenRouter Codex home is separate.
export type Home = Target | 'codex-openrouter';

// The categories an `allow` list may name, matching the CLI's OBSERVED_CATEGORIES.
export const CATEGORIES = ['agents', 'plugins', 'marketplaces', 'hooks', 'skills'] as const;
export type Category = (typeof CATEGORIES)[number];

export type LayerName = 'base' | 'pin' | 'machine';
// Which layer decided a value, and the document (or 'built-in' table) it came from.
export type Origin = { readonly layer: LayerName; readonly source: string };
export type Issue = {
  readonly layer: LayerName;
  readonly source: string;
  readonly path: string;
  readonly message: string;
};
// A decoded layer input together with where it came from and what was wrong with it.
export type Input<T> = { readonly value: T; readonly source: string; readonly issues: ReadonlyArray<Issue> };

export type FileEntry = {
  readonly id: string;
  readonly target: Target;
  readonly home: Home;
  readonly src: string;
  readonly dest: string;
  readonly mode: 'copy' | 'merge-keys';
  readonly preserveProjects: boolean;
  readonly capture: boolean;
};
export type SkillGroup = { source: string; skills: string[]; exact: boolean; optional: boolean };
export type Integration = { readonly id: string; readonly default: boolean; readonly [field: string]: unknown };
export type Allow = Partial<Record<Category, ReadonlyArray<string>>>;
export type Settings = Readonly<Record<string, unknown>>;

export type BaseProfile = {
  readonly files: ReadonlyArray<FileEntry>;
  // Owned keys per merge-keys file id; undefined when the document is absent or refused.
  readonly settings: Readonly<Record<string, Settings | undefined>>;
  readonly skills: ReadonlyArray<SkillGroup>;
  readonly integrations: ReadonlyArray<Integration>;
  readonly allow: Allow;
  readonly issues: ReadonlyArray<Issue>;
};

// Approved revision per skill source.
export type Pins = Readonly<Record<string, string>>;

export type MachineOverrides = {
  readonly manageConfig?: boolean;
  readonly configTargets?: ReadonlyArray<Target>;
  readonly settings?: Readonly<Record<string, Settings>>;
  readonly skills?: Readonly<Record<string, boolean>>;
  readonly integrations?: Readonly<Record<string, boolean>>;
};

export type ResolvedFile = FileEntry & {
  readonly managed: boolean;
  readonly from: Origin;
  readonly keys?: Readonly<Record<string, { readonly value: unknown; readonly from: Origin }>>;
};
export type ResolvedSkill = {
  readonly name: string;
  readonly source: string;
  readonly exact: boolean;
  readonly optional: boolean;
  readonly install: boolean;
  readonly from: Origin;
  readonly pin?: { readonly ref: string; readonly from: Origin };
};
export type ResolvedIntegration = {
  readonly id: string;
  readonly declaration: Integration;
  readonly enabled: boolean;
  readonly from: Origin;
};
export type DesiredConfig = {
  readonly files: ReadonlyArray<ResolvedFile>;
  readonly skills: ReadonlyArray<ResolvedSkill>;
  readonly integrations: ReadonlyArray<ResolvedIntegration>;
  readonly allow: Allow;
  readonly issues: ReadonlyArray<Issue>;
};
```

- [ ] **Step 3: Write the failing tests**

`checks/secrets.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecretName, looksLikeSecretValue, nestedSecretComplaints } from '../src/secrets.ts';

test('credential-shaped field names are secrets', () => {
  for (const name of ['token', 'Secrets', 'api_key', 'apiKeys', 'access_key', 'PASSWORD']) {
    assert.equal(looksLikeSecretName(name), true, name);
  }
  for (const name of ['theme', 'tokenizer', 'effortLevel']) assert.equal(looksLikeSecretName(name), false, name);
});

test('credential-shaped values are secrets wherever they appear', () => {
  for (const value of ['sk-abcd1234', 'x ghp_12345678 y', 'AKIA12345678', 'xoxb-12345678', '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.equal(looksLikeSecretValue(value), true, value);
  }
  assert.equal(looksLikeSecretValue('auto'), false);
});

test('nested values are walked, naming the path of each complaint', () => {
  assert.deepEqual(nestedSecretComplaints({ a: { token: 'x' }, list: ['ok', 'sk-abcdef12'] }, ''), [
    "settings key 'a.token' looks like a secret; this file is committed",
    "settings key 'list[1]' contains what looks like a secret value",
  ]);
  assert.deepEqual(nestedSecretComplaints({ theme: 'auto', n: 1, b: null }, ''), []);
});
```

`checks/issues.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'effect';
import { decode, isPlainObject, issue, parseJson } from '../src/issues.ts';

test('parseJson returns the value or an issue naming the document', () => {
  assert.deepEqual(parseJson('{"a":1}', 'base', 'x.json'), { ok: true, value: { a: 1 } });
  const bad = parseJson('{', 'pin', 'x.json');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.issue.layer, 'pin');
    assert.equal(bad.issue.source, 'x.json');
    assert.match(bad.issue.message, /^not valid JSON: /);
  }
});

test('decode reports every problem and refuses unknown fields', () => {
  const S = Schema.Struct({ version: Schema.Literal(1), name: Schema.String });
  assert.deepEqual(decode(S, { version: 1, name: 'a' }, 'machine', 'o'), { ok: true, value: { version: 1, name: 'a' } });
  const bad = decode(S, { version: 2, extra: true }, 'machine', 'o');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.issue.message, /version/);
    assert.match(bad.issue.message, /name/);
    assert.match(bad.issue.message, /extra/);
  }
});

test('issue and isPlainObject', () => {
  assert.deepEqual(issue('base', 's', 'p', 'm'), { layer: 'base', source: 's', path: 'p', message: 'm' });
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/secrets.ts` / `../src/issues.ts`.

- [ ] **Step 5: Implement `src/secrets.ts` and `src/issues.ts`**

`src/secrets.ts` (rules copied from root `src/secrets.mjs`; nested walk from `src/settings-keys.mjs`):

```ts
// What a credential looks like, by name and by shape. The same rules as the CLI's
// src/secrets.mjs: committed documents may name an environment variable, never carry a value.

const SECRET_FIELD = /^(token|secret|password|passphrase|credential|api_?key|access_?key)s?$/i;

const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{4,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecretName(name: string): boolean {
  return SECRET_FIELD.test(name);
}

export function looksLikeSecretValue(text: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(text));
}

// Complaints for every credential-shaped name or value anywhere inside a settings value.
export function nestedSecretComplaints(value: unknown, path: string): string[] {
  const errors: string[] = [];
  walk(value, path, errors);
  return errors;
}

function walk(value: unknown, path: string, errors: string[]): void {
  if (typeof value === 'string') {
    if (looksLikeSecretValue(value)) errors.push(`settings key '${path}' contains what looks like a secret value`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [name, nested] of Object.entries(value)) {
    const where = path ? `${path}.${name}` : name;
    if (looksLikeSecretName(name)) {
      errors.push(`settings key '${where}' looks like a secret; this file is committed`);
      continue;
    }
    walk(nested, where, errors);
  }
}
```

`src/issues.ts`:

```ts
import { Result, Schema } from 'effect';
import type { Issue, LayerName } from './model.ts';

export function issue(layer: LayerName, source: string, path: string, message: string): Issue {
  return { layer, source, path, message };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// JSON.parse with a failure recorded as an issue rather than thrown.
export function parseJson(
  text: string,
  layer: LayerName,
  source: string,
): { ok: true; value: unknown } | { ok: false; issue: Issue } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, issue: issue(layer, source, '', `not valid JSON: ${(err as Error).message}`) };
  }
}

// Decodes against a Schema, reporting every problem at once and refusing unknown fields.
export function decode<T>(
  schema: Schema.Codec<T, unknown>,
  value: unknown,
  layer: LayerName,
  source: string,
): { ok: true; value: T } | { ok: false; issue: Issue } {
  const result = Schema.decodeUnknownResult(schema)(value, { errors: 'all', onExcessProperty: 'error' });
  return Result.isFailure(result)
    ? { ok: false, issue: issue(layer, source, '', result.failure.message) }
    : { ok: true, value: result.success };
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: all tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/profile-engine/package.json packages/profile-engine/package-lock.json packages/profile-engine/tsconfig.json packages/profile-engine/src/model.ts packages/profile-engine/src/issues.ts packages/profile-engine/src/secrets.ts packages/profile-engine/checks/secrets.spec.ts packages/profile-engine/checks/issues.spec.ts
git commit -m "feat: scaffold the profile engine package"
```

---

### Task 2: Skills manifest and pins readers

**Files:**
- Create: `packages/profile-engine/src/skills.ts`, `packages/profile-engine/src/pins.ts`
- Test: `packages/profile-engine/checks/skills.spec.ts`, `packages/profile-engine/checks/pins.spec.ts`

**Interfaces:**
- Consumes: `SkillGroup`, `Pins`, `Input` from `model.ts`; `parseJson`, `decode`, `issue` from `issues.ts`.
- Produces: `SKILLS_SOURCE = 'skills-manifest.txt'`; `parseSkillsManifest(text: string | undefined): SkillGroup[]`; `PINS_SOURCE = 'skill-pins.json'`; `parsePins(text: string | undefined): Input<Pins>`.

- [ ] **Step 1: Write the failing tests**

`checks/skills.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillsManifest } from '../src/skills.ts';

test('groups skills under their source with exact and optional markers', () => {
  const text = '# comment\n[a/b] optional\nx\ny\n\n[c/d] exact\nz\n[e/f] exact optional bogus\nw\n';
  assert.deepEqual(parseSkillsManifest(text), [
    { source: 'a/b', skills: ['x', 'y'], exact: false, optional: true },
    { source: 'c/d', skills: ['z'], exact: true, optional: false },
    { source: 'e/f', skills: ['w'], exact: true, optional: true },
  ]);
});

test('ignores names before any header and tolerates CRLF and padding', () => {
  assert.deepEqual(parseSkillsManifest('orphan\r\n[ a/b ]\r\n  x  \r\n'), [
    { source: 'a/b', skills: ['x'], exact: false, optional: false },
  ]);
});

test('keeps a header with no skills and repeated sources as written', () => {
  assert.deepEqual(parseSkillsManifest('[a/b]\n[a/b]\nx\n'), [
    { source: 'a/b', skills: [], exact: false, optional: false },
    { source: 'a/b', skills: ['x'], exact: false, optional: false },
  ]);
});

test('an absent manifest declares nothing', () => {
  assert.deepEqual(parseSkillsManifest(undefined), []);
});
```

`checks/pins.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePins } from '../src/pins.ts';

test('an absent pin file pins nothing', () => {
  assert.deepEqual(parsePins(undefined), { value: {}, source: 'skill-pins.json', issues: [] });
});

test('reads a ref per source', () => {
  const text = JSON.stringify({ version: 1, pins: { 'mattpocock/skills': 'abc123' } });
  assert.deepEqual(parsePins(text), { value: { 'mattpocock/skills': 'abc123' }, source: 'skill-pins.json', issues: [] });
});

test('refuses the whole file when anything is wrong', () => {
  for (const text of [
    '{',
    JSON.stringify({ version: 2, pins: {} }),
    JSON.stringify({ version: 1, pins: { a: '' } }),
    JSON.stringify({ version: 1, pins: {}, extra: 1 }),
    JSON.stringify({ version: 1 }),
  ]) {
    const parsed = parsePins(text);
    assert.deepEqual(parsed.value, {}, text);
    assert.equal(parsed.issues.length, 1, text);
    assert.equal(parsed.issues[0]!.layer, 'pin', text);
    assert.equal(parsed.issues[0]!.source, 'skill-pins.json', text);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/skills.ts` / `../src/pins.ts`.

- [ ] **Step 3: Implement**

`src/skills.ts` (port of `parseManifest` in root `src/skills.mjs`):

```ts
import type { SkillGroup } from './model.ts';

export const SKILLS_SOURCE = 'skills-manifest.txt';

const HEADER = /^\[([^\]]+)\]\s*(.*?)\s*$/;

// Reads the source-grouped manifest with the CLI's meaning: `exact` limits a source to the
// skills listed under it, `optional` offers them unchecked, unknown markers are ignored, and a
// name before any header has no source and is dropped.
export function parseSkillsManifest(text: string | undefined): SkillGroup[] {
  if (text === undefined) return [];
  const groups: SkillGroup[] = [];
  let current: SkillGroup | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(HEADER);
    if (header) {
      const markers = header[2]!.split(/\s+/);
      current = {
        source: header[1]!.trim(),
        skills: [],
        exact: markers.includes('exact'),
        optional: markers.includes('optional'),
      };
      groups.push(current);
      continue;
    }
    if (current) current.skills.push(line);
  }
  return groups;
}
```

`src/pins.ts`:

```ts
import { Schema } from 'effect';
import type { Input, Pins } from './model.ts';
import { decode, parseJson } from './issues.ts';

export const PINS_SOURCE = 'skill-pins.json';

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const PinsDocument = Schema.Struct({
  version: Schema.Literal(1),
  pins: Schema.Record(NonEmpty, NonEmpty),
});

// Approved revisions, one ref per skill source. Absent means nothing is pinned; a file with
// any problem pins nothing and reports why.
export function parsePins(text: string | undefined): Input<Pins> {
  const none = { value: {}, source: PINS_SOURCE };
  if (text === undefined) return { ...none, issues: [] };

  const parsed = parseJson(text, 'pin', PINS_SOURCE);
  if (!parsed.ok) return { ...none, issues: [parsed.issue] };

  const decoded = decode(PinsDocument, parsed.value, 'pin', PINS_SOURCE);
  if (!decoded.ok) return { ...none, issues: [decoded.issue] };
  return { value: decoded.value.pins, source: PINS_SOURCE, issues: [] };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/skills.ts packages/profile-engine/src/pins.ts packages/profile-engine/checks/skills.spec.ts packages/profile-engine/checks/pins.spec.ts
git commit -m "feat: read the skills manifest and revision pins"
```

---

### Task 3: Built-in file table and settings keys reader

**Files:**
- Create: `packages/profile-engine/src/files.ts`, `packages/profile-engine/src/settings.ts`
- Test: `packages/profile-engine/checks/settings.spec.ts`

**Interfaces:**
- Consumes: `FileEntry`, `Settings`, `Issue` from `model.ts`; `parseJson`, `issue`, `isPlainObject` from `issues.ts`; `nestedSecretComplaints` from `secrets.ts`.
- Produces: `FILES_SOURCE = 'built-in'`; `FILES: ReadonlyArray<FileEntry>`; `parseSettingsKeys(text: string | undefined, source: string): { value: Settings | undefined; issues: Issue[] }`; `settingsComplaints(value: unknown): string[]`.

- [ ] **Step 1: Write the failing test**

`checks/settings.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES } from '../src/files.ts';
import { parseSettingsKeys } from '../src/settings.ts';

const SOURCE = 'claude/settings.keys.json';

test('reads owned keys and their values', () => {
  assert.deepEqual(parseSettingsKeys('{"effortLevel":"high","worktree":{"a":[1]}}', SOURCE), {
    value: { effortLevel: 'high', worktree: { a: [1] } },
    issues: [],
  });
});

test('an absent document owns nothing and is not an issue', () => {
  assert.deepEqual(parseSettingsKeys(undefined, SOURCE), { value: undefined, issues: [] });
});

test('refuses unreadable, non-object, empty and secret-bearing documents whole', () => {
  for (const text of ['{', '[]', '"x"', '{}', '{"env":{"API_KEY":"x"}}', '{"a":"ghp_abcdefgh123"}']) {
    const parsed = parseSettingsKeys(text, SOURCE);
    assert.equal(parsed.value, undefined, text);
    assert.ok(parsed.issues.length > 0, text);
    assert.ok(parsed.issues.every((i) => i.layer === 'base' && i.source === SOURCE), text);
  }
});

test('the file table has unique ids and one merge-keys entry for Claude settings', () => {
  assert.equal(new Set(FILES.map((f) => f.id)).size, FILES.length);
  assert.deepEqual(
    FILES.filter((f) => f.mode === 'merge-keys').map((f) => [f.id, f.src]),
    [['claude:settings.json', 'claude/settings.keys.json']],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/files.ts`.

- [ ] **Step 3: Implement**

`src/files.ts`:

```ts
import type { FileEntry } from './model.ts';

export const FILES_SOURCE = 'built-in';

// The base profile's managed files: the CLI's SYNC table (src/manifest.mjs) as data. `id` is the
// state-file key the CLI uses (`<target>:<dest>`). A golden test keeps the two tables equal until
// #42 retires SYNC.
export const FILES: ReadonlyArray<FileEntry> = [
  { id: 'claude:CLAUDE.md', target: 'claude', home: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy', preserveProjects: false, capture: true },
  { id: 'codex:AGENTS.md', target: 'codex', home: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy', preserveProjects: false, capture: true },
  { id: 'codex:models-static.json', target: 'codex', home: 'codex-openrouter', src: 'codex/openrouter-glm/models-static.json', dest: 'models-static.json', mode: 'copy', preserveProjects: false, capture: false },
  { id: 'codex:config.toml', target: 'codex', home: 'codex-openrouter', src: 'codex/openrouter-glm/config.toml', dest: 'config.toml', mode: 'copy', preserveProjects: true, capture: false },
  { id: 'claude:settings.json', target: 'claude', home: 'claude', src: 'claude/settings.keys.json', dest: 'settings.json', mode: 'merge-keys', preserveProjects: false, capture: true },
];
```

`src/settings.ts` (port of `validateOwnedKeys` in root `src/settings-keys.mjs`):

```ts
import type { Issue, Settings } from './model.ts';
import { isPlainObject, issue, parseJson } from './issues.ts';
import { nestedSecretComplaints } from './secrets.ts';

// The CLI's rules for a merge-keys document: an object naming at least one key, with no
// credential anywhere inside it.
export function settingsComplaints(value: unknown): string[] {
  if (!isPlainObject(value)) return ['settings.keys.json must be a JSON object'];
  const errors: string[] = [];
  if (Object.keys(value).length === 0) {
    errors.push('settings.keys.json names no keys; remove the manifest entry instead');
  }
  errors.push(...nestedSecretComplaints(value, ''));
  return errors;
}

// The keys a merge-keys document owns and their values. Its key set is the allowlist of keys the
// engine may write. Absent owns nothing; a refused document owns nothing and reports why.
export function parseSettingsKeys(
  text: string | undefined,
  source: string,
): { value: Settings | undefined; issues: Issue[] } {
  if (text === undefined) return { value: undefined, issues: [] };
  const parsed = parseJson(text, 'base', source);
  if (!parsed.ok) return { value: undefined, issues: [parsed.issue] };

  const errors = settingsComplaints(parsed.value);
  if (errors.length) return { value: undefined, issues: errors.map((m) => issue('base', source, '', m)) };
  return { value: parsed.value as Settings, issues: [] };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/files.ts packages/profile-engine/src/settings.ts packages/profile-engine/checks/settings.spec.ts
git commit -m "feat: declare managed files and read owned settings keys"
```

---

### Task 4: Integrations reader

**Files:**
- Create: `packages/profile-engine/src/integrations.ts`
- Test: `packages/profile-engine/checks/integrations.spec.ts`

**Interfaces:**
- Consumes: `TARGETS`, `CATEGORIES`, `Allow`, `Integration`, `Issue` from `model.ts`; `parseJson`, `issue`, `isPlainObject` from `issues.ts`; `looksLikeSecretName`, `looksLikeSecretValue` from `secrets.ts`.
- Produces: `INTEGRATIONS_SOURCE = 'integrations.json'`; `parseIntegrations(text: string | undefined, hookFileExists: (file: string) => boolean): { integrations: Integration[]; allow: Allow; issues: Issue[] }`; `referencedFiles(text: string | undefined): string[]`.

- [ ] **Step 1: Write the failing test**

`checks/integrations.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegrations, referencedFiles } from '../src/integrations.ts';

const plugin = { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin: 'superpowers@x' };
const hook = { id: 'h', label: 'hook', target: 'claude', type: 'hook', default: false, event: 'Stop', file: 'hooks/h.sh' };
const doc = (integrations: unknown[], extra: object = {}) => JSON.stringify({ version: 1, integrations, ...extra });
const none = () => false;

test('accepts valid declarations and the allow list', () => {
  const parsed = parseIntegrations(doc([plugin, hook], { allow: { plugins: ['a@b'] } }), (f) => f === 'hooks/h.sh');
  assert.deepEqual(parsed, { integrations: [plugin, hook], allow: { plugins: ['a@b'] }, issues: [] });
});

test('an absent document declares nothing', () => {
  assert.deepEqual(parseIntegrations(undefined, none), { integrations: [], allow: {}, issues: [] });
});

test('any refusal yields no integrations and no allow list', () => {
  const refused: Array<[string, string]> = [
    ['invalid json', '{'],
    ['not an object', '[]'],
    ['wrong version', JSON.stringify({ version: 2, integrations: [] })],
    ['no integrations array', JSON.stringify({ version: 1 })],
    ['item not an object', doc(['x'])],
    ['missing id', doc([{ ...plugin, id: '' }])],
    ['duplicate id', doc([plugin, plugin])],
    ['missing label', doc([{ ...plugin, label: '' }])],
    ['unsupported target', doc([{ ...plugin, target: 'cursor' }])],
    ['unknown type', doc([{ ...plugin, type: 'widget' }])],
    ['default not boolean', doc([{ ...plugin, default: 'yes' }])],
    ['plugin without name', doc([{ ...plugin, plugin: '' }])],
    ['marketplace without source', doc([{ id: 'm', label: 'm', target: 'claude', type: 'marketplace', default: true, name: 'm' }])],
    ['marketplace without name', doc([{ id: 'm', label: 'm', target: 'claude', type: 'marketplace', default: true, marketplace: 'o/r' }])],
    ['mcp without command', doc([{ id: 'c', label: 'c', target: 'codex', type: 'mcp', default: true }])],
    ['hook without event', doc([{ ...hook, event: '' }])],
    ['hook without file', doc([{ ...hook, file: '' }])],
    ['hook file not in repo', doc([hook])],
    ['requiresEnv not names', doc([{ ...plugin, requiresEnv: [1] }])],
    ['secret field name', doc([{ ...plugin, token: 'x' }])],
    ['secret value', doc([{ ...plugin, note: 'sk-abcdef12' }])],
    ['secret value in a list', doc([{ ...plugin, args: ['ok', 'ghp_abcdefgh1'] }])],
    ['allow not an object', doc([plugin], { allow: [] })],
    ['allow unknown category', doc([plugin], { allow: { widgets: [] } })],
    ['allow not ids', doc([plugin], { allow: { plugins: [''] } })],
  ];
  for (const [name, text] of refused) {
    const parsed = parseIntegrations(text, none);
    assert.deepEqual(parsed.integrations, [], name);
    assert.deepEqual(parsed.allow, {}, name);
    assert.ok(parsed.issues.length > 0, name);
    assert.ok(parsed.issues.every((i) => i.layer === 'base' && i.source === 'integrations.json'), name);
  }
});

test('requiresEnv is a list of names, never scanned as values', () => {
  const parsed = parseIntegrations(doc([{ ...plugin, requiresEnv: ['API_KEY'] }]), none);
  assert.deepEqual(parsed.issues, []);
});

test('referencedFiles lists hook files so a loader can check them', () => {
  assert.deepEqual(referencedFiles(doc([plugin, hook, { ...hook, id: 'h2', file: 5 }])), ['hooks/h.sh']);
  assert.deepEqual(referencedFiles(undefined), []);
  assert.deepEqual(referencedFiles('{'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/integrations.ts`.

- [ ] **Step 3: Implement `src/integrations.ts`** (port of root `src/integrations/manifest.mjs`; messages copied verbatim)

```ts
import { CATEGORIES, TARGETS } from './model.ts';
import type { Allow, Integration, Issue } from './model.ts';
import { isPlainObject, issue, parseJson } from './issues.ts';
import { looksLikeSecretName, looksLikeSecretValue } from './secrets.ts';

export const INTEGRATIONS_SOURCE = 'integrations.json';

const TYPES = ['hook', 'marketplace', 'plugin', 'mcp'];
const VERSION = 1;
// Lists of names rather than data, so never scanned as if they held one.
const NAME_LIST_FIELDS = new Set(['requiresEnv']);

type Parsed = { integrations: Integration[]; allow: Allow; issues: Issue[] };

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function secretComplaints(item: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [field, value] of Object.entries(item)) {
    if (NAME_LIST_FIELDS.has(field)) continue;
    if (looksLikeSecretName(field)) {
      errors.push(
        `integration '${item.id}': field '${field}' looks like a secret; ` +
          'commit the name of an environment variable in requiresEnv instead',
      );
      continue;
    }
    const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const text of strings) {
      if (typeof text !== 'string') continue;
      if (looksLikeSecretValue(text)) {
        errors.push(
          `integration '${item.id}': field '${field}' contains what looks like a secret value; ` +
            'commit the name of an environment variable in requiresEnv instead',
        );
        break;
      }
    }
  }
  return errors;
}

function validateOne(item: unknown, index: number, seen: Set<string>, hookFileExists: (file: string) => boolean): string[] {
  if (!isPlainObject(item)) return [`integration #${index + 1}: must be an object`];
  const errors: string[] = [];
  const where = item.id ? `integration '${item.id}'` : `integration #${index + 1}`;

  if (!isText(item.id)) errors.push(`${where}: needs a stable string id`);
  else if (seen.has(item.id)) errors.push(`duplicate integration id '${item.id}'`);
  else seen.add(item.id);

  if (!isText(item.label)) errors.push(`${where}: needs a user-facing label`);
  if (!(TARGETS as ReadonlyArray<unknown>).includes(item.target)) errors.push(`${where}: unsupported target '${item.target}'`);
  if (!TYPES.includes(item.type as string)) errors.push(`${where}: unknown type '${item.type}'`);
  if (typeof item.default !== 'boolean') errors.push(`${where}: 'default' must be true or false`);

  if (item.type === 'plugin' && !isText(item.plugin)) errors.push(`${where}: a plugin needs a 'plugin' name`);
  if (item.type === 'marketplace') {
    if (!isText(item.marketplace)) errors.push(`${where}: a marketplace needs a 'marketplace' source`);
    if (!isText(item.name)) {
      errors.push(`${where}: a marketplace needs the 'name' it registers as (not derivable from the source)`);
    }
  }
  if (item.type === 'mcp' && !isText(item.command)) errors.push(`${where}: an mcp server needs a 'command'`);
  if (item.type === 'hook') {
    if (!isText(item.event)) errors.push(`${where}: a hook needs an 'event'`);
    if (!isText(item.file)) errors.push(`${where}: a hook needs a 'file' this repo ships`);
    else if (!hookFileExists(item.file)) errors.push(`${where}: referenced file '${item.file}' is not in the repo`);
  }

  if (item.requiresEnv !== undefined) {
    if (!Array.isArray(item.requiresEnv) || item.requiresEnv.some((n) => typeof n !== 'string')) {
      errors.push(`${where}: 'requiresEnv' must be a list of environment-variable names`);
    }
  }

  errors.push(...secretComplaints(item));
  return errors;
}

function validateAllow(value: unknown, errors: string[]): Allow {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push("integrations.json: 'allow' must be an object keyed by category");
    return {};
  }
  const allow: Record<string, ReadonlyArray<string>> = {};
  for (const [category, ids] of Object.entries(value)) {
    if (!(CATEGORIES as ReadonlyArray<string>).includes(category)) {
      errors.push(
        `integrations.json: 'allow' names unknown category '${category}'; ` +
          `expected one of ${CATEGORIES.join(', ')}`,
      );
      continue;
    }
    if (!Array.isArray(ids) || ids.some((id) => !isText(id))) {
      errors.push(`integrations.json: 'allow.${category}' must be a list of ids`);
      continue;
    }
    allow[category] = ids;
  }
  return allow;
}

// Installable integrations with the CLI's meaning. A document with any error yields no
// integrations and no allow list: honouring half of a refused declaration is how it would still
// reach an installer. `hookFileExists` answers whether a repo-relative hook file is shipped.
export function parseIntegrations(text: string | undefined, hookFileExists: (file: string) => boolean): Parsed {
  if (text === undefined) return { integrations: [], allow: {}, issues: [] };
  const refuse = (messages: string[]): Parsed => ({
    integrations: [],
    allow: {},
    issues: messages.map((m) => issue('base', INTEGRATIONS_SOURCE, '', m)),
  });

  const parsed = parseJson(text, 'base', INTEGRATIONS_SOURCE);
  if (!parsed.ok) return { integrations: [], allow: {}, issues: [parsed.issue] };
  const value = parsed.value;
  if (!isPlainObject(value)) return refuse(['integrations.json must be a JSON object']);

  const errors: string[] = [];
  if (value.version !== VERSION) {
    errors.push(`integrations.json version must be ${VERSION}, found ${JSON.stringify(value.version)}`);
  }
  const allow = validateAllow(value.allow, errors);
  if (!Array.isArray(value.integrations)) return refuse([...errors, "integrations.json needs an 'integrations' array"]);

  const seen = new Set<string>();
  value.integrations.forEach((item, index) => errors.push(...validateOne(item, index, seen, hookFileExists)));

  if (errors.length) return refuse(errors);
  return { integrations: value.integrations as Integration[], allow, issues: [] };
}

// The repo-relative hook files a document references, so a loader can check them before validating.
export function referencedFiles(text: string | undefined): string[] {
  if (text === undefined) return [];
  try {
    const value: unknown = JSON.parse(text);
    if (!isPlainObject(value) || !Array.isArray(value.integrations)) return [];
    return value.integrations
      .filter((item): item is Record<string, unknown> => isPlainObject(item) && item.type === 'hook' && isText(item.file))
      .map((item) => item.file as string);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/integrations.ts packages/profile-engine/checks/integrations.spec.ts
git commit -m "feat: read integrations with the CLI's validation rules"
```

---

### Task 5: Machine overrides and the legacy state adapter

**Files:**
- Create: `packages/profile-engine/src/overrides.ts`
- Test: `packages/profile-engine/checks/overrides.spec.ts`

**Interfaces:**
- Consumes: `TARGETS`, `Target`, `Input`, `MachineOverrides` from `model.ts`; `decode`, `isPlainObject` from `issues.ts`.
- Produces: `decodeOverrides(value: unknown, source: string): Input<MachineOverrides>`; `LEGACY_STATE_SOURCE = 'state.json'`; `overridesFromLegacyState(text: string | undefined, source?: string): Input<MachineOverrides>`.

- [ ] **Step 1: Write the failing test**

`checks/overrides.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOverrides, overridesFromLegacyState } from '../src/overrides.ts';

test('decodes a full overrides document without its version', () => {
  const value = {
    version: 1,
    manageConfig: true,
    configTargets: ['claude'],
    settings: { 'claude:settings.json': { effortLevel: 'medium' } },
    skills: { explain: true, wizard: false },
    integrations: { 'superpowers-codex': false },
  };
  const { version: _version, ...expected } = value;
  assert.deepEqual(decodeOverrides(value, 'overrides.json'), { value: expected, source: 'overrides.json', issues: [] });
});

test('every field but version is optional', () => {
  assert.deepEqual(decodeOverrides({ version: 1 }, 'o'), { value: {}, source: 'o', issues: [] });
});

test('a malformed document overrides nothing and reports one machine issue', () => {
  for (const value of [
    {},
    { version: 2 },
    { version: 1, extra: true },
    { version: 1, configTargets: ['cursor'] },
    { version: 1, skills: { explain: 'yes' } },
    { version: 1, settings: { 'claude:settings.json': 'x' } },
    [],
  ]) {
    const decoded = decodeOverrides(value, 'o');
    assert.deepEqual(decoded.value, {}, JSON.stringify(value));
    assert.equal(decoded.issues.length, 1, JSON.stringify(value));
    assert.equal(decoded.issues[0]!.layer, 'machine');
    assert.equal(decoded.issues[0]!.source, 'o');
  }
});

test('legacy state yields only the choices parseState honours', () => {
  const cases: Array<[string | undefined, object]> = [
    [undefined, {}],
    ['{', {}],
    ['{"skillsOnly":true}', {}],
    ['{"files":[],"skillsOnly":true}', {}],
    ['{"files":{}}', {}],
    ['{"files":{},"skillsOnly":true}', { manageConfig: false }],
    ['{"files":{},"skillsOnly":"true"}', {}],
    ['{"files":{},"skillsOnly":false}', {}],
    ['{"files":{},"configTargets":["codex","codex"]}', { configTargets: ['codex'] }],
    ['{"files":{},"configTargets":[]}', { configTargets: [] }],
    ['{"files":{},"configTargets":["codex","cursor"]}', {}],
    ['{"files":{},"configTargets":"codex"}', {}],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(overridesFromLegacyState(text), { value: expected, source: 'state.json', issues: [] }, String(text));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/overrides.ts`.

- [ ] **Step 3: Implement `src/overrides.ts`**

```ts
import { Schema } from 'effect';
import { TARGETS } from './model.ts';
import type { Input, MachineOverrides, Target } from './model.ts';
import { decode, isPlainObject } from './issues.ts';

const OverridesDocument = Schema.Struct({
  version: Schema.Literal(1),
  manageConfig: Schema.optional(Schema.Boolean),
  configTargets: Schema.optional(Schema.Array(Schema.Literals(TARGETS))),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
  skills: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  integrations: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

// One machine's choices. Where they are stored is the caller's concern; a malformed document
// overrides nothing and reports why.
export function decodeOverrides(value: unknown, source: string): Input<MachineOverrides> {
  const decoded = decode(OverridesDocument, value, 'machine', source);
  if (!decoded.ok) return { value: {}, source, issues: [decoded.issue] };
  const { version: _version, ...overrides } = decoded.value;
  return { value: overrides, source, issues: [] };
}

export const LEGACY_STATE_SOURCE = 'state.json';

// The two machine choices the CLI already records in state.json, read with parseState's rules
// (src/lock.mjs): only a literal `skillsOnly: true` stops configuration being managed, and
// `configTargets` counts only as a list of known targets. A missing, corrupt or misshapen
// record decides nothing, exactly as the CLI treats it as a first run.
export function overridesFromLegacyState(text: string | undefined, source = LEGACY_STATE_SOURCE): Input<MachineOverrides> {
  const none: Input<MachineOverrides> = { value: {}, source, issues: [] };
  if (text === undefined) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) return none;

  const targets = parsed.configTargets;
  const knownTargets =
    Array.isArray(targets) && targets.every((t) => (TARGETS as ReadonlyArray<unknown>).includes(t))
      ? [...new Set(targets as Target[])]
      : undefined;

  return {
    value: {
      ...(parsed.skillsOnly === true ? { manageConfig: false } : {}),
      ...(knownTargets ? { configTargets: knownTargets } : {}),
    },
    source,
    issues: [],
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0. If `Schema.Literals(TARGETS)` rejects the readonly tuple at typecheck, pass `[...TARGETS]`.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/overrides.ts packages/profile-engine/checks/overrides.spec.ts
git commit -m "feat: decode machine overrides and read legacy machine state"
```

---

### Task 6: Base profile assembly and resolution with provenance

**Files:**
- Create: `packages/profile-engine/src/base.ts`, `packages/profile-engine/src/resolve.ts`
- Test: `packages/profile-engine/checks/resolve.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5 (`FILES`, `FILES_SOURCE`, `parseSettingsKeys`, `parseSkillsManifest`, `SKILLS_SOURCE`, `parseIntegrations`, `INTEGRATIONS_SOURCE`, `PINS_SOURCE`, `nestedSecretComplaints`, `issue`).
- Produces: `type BaseTexts = { skillsManifest?: string; integrations?: string; settings?: Readonly<Record<string, string | undefined>> }` (settings keyed by file id); `buildBaseProfile(texts: BaseTexts, hookFileExists: (file: string) => boolean): BaseProfile`; `resolveProfile(input: { base: BaseProfile; pins?: Input<Pins>; overrides?: Input<MachineOverrides> }): DesiredConfig`.

- [ ] **Step 1: Write the failing test**

`checks/resolve.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseProfile } from '../src/base.ts';
import { resolveProfile } from '../src/resolve.ts';
import type { Input, MachineOverrides, Pins } from '../src/model.ts';

const manifest = '[a/core]\ntdd\nwizard\n[a/extra] optional\nexplain\n[b/other]\ntdd\n';
const integrations = JSON.stringify({
  version: 1,
  integrations: [
    { id: 'sp-claude', label: 'sp', target: 'claude', type: 'plugin', default: true, plugin: 'sp@x' },
    { id: 'sp-codex', label: 'sp', target: 'codex', type: 'plugin', default: false, plugin: 'sp@y' },
  ],
});
const settings = { 'claude:settings.json': '{"effortLevel":"high","theme":"auto"}' };
const base = buildBaseProfile({ skillsManifest: manifest, integrations, settings }, () => false);

const machine = (value: MachineOverrides, issues: Input<MachineOverrides>['issues'] = []): Input<MachineOverrides> =>
  ({ value, source: 'overrides.json', issues });
const pinned = (value: Pins): Input<Pins> => ({ value, source: 'skill-pins.json', issues: [] });
const M = { layer: 'machine', source: 'overrides.json' } as const;

test('with no pins or overrides every value comes from the base profile', () => {
  const config = resolveProfile({ base });
  assert.deepEqual(config.issues, []);
  assert.ok(config.files.every((f) => f.managed && f.from.layer === 'base' && f.from.source === 'built-in'));
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {
    effortLevel: { value: 'high', from: { layer: 'base', source: 'claude/settings.keys.json' } },
    theme: { value: 'auto', from: { layer: 'base', source: 'claude/settings.keys.json' } },
  });
  assert.equal(config.files.find((f) => f.id === 'claude:CLAUDE.md')!.keys, undefined);
  assert.deepEqual(
    config.skills.map((s) => [s.name, s.source, s.install, s.from.source, 'pin' in s]),
    [
      ['tdd', 'a/core', true, 'skills-manifest.txt', false],
      ['wizard', 'a/core', true, 'skills-manifest.txt', false],
      ['explain', 'a/extra', false, 'skills-manifest.txt', false],
      ['tdd', 'b/other', true, 'skills-manifest.txt', false],
    ],
  );
  assert.deepEqual(
    config.integrations.map((i) => [i.id, i.enabled, i.from]),
    [
      ['sp-claude', true, { layer: 'base', source: 'integrations.json' }],
      ['sp-codex', false, { layer: 'base', source: 'integrations.json' }],
    ],
  );
});

test('manageConfig false leaves every file unmanaged, decided by the machine', () => {
  const config = resolveProfile({ base, overrides: machine({ manageConfig: false }) });
  assert.ok(config.files.every((f) => !f.managed && f.from.layer === 'machine'));
});

test('configTargets manages only the named agents', () => {
  const config = resolveProfile({ base, overrides: machine({ configTargets: ['codex'] }) });
  for (const f of config.files) {
    assert.equal(f.managed, f.target === 'codex', f.id);
    assert.deepEqual(f.from, M);
  }
});

test('a settings override replaces an owned value and only that value', () => {
  const config = resolveProfile({
    base,
    overrides: machine({ settings: { 'claude:settings.json': { effortLevel: 'medium' } } }),
  });
  assert.deepEqual(config.issues, []);
  const keys = config.files.find((f) => f.id === 'claude:settings.json')!.keys!;
  assert.deepEqual(keys.effortLevel, { value: 'medium', from: M });
  assert.equal(keys.theme!.from.layer, 'base');
});

test('settings overrides of unowned keys or undeclared documents are issues and change nothing', () => {
  const config = resolveProfile({
    base,
    overrides: machine({ settings: { 'claude:settings.json': { permissions: {} }, 'codex:config.toml': { a: 1 } } }),
  });
  assert.equal(config.issues.length, 2);
  assert.ok(config.issues.every((i) => i.layer === 'machine' && i.source === 'overrides.json'));
  assert.deepEqual(config.issues.map((i) => i.path).sort(), ['settings.claude:settings.json.permissions', 'settings.codex:config.toml']);
  assert.deepEqual(Object.keys(config.files.find((f) => f.id === 'claude:settings.json')!.keys!), ['effortLevel', 'theme']);
});

test('a settings override hiding a credential is refused and the base value kept', () => {
  for (const value of ['sk-abcdef12', { nested: { token: 'x' } }]) {
    const config = resolveProfile({ base, overrides: machine({ settings: { 'claude:settings.json': { theme: value } } }) });
    assert.ok(config.issues.length > 0, JSON.stringify(value));
    assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys!.theme, {
      value: 'auto',
      from: { layer: 'base', source: 'claude/settings.keys.json' },
    });
  }
});

test('a refused settings document owns nothing, and overriding its keys is an issue per key', () => {
  const refused = buildBaseProfile({ skillsManifest: manifest, integrations, settings: { 'claude:settings.json': '{}' } }, () => false);
  const config = resolveProfile({
    base: refused,
    overrides: machine({ settings: { 'claude:settings.json': { effortLevel: 'low', theme: 'dark' } } }),
  });
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {});
  assert.equal(config.issues.filter((i) => i.layer === 'machine').length, 2);
  assert.equal(config.issues.filter((i) => i.layer === 'base').length, 1);
});

test('skill overrides opt in, opt out, and apply to every source listing the name', () => {
  const config = resolveProfile({ base, overrides: machine({ skills: { explain: true, tdd: false, missing: true } }) });
  const byKey = new Map(config.skills.map((s) => [`${s.source}/${s.name}`, s]));
  assert.deepEqual([byKey.get('a/extra/explain')!.install, byKey.get('a/extra/explain')!.from], [true, M]);
  assert.equal(byKey.get('a/core/tdd')!.install, false);
  assert.equal(byKey.get('b/other/tdd')!.install, false);
  assert.equal(byKey.get('a/core/wizard')!.from.layer, 'base');
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['machine', 'skills.missing']]);
});

test('a pin stamps every skill from its source; a pin for an undeclared source is an issue', () => {
  const config = resolveProfile({ base, pins: pinned({ 'a/core': 'abc123', 'z/none': 'def' }) });
  const fromCore = config.skills.filter((s) => s.source === 'a/core');
  assert.ok(fromCore.every((s) => s.pin?.ref === 'abc123' && s.pin.from.layer === 'pin' && s.pin.from.source === 'skill-pins.json'));
  assert.ok(config.skills.filter((s) => s.source !== 'a/core').every((s) => !('pin' in s)));
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['pin', 'pins.z/none']]);
});

test('integration overrides enable or disable declared ids only', () => {
  const config = resolveProfile({ base, overrides: machine({ integrations: { 'sp-claude': false, 'sp-codex': true, ghost: true } }) });
  assert.deepEqual(config.integrations.map((i) => [i.id, i.enabled, i.from.layer]), [
    ['sp-claude', false, 'machine'],
    ['sp-codex', true, 'machine'],
  ]);
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['machine', 'integrations.ghost']]);
});

test('issues from every input are carried through', () => {
  const broken = buildBaseProfile({ integrations: '{' }, () => false);
  const config = resolveProfile({
    base: broken,
    pins: { value: {}, source: 'skill-pins.json', issues: [{ layer: 'pin', source: 'skill-pins.json', path: '', message: 'p' }] },
    overrides: machine({}, [{ layer: 'machine', source: 'overrides.json', path: '', message: 'o' }]),
  });
  assert.deepEqual(config.issues.map((i) => i.layer), ['base', 'pin', 'machine']);
  assert.deepEqual(config.integrations, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/base.ts`.

- [ ] **Step 3: Implement**

`src/base.ts`:

```ts
import type { BaseProfile, Issue, Settings } from './model.ts';
import { FILES } from './files.ts';
import { parseSettingsKeys } from './settings.ts';
import { parseSkillsManifest } from './skills.ts';
import { parseIntegrations } from './integrations.ts';

// The repository's documents as text; undefined means the file is absent. `settings` is keyed by
// the merge-keys file id that owns the document.
export type BaseTexts = {
  readonly skillsManifest?: string;
  readonly integrations?: string;
  readonly settings?: Readonly<Record<string, string | undefined>>;
};

// Reads every base-profile document. Each one validates on its own, so a refused document
// contributes nothing while the rest still resolve, as in the CLI.
export function buildBaseProfile(texts: BaseTexts, hookFileExists: (file: string) => boolean): BaseProfile {
  const issues: Issue[] = [];
  const settings: Record<string, Settings | undefined> = {};
  for (const file of FILES) {
    if (file.mode !== 'merge-keys') continue;
    const parsed = parseSettingsKeys(texts.settings?.[file.id], file.src);
    settings[file.id] = parsed.value;
    issues.push(...parsed.issues);
  }
  const integrations = parseIntegrations(texts.integrations, hookFileExists);
  issues.push(...integrations.issues);

  return {
    files: FILES,
    settings,
    skills: parseSkillsManifest(texts.skillsManifest),
    integrations: integrations.integrations,
    allow: integrations.allow,
    issues,
  };
}
```

`src/resolve.ts`:

```ts
import type {
  BaseProfile, DesiredConfig, FileEntry, Input, Issue, MachineOverrides, Origin, Pins, ResolvedFile,
} from './model.ts';
import { issue } from './issues.ts';
import { FILES_SOURCE } from './files.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { INTEGRATIONS_SOURCE } from './integrations.ts';
import { PINS_SOURCE } from './pins.ts';
import { nestedSecretComplaints } from './secrets.ts';

type ResolveInput = {
  readonly base: BaseProfile;
  readonly pins?: Input<Pins>;
  readonly overrides?: Input<MachineOverrides>;
};

// Layers pins and machine overrides over the base profile and records which layer decided every
// value. Pure. An override or pin naming something the base does not declare becomes an issue and
// changes nothing, so the base profile stays the only list of what may be managed.
export function resolveProfile({
  base,
  pins = { value: {}, source: PINS_SOURCE, issues: [] },
  overrides = { value: {}, source: 'overrides', issues: [] },
}: ResolveInput): DesiredConfig {
  const issues: Issue[] = [...base.issues, ...pins.issues, ...overrides.issues];
  const chosen = overrides.value;
  const machine: Origin = { layer: 'machine', source: overrides.source };
  const complain = (path: string, message: string) => issues.push(issue('machine', overrides.source, path, message));

  for (const fileId of Object.keys(chosen.settings ?? {})) {
    if (!base.files.some((f) => f.id === fileId && f.mode === 'merge-keys')) {
      complain(`settings.${fileId}`, `'${fileId}' is not a settings document the profile declares`);
    }
  }
  const files = base.files.map((file) => resolveFile(file, base, chosen, machine, complain));

  const declaredSkills = new Set(base.skills.flatMap((g) => g.skills));
  for (const name of Object.keys(chosen.skills ?? {})) {
    if (!declaredSkills.has(name)) complain(`skills.${name}`, `skill '${name}' is not in the skills manifest`);
  }
  const declaredSources = new Set(base.skills.map((g) => g.source));
  for (const source of Object.keys(pins.value)) {
    if (!declaredSources.has(source)) {
      issues.push(issue('pin', pins.source, `pins.${source}`, `source '${source}' is not in the skills manifest`));
    }
  }
  const pinOrigin: Origin = { layer: 'pin', source: pins.source };
  const skills = base.skills.flatMap((group) =>
    group.skills.map((name) => {
      const choice = chosen.skills?.[name];
      const ref = pins.value[group.source];
      return {
        name,
        source: group.source,
        exact: group.exact,
        optional: group.optional,
        install: choice ?? !group.optional,
        from: choice === undefined ? { layer: 'base' as const, source: SKILLS_SOURCE } : machine,
        ...(ref === undefined ? {} : { pin: { ref, from: pinOrigin } }),
      };
    }),
  );

  const declaredIntegrations = new Set(base.integrations.map((i) => i.id));
  for (const id of Object.keys(chosen.integrations ?? {})) {
    if (!declaredIntegrations.has(id)) complain(`integrations.${id}`, `integration '${id}' is not declared`);
  }
  const integrations = base.integrations.map((declaration) => {
    const choice = chosen.integrations?.[declaration.id];
    return {
      id: declaration.id,
      declaration,
      enabled: choice ?? declaration.default,
      from: choice === undefined ? { layer: 'base' as const, source: INTEGRATIONS_SOURCE } : machine,
    };
  });

  return { files, skills, integrations, allow: base.allow, issues };
}

function resolveFile(
  file: FileEntry,
  base: BaseProfile,
  chosen: MachineOverrides,
  machine: Origin,
  complain: (path: string, message: string) => void,
): ResolvedFile {
  const decided = chosen.manageConfig !== undefined || chosen.configTargets !== undefined;
  const managed = chosen.manageConfig !== false && (chosen.configTargets?.includes(file.target) ?? true);
  const resolved: ResolvedFile = { ...file, managed, from: decided ? machine : { layer: 'base', source: FILES_SOURCE } };
  if (file.mode !== 'merge-keys') return resolved;

  const owned = base.settings[file.id];
  const keys: Record<string, { value: unknown; from: Origin }> = {};
  for (const [key, value] of Object.entries(owned ?? {})) keys[key] = { value, from: { layer: 'base', source: file.src } };

  for (const [key, value] of Object.entries(chosen.settings?.[file.id] ?? {})) {
    const path = `settings.${file.id}.${key}`;
    if (!owned || !Object.hasOwn(owned, key)) {
      complain(path, `key '${key}' is not owned by ${file.src}; an override can only replace an owned key's value`);
      continue;
    }
    const secrets = nestedSecretComplaints({ [key]: value }, '');
    if (secrets.length) {
      for (const message of secrets) complain(path, message);
      continue;
    }
    keys[key] = { value, from: machine };
  }
  return { ...resolved, keys };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/base.ts packages/profile-engine/src/resolve.ts packages/profile-engine/checks/resolve.spec.ts
git commit -m "feat: resolve profiles with per-value provenance"
```

---

### Task 7: Effect loading boundary and public exports

**Files:**
- Create: `packages/profile-engine/src/errors.ts`, `packages/profile-engine/src/load.ts`, `packages/profile-engine/src/index.ts`
- Test: `packages/profile-engine/checks/load.spec.ts`

**Interfaces:**
- Consumes: `buildBaseProfile`, `resolveProfile`, `FILES`, `SKILLS_SOURCE`, `INTEGRATIONS_SOURCE`, `referencedFiles`, `PINS_SOURCE`, `parsePins`.
- Produces: `class ReadFailed` (tag `'ReadFailed'`, fields `path: string`, `reason: string`); `class ProfileInvalid` (tag `'ProfileInvalid'`, field `issues: ReadonlyArray<Issue>`); `class ProfileFiles` (Context service with `readText(path): Effect<string | undefined, ReadFailed>` and `exists(path): Effect<boolean>`); `nodeFiles: Layer<ProfileFiles>`; `memoryFiles(files: Readonly<Record<string, string>>): Layer<ProfileFiles>`; `loadProfile(repoDir: string, options?: { overrides?: Input<MachineOverrides> }): Effect<DesiredConfig, ReadFailed, ProfileFiles>`; `requireValid(config: DesiredConfig): Effect<DesiredConfig, ProfileInvalid>`; `src/index.ts` re-exporting the public surface.

- [ ] **Step 1: Write the failing test**

`checks/load.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  ProfileFiles, ReadFailed, decodeOverrides, loadProfile, memoryFiles, nodeFiles, requireValid,
} from '../src/index.ts';

const hookDoc = JSON.stringify({
  version: 1,
  integrations: [{ id: 'h', label: 'h', target: 'claude', type: 'hook', default: true, event: 'Stop', file: 'hooks/h.sh' }],
});
const repo = {
  '/repo/skills-manifest.txt': '[a/core]\ntdd\n',
  '/repo/integrations.json': hookDoc,
  '/repo/hooks/h.sh': '#!/bin/sh\n',
  '/repo/claude/settings.keys.json': '{"effortLevel":"high"}',
  '/repo/skill-pins.json': JSON.stringify({ version: 1, pins: { 'a/core': 'abc' } }),
};
const run = <A, E>(effect: Effect.Effect<A, E, ProfileFiles>, layer = memoryFiles(repo)) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

test('loads every layer from the repo directory', async () => {
  const config = await run(loadProfile('/repo', { overrides: decodeOverrides({ version: 1, skills: { tdd: false } }, 'o.json') }));
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills.map((s) => [s.name, s.install, s.from.layer, s.pin?.ref]), [['tdd', false, 'machine', 'abc']]);
  assert.deepEqual(config.integrations.map((i) => i.id), ['h']);
  assert.equal(config.files.find((f) => f.id === 'claude:settings.json')!.keys!.effortLevel!.value, 'high');
});

test('a hook file missing from the repo refuses the integrations document', async () => {
  const { '/repo/hooks/h.sh': _hook, ...withoutHook } = repo;
  const config = await run(loadProfile('/repo'), memoryFiles(withoutHook));
  assert.deepEqual(config.integrations, []);
  assert.match(config.issues[0]!.message, /referenced file 'hooks\/h.sh' is not in the repo/);
});

test('an empty repo resolves to nothing declared, without issues', async () => {
  const config = await run(loadProfile('/repo'), memoryFiles({}));
  assert.deepEqual([config.skills, config.integrations, config.issues], [[], [], []]);
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {});
});

test('a read failure is ReadFailed, not an absent file', async () => {
  const failing = Layer.succeed(ProfileFiles, {
    readText: (path: string) => Effect.fail(new ReadFailed({ path, reason: 'denied' })),
    exists: () => Effect.succeed(false),
  });
  const error = await run(Effect.flip(loadProfile('/repo')), failing);
  assert.equal(error._tag, 'ReadFailed');
});

test('requireValid fails with every issue', async () => {
  const config = await run(loadProfile('/repo'), memoryFiles({ '/repo/integrations.json': '{', '/repo/skill-pins.json': '{' }));
  const error = await Effect.runPromise(Effect.flip(requireValid(config)));
  assert.equal(error._tag, 'ProfileInvalid');
  assert.deepEqual(error.issues.map((i) => i.layer), ['base', 'pin']);
  assert.equal(await Effect.runPromise(requireValid({ ...config, issues: [] })).then((c) => c.issues.length), 0);
});

test('nodeFiles reads real files, treats absence as undefined and other errors as ReadFailed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-engine-'));
  try {
    writeFileSync(join(dir, 'skills-manifest.txt'), '[a/b]\nx\n');
    const config = await run(loadProfile(dir), nodeFiles);
    assert.deepEqual(config.skills.map((s) => s.name), ['x']);

    mkdirSync(join(dir, 'integrations.json'));
    const error = await run(Effect.flip(loadProfile(dir)), nodeFiles);
    assert.equal(error._tag, 'ReadFailed');
    assert.equal(error.path, join(dir, 'integrations.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/profile-engine && npm test`
Expected: FAIL — cannot find module `../src/index.ts`.

- [ ] **Step 3: Implement**

`src/errors.ts`:

```ts
import { Data } from 'effect';
import type { Issue } from './model.ts';

// A profile document exists but could not be read. Distinct from an absent document.
export class ReadFailed extends Data.TaggedError('ReadFailed')<{ readonly path: string; readonly reason: string }> {}

// Resolution produced issues and the caller asked for all-or-nothing.
export class ProfileInvalid extends Data.TaggedError('ProfileInvalid')<{ readonly issues: ReadonlyArray<Issue> }> {}
```

`src/load.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import type { DesiredConfig, Input, MachineOverrides } from './model.ts';
import { ProfileInvalid, ReadFailed } from './errors.ts';
import { FILES } from './files.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { INTEGRATIONS_SOURCE, referencedFiles } from './integrations.ts';
import { PINS_SOURCE, parsePins } from './pins.ts';
import { buildBaseProfile } from './base.ts';
import { resolveProfile } from './resolve.ts';

// The filesystem as profile loading needs it: a document's text, or undefined when it is absent.
export class ProfileFiles extends Context.Service<
  ProfileFiles,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, ReadFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
  }
>()('profile-engine/ProfileFiles') {}

export const nodeFiles = Layer.succeed(ProfileFiles, {
  readText: (path: string) =>
    Effect.tryPromise({
      try: () =>
        readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        }),
      catch: (err) => new ReadFailed({ path, reason: err instanceof Error ? err.message : String(err) }),
    }),
  // Any failure reads as absent, matching the CLI's existsSync.
  exists: (path: string) => Effect.promise(() => stat(path).then(() => true, () => false)),
});

// Serves documents from a record keyed by absolute path; for tests and previews.
export const memoryFiles = (files: Readonly<Record<string, string>>) =>
  Layer.succeed(ProfileFiles, {
    readText: (path: string) => Effect.succeed(Object.hasOwn(files, path) ? files[path] : undefined),
    exists: (path: string) => Effect.succeed(Object.hasOwn(files, path)),
  });

// Reads a repository's profile documents and resolves them with optional machine overrides.
export const loadProfile = (
  repoDir: string,
  options: { readonly overrides?: Input<MachineOverrides> } = {},
): Effect.Effect<DesiredConfig, ReadFailed, ProfileFiles> =>
  Effect.gen(function* () {
    const files = yield* ProfileFiles;
    const read = (relative: string) => files.readText(join(repoDir, relative));

    const integrations = yield* read(INTEGRATIONS_SOURCE);
    const shipped = new Set<string>();
    for (const file of referencedFiles(integrations)) {
      if (yield* files.exists(join(repoDir, file))) shipped.add(file);
    }
    const settings: Record<string, string | undefined> = {};
    for (const file of FILES) {
      if (file.mode === 'merge-keys') settings[file.id] = yield* read(file.src);
    }

    const base = buildBaseProfile(
      { skillsManifest: yield* read(SKILLS_SOURCE), integrations, settings },
      (file) => shipped.has(file),
    );
    return resolveProfile({ base, pins: parsePins(yield* read(PINS_SOURCE)), overrides: options.overrides });
  });

// All-or-nothing: fails with every issue when resolution produced any.
export const requireValid = (config: DesiredConfig): Effect.Effect<DesiredConfig, ProfileInvalid> =>
  config.issues.length ? Effect.fail(new ProfileInvalid({ issues: config.issues })) : Effect.succeed(config);
```

`src/index.ts`:

```ts
export * from './model.ts';
export { ProfileInvalid, ReadFailed } from './errors.ts';
export { ProfileFiles, loadProfile, memoryFiles, nodeFiles, requireValid } from './load.ts';
export { buildBaseProfile } from './base.ts';
export type { BaseTexts } from './base.ts';
export { resolveProfile } from './resolve.ts';
export { FILES, FILES_SOURCE } from './files.ts';
export { SKILLS_SOURCE, parseSkillsManifest } from './skills.ts';
export { PINS_SOURCE, parsePins } from './pins.ts';
export { INTEGRATIONS_SOURCE, parseIntegrations, referencedFiles } from './integrations.ts';
export { parseSettingsKeys } from './settings.ts';
export { LEGACY_STATE_SOURCE, decodeOverrides, overridesFromLegacyState } from './overrides.ts';
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/profile-engine && npm test && npm run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/profile-engine/src/errors.ts packages/profile-engine/src/load.ts packages/profile-engine/src/index.ts packages/profile-engine/checks/load.spec.ts
git commit -m "feat: load profiles through an Effect file service"
```

---

### Task 8: Golden tests against the CLI, docs and full verification

**Files:**
- Create: `packages/profile-engine/checks/golden.spec.ts`, `packages/profile-engine/README.md`
- Modify: `CLAUDE.md` (root; Layout table — add one row after the `src/`, `bin/`, `test/` row)

**Interfaces:**
- Consumes: public exports from `src/index.ts`; root CLI modules `src/manifest.mjs` (`SYNC`), `src/config-mode.mjs` (`configEntries`, `parseConfigMode`), `src/skills.mjs` (`parseManifest`), `src/integrations/manifest.mjs` (`validateIntegrations`), `src/settings-keys.mjs` (`validateOwnedKeys`).
- Produces: nothing new for code.

- [ ] **Step 1: Write the golden test**

`checks/golden.spec.ts`:

```ts
// The CLI's own modules are the oracle: the engine must read today's documents exactly as they do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { SYNC } from '../../../src/manifest.mjs';
import { configEntries, parseConfigMode } from '../../../src/config-mode.mjs';
import { parseManifest } from '../../../src/skills.mjs';
import { validateIntegrations } from '../../../src/integrations/manifest.mjs';
import { validateOwnedKeys } from '../../../src/settings-keys.mjs';
import {
  FILES, loadProfile, nodeFiles, overridesFromLegacyState,
  type DesiredConfig, type FileEntry, type Input, type MachineOverrides,
} from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const load = (dir: string, overrides?: Input<MachineOverrides>) =>
  Effect.runPromise(loadProfile(dir, { overrides }).pipe(Effect.provide(nodeFiles)));

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseOrUndefined(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// An engine file entry in the CLI's SYNC shape.
function toSyncEntry(file: FileEntry): Record<string, unknown> {
  return {
    target: file.target,
    ...(file.home !== file.target ? { machine: file.home } : {}),
    src: file.src,
    dest: file.dest,
    mode: file.mode,
    ...(file.preserveProjects ? { preserveProjects: true } : {}),
    ...(file.capture ? {} : { capture: false }),
  };
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'profile-golden-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Compares settings, skills and integrations for one repo directory.
function assertDocumentsAgree(dir: string, config: DesiredConfig, label: string): void {
  const settingsText = readOptional(join(dir, 'claude/settings.keys.json'));
  const settingsValue = parseOrUndefined(settingsText);
  const legacyKeys =
    settingsValue === undefined || validateOwnedKeys(settingsValue).length > 0 ? undefined : settingsValue;
  const keys = config.files.find((f) => f.id === 'claude:settings.json')!.keys!;
  const engineKeys = Object.keys(keys).length
    ? Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.value]))
    : undefined;
  assert.deepEqual(engineKeys, legacyKeys, `${label}: settings keys`);

  const groups = parseManifest(readOptional(join(dir, 'skills-manifest.txt')) ?? '');
  const legacySkills = groups.flatMap((g: { source: string; skills: string[]; exact: boolean; optional?: boolean }) =>
    g.skills.map((name) => ({ name, source: g.source, exact: g.exact, optional: g.optional === true })),
  );
  assert.deepEqual(
    config.skills.map((s) => ({ name: s.name, source: s.source, exact: s.exact, optional: s.optional })),
    legacySkills,
    `${label}: skills`,
  );
  assert.ok(config.skills.every((s) => s.install === !s.optional), `${label}: default selection`);

  const integrationsText = readOptional(join(dir, 'integrations.json'));
  const parsed = parseOrUndefined(integrationsText);
  const legacy =
    integrationsText === undefined
      ? { integrations: [], allow: {}, errors: [] }
      : parsed === undefined
        ? { integrations: [], allow: {}, errors: ['invalid json'] }
        : validateIntegrations(parsed, { repo: dir });
  assert.deepEqual(config.integrations.map((i) => i.declaration), legacy.integrations, `${label}: integrations`);
  assert.deepEqual(config.allow, legacy.allow, `${label}: allow`);
  assert.equal(
    config.issues.some((i) => i.source === 'integrations.json'),
    legacy.errors.length > 0,
    `${label}: integrations refusal`,
  );
  assert.ok(config.integrations.every((i) => i.enabled === i.declaration.default), `${label}: enabled`);
}

test('the built-in file table equals the CLI SYNC table', () => {
  assert.deepEqual(FILES.map(toSyncEntry), SYNC);
});

test("this repository's configuration resolves as the CLI reads it", async () => {
  const config = await load(REPO);
  assert.deepEqual(config.issues, []);
  assertDocumentsAgree(REPO, config, 'repo');
});

test('managed files match the CLI for every legacy state record', async () => {
  const states: Array<string | undefined> = [
    undefined,
    '{',
    '{"files":{}}',
    '{"files":{},"skillsOnly":true}',
    '{"files":{},"skillsOnly":"true"}',
    '{"skillsOnly":true}',
    '{"files":{},"configTargets":["claude"]}',
    '{"files":{},"configTargets":["codex"]}',
    '{"files":{},"configTargets":[]}',
    '{"files":{},"configTargets":["codex","codex"]}',
    '{"files":{},"configTargets":["cursor"]}',
    '{"files":{},"skillsOnly":true,"configTargets":["claude"]}',
  ];
  const saved = { state: process.env.NORTUSCC_STATE_DIR, claude: process.env.NORTUSCC_CLAUDE_DIR };
  for (const state of states) {
    await withTempDir(async (dir) => {
      const stateDir = join(dir, 'state');
      mkdirSync(stateDir);
      mkdirSync(join(dir, 'claude'));
      if (state !== undefined) writeFileSync(join(stateDir, 'state.json'), state);
      process.env.NORTUSCC_STATE_DIR = stateDir;
      process.env.NORTUSCC_CLAUDE_DIR = join(dir, 'claude');
      try {
        const mode = parseConfigMode([]);
        const expected = mode.manageConfig ? configEntries(SYNC, 'all', mode.configTargets) : [];
        const config = await load(REPO, overridesFromLegacyState(state));
        assert.deepEqual(config.files.filter((f) => f.managed).map(toSyncEntry), expected, String(state));
      } finally {
        if (saved.state === undefined) delete process.env.NORTUSCC_STATE_DIR;
        else process.env.NORTUSCC_STATE_DIR = saved.state;
        if (saved.claude === undefined) delete process.env.NORTUSCC_CLAUDE_DIR;
        else process.env.NORTUSCC_CLAUDE_DIR = saved.claude;
      }
    });
  }
});

const plugin = { id: 'sp', label: 'sp', target: 'claude', type: 'plugin', default: true, plugin: 'sp@x' };
const hook = { id: 'h', label: 'h', target: 'claude', type: 'hook', default: false, event: 'Stop', file: 'hooks/h.sh' };
const integrationsDoc = (integrations: unknown[], extra: object = {}) =>
  JSON.stringify({ version: 1, integrations, ...extra });

const FIXTURES: Record<string, Record<string, string>> = {
  'empty repo': {},
  'manifest edge cases': {
    'skills-manifest.txt': 'orphan\r\n[a/b] exact optional typo\r\n  x  \r\n[a/b]\r\ny\r\n[c/d]\n# note\nz\n[e/f]\n',
  },
  'settings not json': { 'claude/settings.keys.json': '{' },
  'settings array': { 'claude/settings.keys.json': '[]' },
  'settings empty': { 'claude/settings.keys.json': '{}' },
  'settings secret name': { 'claude/settings.keys.json': '{"env":{"API_KEY":"x"}}' },
  'settings secret value': { 'claude/settings.keys.json': '{"a":["ghp_abcdefgh123"]}' },
  'settings valid': { 'claude/settings.keys.json': '{"theme":"auto","worktree":{"x":[1]}}' },
  'integrations not json': { 'integrations.json': '{' },
  'integrations wrong version': { 'integrations.json': JSON.stringify({ version: 2, integrations: [] }) },
  'integrations no array': { 'integrations.json': JSON.stringify({ version: 1 }) },
  'integrations duplicate': { 'integrations.json': integrationsDoc([plugin, plugin]) },
  'integrations secret': { 'integrations.json': integrationsDoc([{ ...plugin, note: 'sk-abcdef12' }]) },
  'integrations requiresEnv': { 'integrations.json': integrationsDoc([{ ...plugin, requiresEnv: ['API_KEY'] }]) },
  'hook shipped': { 'integrations.json': integrationsDoc([hook]), 'hooks/h.sh': '#!/bin/sh\n' },
  'hook missing': { 'integrations.json': integrationsDoc([hook]) },
  'allow valid': { 'integrations.json': integrationsDoc([plugin], { allow: { plugins: ['a@b'], skills: ['s'] } }) },
  'allow unknown category': { 'integrations.json': integrationsDoc([plugin], { allow: { widgets: ['a'] } }) },
};

for (const [label, files] of Object.entries(FIXTURES)) {
  test(`fixture agrees with the CLI: ${label}`, () =>
    withTempDir(async (dir) => {
      for (const [relative, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, relative)), { recursive: true });
        writeFileSync(join(dir, relative), text);
      }
      assertDocumentsAgree(dir, await load(dir), label);
    }));
}
```

- [ ] **Step 2: Run the golden tests**

Run: `cd packages/profile-engine && npm test`
Expected: PASS. If a golden case fails, the engine (not the test) is wrong unless the failure is in the test's own adaptation of the legacy shape — fix the engine module that disagrees and re-run, never loosen the comparison.

- [ ] **Step 3: Typecheck**

Run: `cd packages/profile-engine && npm run typecheck`
Expected: exits 0. If TypeScript cannot infer the legacy `.mjs` imports cleanly, add narrow local type annotations at the call sites in the spec file (as `assertDocumentsAgree` already does for `parseManifest` groups); do not enable `checkJs`.

- [ ] **Step 4: Write `packages/profile-engine/README.md`**

```markdown
# Profile engine

Resolves what a machine should have: the repository's base profile, approved revision pins
(`skill-pins.json`), and one machine's overrides. Every resolved value records the layer and
document that decided it. Design: `docs/superpowers/specs/2026-10-05-profile-engine-design.md`.

The engine reads today's `skills-manifest.txt`, `integrations.json` and
`claude/settings.keys.json` with the CLI's meaning. Golden tests in `checks/golden.spec.ts`
compare it with the CLI's own modules. Nothing in the CLI or the desktop app uses it yet; #42
wires it in.

Sources are TypeScript run directly by Node 22.18+ through type stripping, so there is no build
step. Node does not strip types inside `node_modules`; consume the package through a workspace or
`file:` link.

```sh
npm ci
npm test
npm run typecheck
```
```

- [ ] **Step 5: Add the layout row to root `CLAUDE.md`**

In the Layout table, directly after the row starting `` | `src/`, `bin/`, `test/` | ``, insert:

```markdown
| `packages/profile-engine/` | Shared TypeScript/Effect engine that resolves a machine's desired configuration — base profile, revision pins, machine overrides — with per-value provenance. Not yet used by the CLI |
```

- [ ] **Step 6: Run the root suite**

Run (repo root): `NORTUSCC_REPO_DIR=$PWD npm test 2>&1 | tail -8`
Expected: `pass 725`, `fail 0` — unchanged from the baseline; the root runner must not discover `packages/profile-engine/checks`.

- [ ] **Step 7: Commit**

```bash
git add packages/profile-engine/checks/golden.spec.ts packages/profile-engine/README.md CLAUDE.md
git commit -m "test: prove the profile engine reads config as the CLI does"
```
