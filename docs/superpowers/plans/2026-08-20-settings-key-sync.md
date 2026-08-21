# Settings Key Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `nortuscc` sync named keys of `~/.claude/settings.json` between machines, leaving every key it does not own exactly as it found it.

**Architecture:** A new manifest mode `merge-keys` alongside the existing `copy`. `src/settings-keys.mjs` is pure derivation — canonical serialization, per-key three-way state, validation — and imports no `node:fs`. `src/merge-keys.mjs` does every read and write, mirroring `src/copy.mjs`'s shape so `apply`, `capture` and `status` dispatch on `mode` and nothing else changes. Per-key baselines live beside the existing whole-file ones in the same state file, so the existing pure `fileState()` runs unchanged.

**Tech Stack:** Node 18+, plain ESM `.mjs`, zero dependencies. Tests use `node:test` and `node:assert/strict` only.

**Spec:** `docs/superpowers/specs/2026-08-20-settings-key-sync-design.md`

## Global Constraints

- Node 18+, plain ESM `.mjs`, no build step, **zero dependencies** — including test tooling.
- Tests use `node:test` and `node:assert/strict` only. Use `node:`-prefixed builtin imports throughout.
- Test-first: write the failing test, then the module. Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Run the suite with exactly `npm test`. Pass no path — `node --test test/` reports `pass 0 / fail 1` on Node 25.
- Baseline before any change: **605 tests pass, fail 0**. That number only goes up.
- Nothing destructive runs without a backup first. `~/.claude/settings.json` is the user's file; most of it is none of this tool's business.
- `status` is read-only by construction. No task may add a write to it.
- Comments state purpose, contract, or the WHY of a non-obvious choice — never a narration of the implementation.
- **The owned key set is exactly `effortLevel`, `tui`, `theme`, `worktree`.** Not `hooks` — `src/integrations/claude-hooks.mjs` already writes `settings.hooks`, and a second writer would let `apply` undo what `apply --install` registered. Not `permissions` or `enabledPlugins`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/secrets.mjs` | The credential-shaped name and value patterns, shared by two validators. |
| Create `src/settings-keys.mjs` | Pure: canonical serialization, per-key hashing and state, repo-file validation, stale-baseline detection. No `node:fs`. |
| Create `src/merge-keys.mjs` | All I/O for the mode: read both JSON documents, inspect, apply, capture. Mirrors `src/copy.mjs`. |
| Create `claude/settings.keys.json` | The owned keys and their values. Its key set is the allowlist. |
| Modify `src/integrations/manifest.mjs` | Import the shared patterns instead of holding its own copies. |
| Modify `src/manifest.mjs` | The `merge-keys` entry, and the comment above `SYNC` that currently says settings are excluded. |
| Modify `src/state.mjs` | One new BLOCKED state for a local file that cannot be parsed. |
| Modify `src/commands/apply.mjs`, `capture.mjs`, `status.mjs` | Dispatch the new mode. |
| Modify `README.md` | Document what is synced and what is deliberately not. |

**Two conventions used throughout.** A per-key baseline is stored under `` `${target}:${dest}#${key}` `` — `claude:settings.json#effortLevel`. And an absent value hashes to `null`, which is what the existing `fileState()` already reads as "not present on this side".

---

### Task 1: Share the credential patterns

**Files:**
- Create: `src/secrets.mjs`
- Modify: `src/integrations/manifest.mjs`
- Test: `test/secrets.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `looksLikeSecretName(name: string) => boolean`, `looksLikeSecretValue(text: string) => boolean`.

A later task validates `claude/settings.keys.json` against the same patterns `integrations.json` already uses. Copying the regex list would leave two copies to drift apart, so it moves to one module both import.

- [ ] **Step 1: Write the failing test**

Create `test/secrets.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeSecretName, looksLikeSecretValue } from '../src/secrets.mjs';

test('a field named like a credential is caught whatever its case or plural', () => {
  for (const name of ['token', 'Secret', 'passwords', 'apiKey', 'api_key', 'ACCESS_KEY', 'passphrase', 'credentials']) {
    assert.ok(looksLikeSecretName(name), `${name} should read as a credential name`);
  }
});

test('an ordinary field name is not a credential', () => {
  for (const name of ['effortLevel', 'theme', 'tui', 'worktree', 'tokenizer', 'keyboard']) {
    assert.equal(looksLikeSecretName(name), false, `${name} should not read as a credential name`);
  }
});

test('a credential-shaped value is caught wherever it appears', () => {
  assert.ok(looksLikeSecretValue('sk-abcd1234'));
  assert.ok(looksLikeSecretValue('ghp_abcdefgh12345678'));
  assert.ok(looksLikeSecretValue('AKIA0123456789AB'));
  assert.ok(looksLikeSecretValue('xoxb-abcdefgh-1234'));
  assert.ok(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----'));
});

test('ordinary text is not a credential value', () => {
  for (const text of ['high', 'fullscreen', 'auto', 'node_modules', '.cache']) {
    assert.equal(looksLikeSecretValue(text), false, `${text} should not read as a credential value`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/secrets.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/secrets.mjs`:

```js
// What a credential looks like, by name and by shape. Shared by every
// validator that guards a committed file, so the two cannot drift apart:
// integrations.json and claude/settings.keys.json are both public, and both
// may name an environment variable but never carry its value.

// Fields whose *name* alone means the value would be a credential.
const SECRET_FIELD = /^(token|secret|password|passphrase|credential|api_?key|access_?key)s?$/i;

// Shapes that are recognisably a credential wherever they appear, so a value
// smuggled into an innocuously named field is still caught.
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{4,}/,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{8,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecretName(name) {
  return SECRET_FIELD.test(name);
}

export function looksLikeSecretValue(text) {
  return SECRET_VALUE.some((pattern) => pattern.test(text));
}
```

Then in `src/integrations/manifest.mjs`: delete the `SECRET_FIELD` and `SECRET_VALUE` declarations along with their two comment blocks (the comments moved to `secrets.mjs`), add `import { looksLikeSecretName, looksLikeSecretValue } from '../secrets.mjs';` beside the existing imports, and change the two call sites inside `secretComplaints` from `SECRET_FIELD.test(field)` to `looksLikeSecretName(field)` and from `SECRET_VALUE.some((pattern) => pattern.test(text))` to `looksLikeSecretValue(text)`.

Leave `NAME_LIST_FIELDS` and every error message in that file exactly as they are — only the patterns move.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS. `test/integrations-manifest.test.mjs` must still pass untouched — it asserts the existing messages, which did not change.

- [ ] **Step 5: Commit**

```bash
git add src/secrets.mjs src/integrations/manifest.mjs test/secrets.test.mjs
git commit -m "refactor: share the credential patterns between validators"
```

---

### Task 2: Canonical serialization and per-key state

**Files:**
- Create: `src/settings-keys.mjs`
- Test: `test/settings-keys.test.mjs`

**Interfaces:**
- Consumes: `fileState` from `src/state.mjs`, `hashText` from `src/lock.mjs`.
- Produces: `canonical(value) => string`, `hashValue(value) => string|null`, `baselineKey(target, dest, key) => string`, `keyStates({owned, repo, local, baselines}) => Array<{key, state}>`, `staleBaselineKeys(files, prefix, owned) => string[]`.

`src/settings-keys.mjs` must import no `node:fs`. `lock.mjs` is safe to import: `hashText` is a pure digest, and `lock.mjs` imports only `resolve.mjs`, which does not import back.

- [ ] **Step 1: Write the failing test**

Create `test/settings-keys.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonical,
  hashValue,
  baselineKey,
  keyStates,
  staleBaselineKeys,
} from '../src/settings-keys.mjs';

// Key order is how a JSON document gets rewritten without changing meaning.
// Hashing the raw text would report that as drift on every machine.
test('canonical serialization is stable under key order', () => {
  assert.equal(
    canonical({ b: 1, a: { d: 2, c: 3 } }),
    canonical({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

// Arrays are ordered data, not a record: reordering them IS a change.
test('canonical serialization preserves array order', () => {
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']));
});

test('canonical serialization handles the scalar cases', () => {
  assert.equal(canonical('high'), '"high"');
  assert.equal(canonical(3), '3');
  assert.equal(canonical(true), 'true');
  assert.equal(canonical(null), 'null');
});

test('an absent value hashes to null, which is what fileState reads as absent', () => {
  assert.equal(hashValue(undefined), null);
  assert.ok(hashValue('high').startsWith('sha256:'));
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});

test('a baseline key names its target, its file and its key', () => {
  assert.equal(baselineKey('claude', 'settings.json', 'effortLevel'), 'claude:settings.json#effortLevel');
});

test('a key untouched on both sides is clean', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'auto' }, baselines });
  assert.deepEqual(states, [{ key: 'theme', state: 'clean' }]);
});

test('each side moving alone is reported as that side being ahead', () => {
  const baselines = { theme: hashValue('auto') };
  const repoAhead = keyStates({ owned: ['theme'], repo: { theme: 'dark' }, local: { theme: 'auto' }, baselines });
  assert.equal(repoAhead[0].state, 'repo-ahead');

  const localAhead = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'dark' }, baselines });
  assert.equal(localAhead[0].state, 'local-ahead');
});

test('both sides moving apart is a conflict', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'dark' }, local: { theme: 'light' }, baselines });
  assert.equal(states[0].state, 'conflict');
});

test('a key with no baseline is unmanaged, whether or not it is present locally', () => {
  assert.equal(keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: {} })[0].state, 'unmanaged');
  assert.equal(keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'x' } })[0].state, 'unmanaged');
});

// An absent local file is recoverable from the repo, exactly as a deleted
// managed file is.
test('a whole missing local document reads as the repo being ahead', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: null, baselines });
  assert.equal(states[0].state, 'repo-ahead');
});

test('a key the repo no longer declares is missing-repo, not silently clean', () => {
  const states = keyStates({ owned: ['gone'], repo: {}, local: { gone: 'x' }, baselines: {} });
  assert.equal(states[0].state, 'missing-repo');
});

// A key dropped from the repo file stops being owned; its baseline must not
// linger, or the state file accumulates records nothing will ever reconcile.
test('baselines for keys no longer owned are identified for pruning', () => {
  const files = {
    'claude:CLAUDE.md': { hash: 'x' },
    'claude:settings.json#theme': { hash: 'y' },
    'claude:settings.json#gone': { hash: 'z' },
  };
  assert.deepEqual(
    staleBaselineKeys(files, 'claude:settings.json', ['theme']),
    ['claude:settings.json#gone'],
  );
});

test('pruning never touches a whole-file baseline that merely shares the prefix', () => {
  const files = { 'claude:settings.json': { hash: 'x' } };
  assert.deepEqual(staleBaselineKeys(files, 'claude:settings.json', []), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/settings-keys.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/settings-keys.mjs`:

```js
// Pure derivation for key-level sync: no node:fs, no reads, no writes.
// src/merge-keys.mjs does every I/O operation and hands parsed documents here,
// the same split src/state.mjs and src/copy.mjs already draw.
import { fileState } from './state.mjs';
import { hashText } from './lock.mjs';

// A JSON document can be rewritten with its keys in a different order and mean
// exactly the same thing — agents rewrite these files in place, so that
// happens. Digesting the raw text would report it as drift on every machine.
// Arrays are left in order: they are ordered data, and reordering one IS a
// change.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// null rather than a digest of "undefined": fileState already reads null as
// "not present on this side", so an absent key needs no special case there.
export function hashValue(value) {
  return value === undefined ? null : hashText(canonical(value));
}

// `claude:settings.json#effortLevel`. The `#` separates the document from the
// key inside it, so a per-key baseline can never collide with the whole-file
// baseline of a copied entry.
export function baselineKey(target, dest, key) {
  return `${target}:${dest}#${key}`;
}

// One three-way state per owned key, from the same pure state machine that
// classifies whole files. `local` is null when the document itself is absent,
// which makes every key read as the repo being ahead — recoverable, not lost.
export function keyStates({ owned, repo = {}, local = null, baselines = {} }) {
  return owned.map((key) => ({
    key,
    state: fileState({
      baseline: baselines[key],
      repo: hashValue(repo[key]),
      local: local === null ? null : hashValue(local[key]),
    }),
  }));
}

// Baselines under this document's prefix whose key is no longer owned. A key
// dropped from the repo file stops being managed, and leaving its baseline
// behind would accumulate records nothing will ever reconcile again.
//
// The `#` is required, so the whole-file baseline of a copied entry sharing
// this prefix is never mistaken for a stale key.
export function staleBaselineKeys(files, prefix, owned) {
  const keep = new Set(owned);
  return Object.keys(files)
    .filter((recorded) => recorded.startsWith(`${prefix}#`))
    .filter((recorded) => !keep.has(recorded.slice(prefix.length + 1)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-keys.mjs test/settings-keys.test.mjs
git commit -m "feat: derive per-key sync state from canonical values"
```

---

### Task 3: Refuse a repo file that carries a credential

**Files:**
- Modify: `src/settings-keys.mjs`
- Test: `test/settings-keys.test.mjs`

**Interfaces:**
- Consumes: `looksLikeSecretName`, `looksLikeSecretValue` from Task 1.
- Produces: `validateOwnedKeys(parsed) => string[]` — an array of error messages, empty when the document is acceptable.

The repo file's key set is already the allowlist: nothing enumerates the local document's keys, so a key that exists only on a machine is never read. This is defence in depth on top of that — `claude/settings.keys.json` is committed and public.

- [ ] **Step 1: Write the failing test**

Append to `test/settings-keys.test.mjs`, merging `validateOwnedKeys` into the existing import from `../src/settings-keys.mjs`:

```js
test('an ordinary settings document validates', () => {
  const errors = validateOwnedKeys({
    effortLevel: 'high',
    tui: 'fullscreen',
    theme: 'auto',
    worktree: { symlinkDirectories: ['node_modules', '.cache'] },
  });
  assert.deepEqual(errors, []);
});

test('a document that is not an object is refused', () => {
  assert.ok(validateOwnedKeys(null).some((e) => /must be a JSON object/.test(e)));
  assert.ok(validateOwnedKeys(['theme']).some((e) => /must be a JSON object/.test(e)));
});

test('an empty document is refused rather than silently owning nothing', () => {
  assert.ok(validateOwnedKeys({}).some((e) => /names no keys/.test(e)));
});

// This file is committed and public. The allowlist already makes a local
// secret unreachable; this stops one being written INTO the repo.
test('a key named like a credential is refused, at any depth', () => {
  assert.ok(validateOwnedKeys({ apiKey: 'x' }).some((e) => /looks like a secret/.test(e)));
  assert.ok(
    validateOwnedKeys({ worktree: { token: 'x' } }).some((e) => /looks like a secret/.test(e)),
  );
});

test('a credential-shaped value is refused, at any depth', () => {
  assert.ok(
    validateOwnedKeys({ theme: 'sk-abcd1234' }).some((e) => /looks like a secret value/.test(e)),
  );
  assert.ok(
    validateOwnedKeys({ worktree: { dirs: ['ghp_abcdefgh12345678'] } }).some((e) =>
      /looks like a secret value/.test(e),
    ),
  );
});

test('every complaint names the key it is about', () => {
  const errors = validateOwnedKeys({ worktree: { token: 'x' } });
  assert.ok(errors.some((e) => /worktree\.token/.test(e)), errors.join('; '));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `validateOwnedKeys is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add the import at the top of `src/settings-keys.mjs`:

```js
import { looksLikeSecretName, looksLikeSecretValue } from './secrets.mjs';
```

And append:

```js
// Walks the whole document, not just its top level: an owned key's value can
// be an object, and a credential nested inside one is still a credential in a
// committed file.
function secretComplaints(value, path, errors) {
  if (typeof value === 'string') {
    if (looksLikeSecretValue(value)) {
      errors.push(`settings key '${path}' contains what looks like a secret value`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => secretComplaints(entry, `${path}[${index}]`, errors));
    return;
  }
  if (value === null || typeof value !== 'object') return;

  for (const [name, nested] of Object.entries(value)) {
    const where = path ? `${path}.${name}` : name;
    if (looksLikeSecretName(name)) {
      errors.push(`settings key '${where}' looks like a secret; this file is committed`);
      continue;
    }
    secretComplaints(nested, where, errors);
  }
}

// The repo's declaration of which keys it owns, and their values. Refused
// rather than partially honoured: a document this cannot vouch for must not
// decide what gets written into the user's settings.
export function validateOwnedKeys(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return ['settings.keys.json must be a JSON object'];
  }

  const errors = [];
  if (Object.keys(parsed).length === 0) {
    // An empty file owns nothing, which is indistinguishable from a mistake.
    // Deleting the manifest entry is how you turn this off.
    errors.push('settings.keys.json names no keys; remove the manifest entry instead');
  }

  secretComplaints(parsed, '', errors);
  return errors;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings-keys.mjs test/settings-keys.test.mjs
git commit -m "feat: refuse a settings key file that carries a credential"
```

---

### Task 4: Read and inspect both documents

**Files:**
- Create: `src/merge-keys.mjs`
- Modify: `src/state.mjs`
- Test: `test/merge-keys.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2 and 3.
- Produces: `readDocument(path) => {value, existed, corrupt}`, `inspectMerge(src, dest, prefix, lock) => {state, keys, owned, repo, local}`. `src/state.mjs` gains `'unparseable-local'` in its `BLOCKED` set.

- [ ] **Step 1: Write the failing test**

Create `test/merge-keys.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDocument, inspectMerge } from '../src/merge-keys.mjs';
import { hashValue, baselineKey } from '../src/settings-keys.mjs';

const PREFIX = 'claude:settings.json';

function fixture({ repo, local }) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-merge-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const src = join(dir, 'repo', 'settings.keys.json');
  const dest = join(dir, 'home', 'settings.json');
  if (repo !== undefined) writeFileSync(src, typeof repo === 'string' ? repo : JSON.stringify(repo));
  if (local !== undefined) writeFileSync(dest, typeof local === 'string' ? local : JSON.stringify(local));
  return { src, dest };
}

const lockWith = (entries = {}) => ({ files: entries });

test('readDocument distinguishes absent from unparseable', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: '{ not json' });
  assert.deepEqual(readDocument(src), { value: { theme: 'auto' }, existed: true, corrupt: false });
  assert.deepEqual(readDocument(dest), { value: null, existed: true, corrupt: true });
  assert.deepEqual(readDocument(join(dest, 'nope')), { value: null, existed: false, corrupt: false });
});

// A JSON array or scalar where an object belongs is not a settings document.
test('readDocument treats a non-object document as corrupt', () => {
  const { src } = fixture({ repo: '["theme"]' });
  assert.equal(readDocument(src).corrupt, true);
});

test('a matching pair with a current baseline is clean', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'auto', permissions: {} } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  const result = inspectMerge(src, dest, PREFIX, lock);
  assert.equal(result.state, 'clean');
  assert.deepEqual(result.keys, [{ key: 'theme', state: 'clean' }]);
  assert.deepEqual(result.owned, ['theme']);
});

// The worst state wins, so one conflicting key cannot hide behind three clean
// ones — the caller decides what to do from a single answer.
test('the rolled-up state is the most severe of the keys', () => {
  const { src, dest } = fixture({
    repo: { theme: 'dark', tui: 'fullscreen' },
    local: { theme: 'light', tui: 'fullscreen' },
  });
  const lock = lockWith({
    [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') },
    [baselineKey('claude', 'settings.json', 'tui')]: { hash: hashValue('fullscreen') },
  });

  const result = inspectMerge(src, dest, PREFIX, lock);
  assert.equal(result.state, 'conflict');
});

test('an absent repo file is missing-repo and nothing else is read', () => {
  const { src, dest } = fixture({ local: { theme: 'auto' } });
  assert.equal(inspectMerge(src, dest, PREFIX, lockWith()).state, 'missing-repo');
});

test('an invalid repo file is missing-repo, carrying its complaints', () => {
  const { src, dest } = fixture({ repo: { apiKey: 'x' }, local: { theme: 'auto' } });
  const result = inspectMerge(src, dest, PREFIX, lockWith());
  assert.equal(result.state, 'missing-repo');
  assert.ok(result.errors.some((e) => /looks like a secret/.test(e)));
});

// The user's own file, mid-edit or hand-broken, is never ours to replace.
test('an unparseable local file is blocked, not overwritten', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: '{ not json' });
  assert.equal(inspectMerge(src, dest, PREFIX, lockWith()).state, 'unparseable-local');
});

test('an absent local file makes every owned key unmanaged', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto', tui: 'fullscreen' } });
  const result = inspectMerge(src, dest, PREFIX, lockWith());
  assert.deepEqual(result.keys.map((k) => k.state), ['unmanaged', 'unmanaged']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/merge-keys.mjs'`.

- [ ] **Step 3: Write minimal implementation**

In `src/state.mjs`, change the `BLOCKED` declaration and extend the comment above it:

```js
// 'unparseable-local' is the merge-keys equivalent of a conflict the tool must
// not resolve: the user's settings.json could not be read, so no part of it is
// ours to rewrite.
export const BLOCKED = new Set(['conflict', 'missing-repo', 'unknown-mode', 'unparseable-local']);
```

Create `src/merge-keys.mjs`:

```js
// Key-level sync: repo <-> machine for named keys of a JSON document, leaving
// every key the repo does not name exactly as it was found.
//
// Mirrors src/copy.mjs — same action vocabulary, same force semantics, same
// backup-before-write rule — so apply, capture and status dispatch on `mode`
// and need to know nothing else. src/settings-keys.mjs holds the derivation;
// this file does the I/O.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { NEEDS_APPLY, NEEDS_CAPTURE } from './state.mjs';
import { setBaseline } from './lock.mjs';
import { preserveCopy } from './backup.mjs';
import { hashValue, keyStates, staleBaselineKeys, validateOwnedKeys } from './settings-keys.mjs';

// Absent and unreadable are different answers. A machine that has never run
// the agent has no settings file, which is ordinary; a file that will not parse
// is the user's, mid-edit or hand-broken, and never ours to replace.
export function readDocument(path) {
  if (!existsSync(path)) return { value: null, existed: false, corrupt: false };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: null, existed: true, corrupt: true };
    }
    return { value: parsed, existed: true, corrupt: false };
  } catch {
    return { value: null, existed: true, corrupt: true };
  }
}

// Most severe first: one conflicting key must not hide behind clean ones.
// Each state is named explicitly rather than tested against the BLOCKED set,
// which would collapse `missing-repo` into `conflict` and mislabel it.
function rollUp(keys) {
  if (keys.some((k) => k.state === 'conflict')) return 'conflict';
  if (keys.some((k) => k.state === 'missing-repo')) return 'missing-repo';
  if (keys.some((k) => NEEDS_CAPTURE.has(k.state))) return 'local-ahead';
  if (keys.some((k) => NEEDS_APPLY.has(k.state))) return 'repo-ahead';
  return 'clean';
}

function baselinesUnder(lock, prefix, owned) {
  const found = {};
  for (const key of owned) found[key] = lock.files[`${prefix}#${key}`]?.hash;
  return found;
}

// `prefix` is the state-file prefix for this document — `claude:settings.json`.
export function inspectMerge(src, dest, prefix, lock) {
  const repo = readDocument(src);
  // A repo file that is absent, unreadable or refused decides nothing. Every
  // command already knows to leave missing-repo alone.
  if (!repo.existed || repo.corrupt) {
    return { state: 'missing-repo', keys: [], owned: [], repo: null, local: null, errors: [] };
  }
  const errors = validateOwnedKeys(repo.value);
  if (errors.length) {
    return { state: 'missing-repo', keys: [], owned: [], repo: null, local: null, errors };
  }

  const owned = Object.keys(repo.value);
  const local = readDocument(dest);
  if (local.corrupt) {
    return { state: 'unparseable-local', keys: [], owned, repo: repo.value, local: null, errors: [] };
  }

  const keys = keyStates({
    owned,
    repo: repo.value,
    local: local.existed ? local.value : null,
    baselines: baselinesUnder(lock, prefix, owned),
  });

  return { state: rollUp(keys), keys, owned, repo: repo.value, local: local.existed ? local.value : {}, errors: [] };
}
```

Note: `staleBaselineKeys`, `hashValue`, `setBaseline`, `preserveCopy`, `writeFileSync`, `mkdirSync` and `dirname` are imported here for Tasks 5 and 6, which append to this file. Leaving them unused for one task is deliberate — the alternative is editing the import block three times.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS. Existing `test/state.test.mjs` must still pass — `BLOCKED` gained a member and lost none.

- [ ] **Step 5: Commit**

```bash
git add src/merge-keys.mjs src/state.mjs test/merge-keys.test.mjs
git commit -m "feat: inspect a settings document key by key"
```

---

### Task 5: Apply owned keys to the machine

**Files:**
- Modify: `src/merge-keys.mjs`
- Test: `test/merge-keys.test.mjs`

**Interfaces:**
- Consumes: `inspectMerge` from Task 4.
- Produces: `applyMerge(src, dest, prefix, lock, {force, relative, agent}) => {action, backedUp, keys}` where `action` is `'copied' | 'skipped' | 'refused'`, matching `applyCopy`'s vocabulary.

- [ ] **Step 1: Write the failing test**

Append to `test/merge-keys.test.mjs`, merging `applyMerge` into the existing import from `../src/merge-keys.mjs` and adding `readFileSync` to the existing `node:fs` import:

```js
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The whole point: everything the repo does not name survives untouched.
test('apply writes owned keys and leaves every other key alone', () => {
  const { src, dest } = fixture({
    repo: { theme: 'dark' },
    local: { theme: 'auto', permissions: { allow: ['Bash(ls:*)'] }, enabledPlugins: { a: true } },
  });
  const lock = lockWith();

  const result = applyMerge(src, dest, PREFIX, lock);
  assert.equal(result.action, 'copied');

  const after = read(dest);
  assert.equal(after.theme, 'dark');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(after.enabledPlugins, { a: true });
});

test('apply records a baseline per key it wrote', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark' }, local: { theme: 'auto' } });
  const lock = lockWith();
  applyMerge(src, dest, PREFIX, lock);
  assert.equal(lock.files[baselineKey('claude', 'settings.json', 'theme')].hash, hashValue('dark'));
});

test('apply creates the document when the machine has none', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark', tui: 'fullscreen' } });
  assert.equal(applyMerge(src, dest, PREFIX, lockWith()).action, 'copied');
  assert.deepEqual(read(dest), { theme: 'dark', tui: 'fullscreen' });
});

// apply's direction is repo -> machine; a local edit is capture's business.
test('apply leaves a locally-ahead key alone', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'dark' } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  assert.equal(applyMerge(src, dest, PREFIX, lock).action, 'skipped');
  assert.equal(read(dest).theme, 'dark');
});

test('apply refuses a conflicting key and changes nothing', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark' }, local: { theme: 'light' } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  const result = applyMerge(src, dest, PREFIX, lock);
  assert.equal(result.action, 'refused');
  assert.equal(read(dest).theme, 'light');
});

test('--take-repo resolves a conflicting key', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark' }, local: { theme: 'light' } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  assert.equal(applyMerge(src, dest, PREFIX, lock, { force: true }).action, 'copied');
  assert.equal(read(dest).theme, 'dark');
});

test('apply writes nothing when the local document cannot be parsed', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark' }, local: '{ not json' });
  const result = applyMerge(src, dest, PREFIX, lockWith());
  assert.equal(result.action, 'refused');
  assert.equal(readFileSync(dest, 'utf8'), '{ not json');
});

test('an already-clean document is not rewritten', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'auto', permissions: {} } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });
  assert.equal(applyMerge(src, dest, PREFIX, lock).action, 'skipped');
});

test('apply prunes the baseline of a key the repo no longer owns', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'auto' } });
  const lock = lockWith({
    [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') },
    [baselineKey('claude', 'settings.json', 'gone')]: { hash: 'stale' },
  });

  applyMerge(src, dest, PREFIX, lock);
  assert.equal(lock.files[baselineKey('claude', 'settings.json', 'gone')], undefined);
  assert.ok(lock.files[baselineKey('claude', 'settings.json', 'theme')]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `applyMerge is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/merge-keys.mjs`:

```js
function writeDocument(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  // Same serialization claude-hooks.mjs already uses for this file. It
  // normalises the whole document's formatting on first write, which is worth
  // knowing: the keys this tool does not own keep their values, not their
  // whitespace.
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// Drop baselines for keys the repo file no longer names, so a key removed from
// the manifest leaves no record behind to be reconciled against forever.
function prune(lock, prefix, owned) {
  for (const recorded of staleBaselineKeys(lock.files, prefix, owned)) delete lock.files[recorded];
}

// repo -> machine, per key. Refuses a conflict unless force is set, never
// touches a key whose only change is local, and never touches a key the repo
// file does not name.
export function applyMerge(src, dest, prefix, lock, { force = false, relative = dest, agent = null } = {}) {
  const inspected = inspectMerge(src, dest, prefix, lock);

  if (inspected.state === 'missing-repo') return { action: 'skipped', backedUp: null, keys: [] };
  if (inspected.state === 'unparseable-local') {
    // Nothing is preserved because nothing is being overwritten — the file is
    // exactly as the user left it.
    return { action: 'refused', backedUp: null, keys: [] };
  }

  const conflicts = inspected.keys.filter((k) => k.state === 'conflict');
  if (conflicts.length > 0 && !force) {
    // Preserve the local side even though nothing is being written, so the
    // user can resolve from a stable copy while continuing to work.
    return { action: 'refused', backedUp: preserveCopy(dest, relative, agent), keys: conflicts };
  }

  const writing = inspected.keys.filter(
    (k) => NEEDS_APPLY.has(k.state) || (force && k.state === 'conflict'),
  );

  if (writing.length === 0) {
    // Converged: both sides already agree, so only the baseline is stale.
    // Restamping without writing keeps a clean machine's settings file — and
    // its mtime — untouched by a no-op run.
    for (const { key } of inspected.keys) {
      setBaseline(lock, `${prefix}#${key}`, hashValue(inspected.repo[key]));
    }
    prune(lock, prefix, inspected.owned);
    return { action: 'skipped', backedUp: null, keys: [] };
  }

  // Copy rather than move: the rest of this document has to stay where it is,
  // because what follows rewrites it in place rather than replacing it.
  const backedUp = preserveCopy(dest, relative, agent);

  const next = { ...inspected.local };
  for (const { key } of writing) next[key] = inspected.repo[key];
  writeDocument(dest, next);

  for (const { key } of inspected.keys) {
    setBaseline(lock, `${prefix}#${key}`, hashValue(inspected.repo[key]));
  }
  prune(lock, prefix, inspected.owned);

  return { action: 'copied', backedUp, keys: writing };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merge-keys.mjs test/merge-keys.test.mjs
git commit -m "feat: apply owned settings keys without disturbing the rest"
```

---

### Task 6: Capture owned keys back to the repo

**Files:**
- Modify: `src/merge-keys.mjs`
- Test: `test/merge-keys.test.mjs`

**Interfaces:**
- Consumes: `inspectMerge` from Task 4, the private `writeDocument` and `prune` from Task 5.
- Produces: `captureMerge(src, dest, prefix, lock, {force, relative, agent}) => {action, backedUp, keys}`.

- [ ] **Step 1: Write the failing test**

Append to `test/merge-keys.test.mjs`, merging `captureMerge` into the existing import:

```js
test('capture writes a locally-ahead key back to the repo', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'dark' } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  assert.equal(captureMerge(src, dest, PREFIX, lock).action, 'copied');
  assert.deepEqual(read(src), { theme: 'dark' });
});

// The repo file's key set is the allowlist. capture reads the keys it names
// and never enumerates the local document, so an extra cannot be adopted.
test('capture never adopts a key the repo does not already name', () => {
  const { src, dest } = fixture({
    repo: { theme: 'auto' },
    local: { theme: 'dark', permissions: { allow: [] }, apiKey: 'sk-abcd1234' },
  });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  captureMerge(src, dest, PREFIX, lock);
  assert.deepEqual(Object.keys(read(src)), ['theme']);
});

// capture's direction is machine -> repo; a repo edit is apply's business.
test('capture leaves a repo-ahead key alone', () => {
  const { src, dest } = fixture({ repo: { theme: 'dark' }, local: { theme: 'auto' } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  assert.equal(captureMerge(src, dest, PREFIX, lock).action, 'skipped');
  assert.equal(read(src).theme, 'dark');
});

test('capture refuses a conflicting key, and --take-local resolves it', () => {
  const conflicted = () => {
    const paths = fixture({ repo: { theme: 'dark' }, local: { theme: 'light' } });
    const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });
    return { ...paths, lock };
  };

  const refused = conflicted();
  assert.equal(captureMerge(refused.src, refused.dest, PREFIX, refused.lock).action, 'refused');
  assert.equal(read(refused.src).theme, 'dark');

  const forced = conflicted();
  assert.equal(captureMerge(forced.src, forced.dest, PREFIX, forced.lock, { force: true }).action, 'copied');
  assert.equal(read(forced.src).theme, 'light');
});

test('capture writes nothing when the local document cannot be parsed', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: '{ not json' });
  assert.equal(captureMerge(src, dest, PREFIX, lockWith()).action, 'refused');
  assert.deepEqual(read(src), { theme: 'auto' });
});

// An owned key the machine simply does not have yet is not a deletion.
test('capture skips an owned key absent from the local document', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto', tui: 'fullscreen' }, local: { theme: 'auto' } });
  const lock = lockWith({
    [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') },
    [baselineKey('claude', 'settings.json', 'tui')]: { hash: hashValue('fullscreen') },
  });

  captureMerge(src, dest, PREFIX, lock);
  assert.equal(read(src).tui, 'fullscreen');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `captureMerge is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/merge-keys.mjs`:

```js
// machine -> repo. Mirrors applyMerge with the directions swapped, and reads
// only the keys the repo file already names: capture must not turn a local
// extra into policy for every other machine.
export function captureMerge(src, dest, prefix, lock, { force = false, relative = dest, agent = null } = {}) {
  const inspected = inspectMerge(src, dest, prefix, lock);

  if (inspected.state === 'missing-repo') return { action: 'skipped', backedUp: null, keys: [] };
  if (inspected.state === 'unparseable-local') return { action: 'refused', backedUp: null, keys: [] };

  const conflicts = inspected.keys.filter((k) => k.state === 'conflict');
  if (conflicts.length > 0 && !force) {
    return { action: 'refused', backedUp: preserveCopy(dest, relative, agent), keys: conflicts };
  }

  // A key the machine does not have is not a deletion — see the spec: with one
  // baseline hash there is no way to tell "never had it" from "removed it", so
  // an absent local value is left as the repo has it.
  const writing = inspected.keys.filter(
    (k) =>
      (NEEDS_CAPTURE.has(k.state) || (force && k.state === 'conflict')) &&
      inspected.local[k.key] !== undefined,
  );

  if (writing.length === 0) {
    for (const { key } of inspected.keys) {
      if (inspected.local[key] !== undefined) {
        setBaseline(lock, `${prefix}#${key}`, hashValue(inspected.local[key]));
      }
    }
    prune(lock, prefix, inspected.owned);
    return { action: 'skipped', backedUp: null, keys: [] };
  }

  // The repo file is a working-tree file: an uncommitted edit to it is not
  // recoverable from git, so preserve it before it is rewritten.
  const backedUp = preserveCopy(src, `${relative}.repo`, agent);

  const next = { ...inspected.repo };
  for (const { key } of writing) next[key] = inspected.local[key];
  writeDocument(src, next);

  for (const { key } of inspected.keys) {
    if (inspected.local[key] !== undefined) {
      setBaseline(lock, `${prefix}#${key}`, hashValue(next[key]));
    }
  }
  prune(lock, prefix, inspected.owned);

  return { action: 'copied', backedUp, keys: writing };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/merge-keys.mjs test/merge-keys.test.mjs
git commit -m "feat: capture owned settings keys back to the repo"
```

---

### Task 7: Declare the entry and wire apply and capture

**Files:**
- Create: `claude/settings.keys.json`
- Modify: `src/manifest.mjs`, `src/commands/apply.mjs`, `src/commands/capture.mjs`
- Test: `test/apply.test.mjs`, `test/capture.test.mjs`

**Interfaces:**
- Consumes: `applyMerge`, `captureMerge`.
- Produces: a `SYNC` entry with `mode: 'merge-keys'`.

The repo file is **hand-written here with this machine's current values**, not captured. Seeding it by running `capture` would silently make one machine the source of truth for every other.

- [ ] **Step 1: Write the failing test**

Append to `test/apply.test.mjs` — it already has a fixture repo and home driven by `NORTUSCC_*` env vars; use whatever names that file already binds them to:

```js
test('apply writes the declared settings keys and leaves the rest of the file alone', async () => {
  const settingsSrc = join(repo, 'claude', 'settings.keys.json');
  writeFileSync(settingsSrc, JSON.stringify({ theme: 'dark' }) + '\n');
  const settingsDest = join(claude, 'settings.json');
  writeFileSync(settingsDest, JSON.stringify({ theme: 'auto', permissions: { allow: ['Bash(ls:*)'] } }) + '\n');

  assert.equal(await run([]), 0);

  const after = JSON.parse(readFileSync(settingsDest, 'utf8'));
  assert.equal(after.theme, 'dark', 'the declared key is applied');
  assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] }, 'an undeclared key is untouched');
});

// A machine that keeps its own instruction files keeps its own settings too.
// The entry sits in SYNC, so parseConfigMode already filters it — this pins
// that, because the failure mode is writing a stranger's preferences into a
// user's file.
test('--skills-only leaves the settings file alone', async () => {
  const settingsSrc = join(repo, 'claude', 'settings.keys.json');
  writeFileSync(settingsSrc, JSON.stringify({ theme: 'dark' }) + '\n');
  const settingsDest = join(claude, 'settings.json');
  const before = JSON.stringify({ theme: 'auto' }) + '\n';
  writeFileSync(settingsDest, before);

  await run(['--skills-only']);

  assert.equal(readFileSync(settingsDest, 'utf8'), before, 'nothing was written');

  // Leave the recorded mode as this file's other tests expect to find it.
  await run(['--no-skills-only']);
});
```

Append to `test/capture.test.mjs`:

```js
test('capture writes a local settings key back to the repo without adopting extras', async () => {
  const settingsSrc = join(repo, 'claude', 'settings.keys.json');
  writeFileSync(settingsSrc, JSON.stringify({ theme: 'auto' }) + '\n');
  writeFileSync(
    join(claude, 'settings.json'),
    JSON.stringify({ theme: 'dark', permissions: { allow: [] } }) + '\n',
  );

  await captureRun([]);

  const captured = JSON.parse(readFileSync(settingsSrc, 'utf8'));
  assert.equal(captured.theme, 'dark');
  assert.deepEqual(Object.keys(captured), ['theme'], 'capture never adopts an undeclared key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — the entry does not exist yet, so `theme` is never applied or captured. The apply test fails on `after.theme`.

- [ ] **Step 3: Write minimal implementation**

Create `claude/settings.keys.json` with this machine's current values:

```json
{
  "effortLevel": "high",
  "tui": "fullscreen",
  "theme": "auto",
  "worktree": {
    "symlinkDirectories": ["node_modules", ".cache"]
  }
}
```

In `src/manifest.mjs`, replace the paragraph of the leading comment that begins "Only portable instruction files are managed" with:

```js
// mode: 'merge-keys' — a settings file mixes portable rules with permissions,
//                UI preferences and machine-specific state. Sync the keys the
//                repo names and leave every other key exactly as found. The
//                key set in the repo's file IS the allowlist: nothing here
//                enumerates the machine's own keys, so a local secret can
//                never be picked up.
//
// `hooks` is deliberately not owned. src/integrations/claude-hooks.mjs already
// writes settings.hooks, and a second writer would let `apply` undo what
// `apply --install` registered; `status` already reports undeclared hooks.
```

and add to `SYNC`:

```js
  { target: 'claude', src: 'claude/settings.keys.json', dest: 'settings.json', mode: 'merge-keys' },
```

In `src/commands/apply.mjs`, add `import { applyMerge } from '../merge-keys.mjs';` and replace the `if (mode !== 'copy')` guard in the entry loop with a dispatch. The existing body that calls `applyCopy` stays as the `copy` branch:

```js
    if (mode === 'merge-keys') {
      const res = applyMerge(src, dest, `${entry.target}:${entry.dest}`, lock, {
        force: takeRepo,
        relative: entry.dest,
        agent: entry.target,
      });
      if (res.action === 'refused') refused += 1;
      if (res.action === 'copied') changed = true;
      lines.push(formatRow(entry.dest, res.action, noteFor(res)));
      continue;
    }

    if (mode !== 'copy') {
      // Unknown mode: apply has no idea how to remediate this entry, so it is
      // reported and left alone rather than guessed at — the same treatment
      // as missing-repo and conflict, which are also BLOCKED states.
      lines.push(formatRow(entry.dest, 'unknown-mode', 'manifest entry has an unrecognized mode'));
      continue;
    }
```

In `src/commands/capture.mjs`, add `import { captureMerge } from '../merge-keys.mjs';` and make the same dispatch. Note that this loop resolves `src`/`dest` *after* its mode check, so resolve first:

```js
    const { src, dest } = resolveEntry(entry);

    if (entry.mode === 'merge-keys') {
      const res = captureMerge(src, dest, `${entry.target}:${entry.dest}`, lock, {
        force: takeLocal,
        relative: entry.dest,
        agent: entry.target,
      });
      if (res.action === 'refused') refused += 1;
      if (res.action === 'copied') captured.push(entry.src);
      lines.push(formatRow(entry.dest, res.action, noteFor(res)));
      continue;
    }

    if (entry.mode !== 'copy') {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude/settings.keys.json src/manifest.mjs src/commands/apply.mjs src/commands/capture.mjs test/apply.test.mjs test/capture.test.mjs
git commit -m "feat: sync the declared settings keys"
```

---

### Task 8: Report drift per key

**Files:**
- Modify: `src/commands/status.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `inspectMerge`.
- Produces: `configReport` returns one row per *drifted* key for a `merge-keys` entry, and a single clean row when every owned key is clean.

One row per file would hide three drifted keys behind one summary — the false green this issue is about. One row per key, always, would add four permanently-clean lines to every run. So: collapse when clean, expand when not. Every row keeps a real state, so the existing `actionable` filter and `suggestions()` work unchanged and can propose both `apply` and `push` when keys drift in both directions.

- [ ] **Step 1: Fix the test helper before writing any test**

`statusOutput` in `test/status.test.mjs` seeds clean config by looping over `SYNC` and doing `copyFileSync(src, dest)` for every entry. That was safe while every entry was `mode: 'copy'`. It is not now: the moment a test writes `claude/settings.keys.json` into its fixture repo, that loop copies it wholesale over `~/.claude/settings.json` and stamps a bogus whole-file baseline.

Guard the loop so it only seeds copied entries. Change `for (const entry of SYNC) {` to:

```js
  // Only copied entries have a whole-file baseline to seed. A merge-keys entry
  // owns named keys inside its destination, so copying its source over that
  // destination would replace the very document it is meant to merge into.
  for (const entry of SYNC.filter((e) => e.mode === 'copy')) {
```

Run `npm test` after this change alone. Expected: still 605 pass / 0 fail — no fixture writes `settings.keys.json` yet, so this is a no-op today and a trap disarmed for the tests below.

- [ ] **Step 2: Write the failing tests**

Append to `test/status.test.mjs`, merging `hashValue` into an import from `../src/settings-keys.mjs`:

```js
// statusOutput's isolated HOME puts nortuscc's state under <home>/state. A
// per-key baseline has to exist for a key to read as anything but 'unmanaged',
// so these tests seed it directly rather than running apply first.
function seedKeyBaselines(home, values) {
  mkdirSync(join(home, 'state'), { recursive: true });
  const files = {};
  for (const [key, value] of Object.entries(values)) {
    files[`claude:settings.json#${key}`] = { hash: hashValue(value) };
  }
  writeFileSync(
    join(home, 'state', 'state.json'),
    JSON.stringify({ version: 1, repo: null, skillsOnly: false, files }),
  );
}

test('a settings file whose owned keys all match reports one clean row', async () => {
  const { output } = await statusOutput([], (home, repoDir) => {
    writeFileSync(join(repoDir, 'claude', 'settings.keys.json'), JSON.stringify({ theme: 'auto' }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'auto' }));
    seedKeyBaselines(home, { theme: 'auto' });
  });
  assert.match(output, /settings\.json\s+clean/);
  assert.doesNotMatch(output, /settings\.json#/, 'no per-key rows while nothing has drifted apart');
});

// A fresh machine has no baseline for any key. Four identical 'unmanaged' rows
// would be as useless as one hidden conflict.
test('a machine that has never synced reports one unmanaged row, not one per key', async () => {
  const { output } = await statusOutput([], (home, repoDir) => {
    writeFileSync(
      join(repoDir, 'claude', 'settings.keys.json'),
      JSON.stringify({ theme: 'auto', tui: 'fullscreen' }),
    );
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'auto' }));
  });
  assert.match(output, /settings\.json\s+unmanaged/);
  assert.doesNotMatch(output, /settings\.json#/);
});

test('a drifted key is named in its own row and a matching key is not', async () => {
  const { output } = await statusOutput([], (home, repoDir) => {
    writeFileSync(
      join(repoDir, 'claude', 'settings.keys.json'),
      JSON.stringify({ theme: 'dark', tui: 'fullscreen' }),
    );
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', tui: 'compact' }),
    );
    seedKeyBaselines(home, { theme: 'dark', tui: 'fullscreen' });
  });
  assert.match(output, /settings\.json#tui/, 'the drifted key is named');
  assert.doesNotMatch(output, /settings\.json#theme/, 'the matching key is not');
});

test('an unparseable local settings file is blocked, not reported clean', async () => {
  const { output } = await statusOutput([], (home, repoDir) => {
    writeFileSync(join(repoDir, 'claude', 'settings.keys.json'), JSON.stringify({ theme: 'auto' }));
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
  });
  assert.match(output, /settings\.json\s+unparseable-local/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `settings.json` reports `unknown-mode`, so none of the four assertions hold.

- [ ] **Step 4: Write minimal implementation**

In `src/commands/status.mjs`, add `import { inspectMerge } from '../merge-keys.mjs';` and replace `configReport`'s body with:

```js
export function configReport(entries = SYNC) {
  const lock = readLock();
  return entries.flatMap((entry) => {
    const { src, dest, mode } = resolveEntry(entry);

    if (mode === 'copy') {
      // Keyed by target so Claude's CLAUDE.md and Codex's AGENTS.md can never
      // share one baseline; entry.dest stays the display name.
      const baseline = lock.files[`${entry.target}:${entry.dest}`]?.hash;
      return [{ dest: entry.dest, mode, state: inspectCopy(src, dest, baseline).state }];
    }

    if (mode === 'merge-keys') {
      const inspected = inspectMerge(src, dest, `${entry.target}:${entry.dest}`, lock);
      // A file the tool could not read, or a repo file it refused, has nothing
      // to say key by key.
      if (inspected.keys.length === 0) return [{ dest: entry.dest, mode, state: inspected.state }];

      // Collapse when every owned key says the same thing — four identical
      // rows on every run would bury the ones that matter, and that is as true
      // of `unmanaged` on a fresh machine as it is of `clean` on a synced one.
      // Expand the moment they disagree, because one summary row hiding three
      // drifted keys is the false green this mode was built to close.
      const distinct = new Set(inspected.keys.map((k) => k.state));
      if (distinct.size === 1) return [{ dest: entry.dest, mode, state: [...distinct][0] }];
      return inspected.keys
        .filter((k) => k.state !== 'clean')
        .map((k) => ({ dest: `${entry.dest}#${k.key}`, mode, state: k.state }));
    }

    // Unknown mode: surface as a visible error rather than silently misdispatching
    return [{ dest: entry.dest, mode, state: 'unknown-mode' }];
  });
}
```

Add one case to `noteFor` in the same file, beside the existing ones:

```js
    case 'unparseable-local': return 'local file could not be parsed';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS. The existing `configReport returns one row per manifest entry` test asserts `rows.length === SYNC.length` — with the new entry reporting one row on a bare machine that still holds, but if it fails, report it rather than weakening the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/commands/status.mjs test/status.test.mjs
git commit -m "feat: report settings drift key by key"
```

---

### Task 9: Document what is synced and what is not

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Read the surrounding sections**

Run: `grep -n 'Layout\|## Configuration\|settings.json\|user-owned' README.md`

Read whichever section describes what `nortuscc` manages, so the new paragraph matches its voice and placement.

- [ ] **Step 2: Write the documentation**

Add a subsection describing key-level sync. It must state, in the README's own voice:

- `claude/settings.keys.json` names the keys the repo owns and their values; everything else in `~/.claude/settings.json` is left exactly as found.
- The owned keys are `effortLevel`, `tui`, `theme` and `worktree`.
- `permissions` and `enabledPlugins` stay user-owned, the latter because `integrations.json` covers it.
- `hooks` is deliberately not owned: `integrations.json` already registers hooks, a second writer would let `apply` undo `apply --install`, and `status` already reports undeclared hooks.
- The file's key set is the allowlist — nothing reads the machine's own keys — and it is refused outright if a key name or value looks like a credential, the same rule `integrations.json` keeps.
- Drift is reported and resolved per key: `nortuscc apply --take-repo` and `nortuscc capture --take-local` resolve a conflicting key exactly as they resolve a conflicting file.
- Removing a key from the file stops it being managed; the value each machine last had stays. Deletions are not synced.

- [ ] **Step 3: Verify the claims against the code**

Run: `node -e "import('./src/manifest.mjs').then(m => console.log(m.SYNC))"` and `cat claude/settings.keys.json`

Confirm the README names exactly the keys the file declares. A README that lists a key the file does not own is worse than no README.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document key-level settings sync"
```

---

### Task 10: Verify against the real machine

**Files:**
- None modified unless a defect is found.

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is the decisive check. `status` is read-only, so the first two commands are safe against the developer's real `~/.claude`. Report exactly what you observe, verbatim, whether or not it matches.

- [ ] **Step 1: Confirm the repo file matches this machine**

Run:

```bash
cat claude/settings.keys.json
python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print(json.dumps({k:d.get(k) for k in ['effortLevel','tui','theme','worktree']},indent=2))"
```

Expected: identical values for all four keys. If they differ, that is a real finding — report it and stop rather than editing either side to match.

- [ ] **Step 2: Confirm status reports the file clean or unmanaged, never blocked**

Run: `node bin/nortuscc.mjs status`

Expected: a `settings.json` row in the config section. On a machine that has never applied this entry the state is `unmanaged` — there is no baseline yet — which is correct and means `apply` would write. It must NOT report `unparseable-local`, `missing-repo`, `unknown-mode`, or any `settings.json#` row, since the values match.

- [ ] **Step 3: Confirm the untouched keys really are untouched**

Run:

```bash
python3 -c "import json;d=json.load(open('$HOME/.claude/settings.json'));print(sorted(d.keys()))"
```

Record the output. It must list `permissions` and `enabledPlugins` alongside the four owned keys. Nothing in this task writes, so this is the before-picture a reviewer can compare against if `apply` is ever run.

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | tail -10`
Expected: PASS, comfortably above the 605 baseline, `fail 0`.

- [ ] **Step 5: Report**

No commit unless a defect was found and fixed. Report the verbatim output of every command above.

---

## Review and delivery

After Task 10:

1. Review the branch against the PR target: `git diff main...HEAD`.
2. Run `npm test` once more as the full-solution build.
3. Push `feat/settings-key-sync` and open a PR against `main`.
4. The PR body ends with `Model: <model> · Harness: <harness>` as its last line. Do not merge.

Report what was tested and what remains unverified. Specifically worth stating: no test runs `apply` against the developer's real `~/.claude`, so the first real write of an owned key happens under the user's own hand, with the pre-write backup as the safety net.
