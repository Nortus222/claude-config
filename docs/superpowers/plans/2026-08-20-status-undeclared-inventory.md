# Status Undeclared Inventory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `nortuscc status` report what is installed on this machine but declared nowhere in the repo, so a machine can no longer accumulate untracked agents, plugins, hooks and skills while status says "everything is in agreement".

**Architecture:** Two new modules on the split the codebase already draws between `state.mjs` (pure) and `copy.mjs` (I/O): `src/inventory.mjs` derives findings from data handed to it and imports no `node:fs`; `src/inventory-probe.mjs` performs every read and degrades a failure into an `errors[]` entry rather than an exception. `status.mjs` wires them into one new section. Nothing writes.

**Tech Stack:** Node 18+, plain ESM `.mjs`, zero dependencies. Tests use `node:test` and `node:assert/strict` only.

**Spec:** `docs/superpowers/specs/2026-08-20-status-undeclared-inventory-design.md`

## Global Constraints

- Node 18+, plain ESM `.mjs`, no build step, **zero dependencies** — including test tooling.
- Tests use `node:test` and `node:assert/strict` only. Use `node:`-prefixed builtin imports throughout.
- Test-first: write the failing test, then the module. Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Run the suite with `npm test`. Pass no path — `node --test test/` reports `pass 0 / fail 1` on Node 25; `package.json` lets the runner find `test/` itself.
- `status` is read-only by construction. No task may add a write to it, including the lockfile.
- Baseline before any change: **551 tests pass**. That number only goes up.
- Comments state a function's purpose, contract, or the *why* behind a non-obvious choice — never a narration of the implementation.

---

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/inventory.mjs` | Pure derivation: which observed items are undeclared, which declarations are defective. No I/O. |
| Create `src/inventory-probe.mjs` | Every read of the machine: agents dir, Claude skills dir, plugin JSON, settings hooks. Returns observations plus errors. |
| Create `test/inventory.test.mjs` | Pure-derivation tests. No fixture HOME needed. |
| Create `test/inventory-probe.test.mjs` | Probe tests against a fixture HOME. |
| Modify `src/integrations/claude-plugins.mjs` | Export the two private readers; add user-scope install extraction. |
| Modify `src/integrations/adapters.mjs` | Return the Codex state so status can observe it without spawning the CLI twice. |
| Modify `src/integrations/manifest.mjs` | Validate and return the optional top-level `allow`. |
| Modify `src/commands/status.mjs` | Render the section, honour `--strict` and `--versions`, suppress false agreement. |
| Modify `bin/nortuscc.mjs` | Usage text for both flags. |
| Modify `test/status.test.mjs`, `test/integrations-manifest.test.mjs`, `test/capture.test.mjs` | Wiring, validation and no-adopt tests. |

**Appending to an existing test file.** Several tasks add tests to a file they already created. Merge each new `import` into that file's existing import block rather than leaving a second one further down — ESM hoists either way, so this is house style, not correctness.

**Row shape used throughout.** An observed item is `{ key, label, note }`: `key` is what gets matched against declarations and the allow list, `label` is what prints in the middle column, `note` is the trailing detail. They differ for exactly one category — a hook matches on its command but displays its event — and keeping them separate is what stops the two from being conflated.

---

### Task 1: Pure declaration sets and manifest defects

**Files:**
- Create: `src/inventory.mjs`
- Test: `test/inventory.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `BUILTIN_MARKETPLACES: Set<string>`, `marketplaceOf(plugin: string) => string|null`, `declaredIds(integrations: object[], hookCommands: string[]) => { plugins: Set, marketplaces: Set, hooks: Set }`, `manifestDefects(integrations: object[]) => Array<{category, key, label, note}>`.

- [ ] **Step 1: Write the failing test**

Create `test/inventory.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_MARKETPLACES,
  marketplaceOf,
  declaredIds,
  manifestDefects,
} from '../src/inventory.mjs';

const plugin = (id, name) => ({ id, label: id, target: 'claude', type: 'plugin', default: true, plugin: name });
const market = (id, name) => ({ id, label: id, target: 'claude', type: 'marketplace', default: true, marketplace: `o/${name}`, name });

test('marketplaceOf splits the marketplace off a plugin id', () => {
  assert.equal(marketplaceOf('superpowers@claude-plugins-official'), 'claude-plugins-official');
  assert.equal(marketplaceOf('bare-name'), null);
  assert.equal(marketplaceOf('@leading'), null);
});

test('declaredIds collects plugins, marketplaces and hook commands', () => {
  const declared = declaredIds([plugin('a', 'foo@bar'), market('b', 'bar')], ['node /h/x.mjs']);
  assert.ok(declared.plugins.has('foo@bar'));
  assert.ok(declared.marketplaces.has('bar'));
  assert.ok(declared.hooks.has('node /h/x.mjs'));
});

// The exemption is the difference between a clean first run and one whose only
// finding is Claude Code's own behaviour.
test('declaredIds treats the built-in marketplace as declared', () => {
  assert.ok(BUILTIN_MARKETPLACES.has('claude-plugins-official'));
  assert.ok(declaredIds([]).marketplaces.has('claude-plugins-official'));
});

test('a declared plugin whose marketplace is undeclared is a manifest defect', () => {
  const rows = manifestDefects([plugin('a', 'foo@bar')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'manifest');
  assert.equal(rows[0].label, 'foo@bar');
  assert.match(rows[0].note, /marketplace 'bar' is not declared/);
});

test('declaring the marketplace clears the defect', () => {
  assert.deepEqual(manifestDefects([plugin('a', 'foo@bar'), market('b', 'bar')]), []);
});

// The repo declares exactly one integration and no marketplace at all, so a
// defect check blind to the built-in set would flag it on its first run.
test('the built-in marketplace is not a manifest defect', () => {
  assert.deepEqual(manifestDefects([plugin('a', 'superpowers@claude-plugins-official')]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/inventory.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/inventory.mjs`:

```js
// Pure derivation for the undeclared inventory. No I/O and no node:fs import:
// src/inventory-probe.mjs does every read and hands the results here, the same
// split state.mjs and copy.mjs already draw.

// Marketplaces Claude Code registers on its own behalf. The docs say the
// official one is added "automatically the first time you start it
// interactively", so reporting it would report Claude Code's behaviour as the
// user's drift. Consulted by both declaredIds and manifestDefects from this one
// constant, so the two can never disagree about what "built-in" means.
export const BUILTIN_MARKETPLACES = new Set(['claude-plugins-official']);

// The marketplace half of `plugin@marketplace`. A name with no suffix, or one
// that is all suffix, yields null: neither is a marketplace this can check.
export function marketplaceOf(plugin) {
  const at = plugin.lastIndexOf('@');
  return at > 0 ? plugin.slice(at + 1) : null;
}

// `hookCommands` is computed by the probe, which knows where hooks are
// installed; keeping it a parameter is what keeps this module free of paths.
export function declaredIds(integrations = [], hookCommands = []) {
  const plugins = new Set();
  const marketplaces = new Set(BUILTIN_MARKETPLACES);

  for (const item of integrations) {
    if (item.type === 'plugin' && item.plugin) plugins.add(item.plugin);
    if (item.type === 'marketplace' && item.name) marketplaces.add(item.name);
  }

  return { plugins, marketplaces, hooks: new Set(hookCommands) };
}

// A declared plugin whose marketplace is neither declared nor built-in can
// never be installed by `apply --install`: runIntegrations installs only
// declared marketplaces. That is the repo being wrong rather than the machine,
// which is why it is reported apart from the undeclared rows.
//
// It deliberately does not go through validateIntegrations, which is
// fail-closed — an error there yields no integrations at all, and one missing
// marketplace must not stop every other declaration from installing.
export function manifestDefects(integrations = []) {
  const { marketplaces } = declaredIds(integrations);
  const rows = [];

  for (const item of integrations) {
    if (item.type !== 'plugin' || !item.plugin) continue;
    const source = marketplaceOf(item.plugin);
    if (source && !marketplaces.has(source)) {
      rows.push({
        category: 'manifest',
        key: item.plugin,
        label: item.plugin,
        note: `marketplace '${source}' is not declared`,
      });
    }
  }

  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS, total above 551.

- [ ] **Step 5: Commit**

```bash
git add src/inventory.mjs test/inventory.test.mjs
git commit -m "feat: derive declared ids and manifest defects"
```

---

### Task 2: The undeclared derivation and allow filtering

**Files:**
- Modify: `src/inventory.mjs`
- Test: `test/inventory.test.mjs`

**Interfaces:**
- Consumes: `declaredIds` from Task 1.
- Produces: `OBSERVED_CATEGORIES: string[]`, `undeclared({ observed, declared, allow }) => Array<{category, key, label, note}>`.

- [ ] **Step 1: Write the failing test**

Append to `test/inventory.test.mjs`:

```js
import { OBSERVED_CATEGORIES, undeclared } from '../src/inventory.mjs';

const item = (key, note = '') => ({ key, label: key, note });

test('OBSERVED_CATEGORIES covers every category the probe walks', () => {
  assert.deepEqual([...OBSERVED_CATEGORIES].sort(), ['agents', 'hooks', 'marketplaces', 'plugins', 'skills']);
});

test('an observed item with no declaration is reported', () => {
  const rows = undeclared({
    observed: { plugins: [item('claude-mem@thedotmack')] },
    declared: { plugins: new Set() },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].category, 'plugins');
  assert.equal(rows[0].label, 'claude-mem@thedotmack');
});

test('a declared item is not reported', () => {
  const rows = undeclared({
    observed: { plugins: [item('superpowers@claude-plugins-official')] },
    declared: { plugins: new Set(['superpowers@claude-plugins-official']) },
  });
  assert.deepEqual(rows, []);
});

test('an allowed item is not reported', () => {
  const rows = undeclared({
    observed: { agents: [item('awesome-claude-agents')] },
    declared: {},
    allow: { agents: ['awesome-claude-agents'] },
  });
  assert.deepEqual(rows, []);
});

// An allow entry for one category must never quieten another.
test('allow does not leak across categories', () => {
  const rows = undeclared({
    observed: { plugins: [item('x')] },
    declared: {},
    allow: { agents: ['x'] },
  });
  assert.equal(rows.length, 1);
});

// A hook matches on its command and displays its event; conflating the two
// would match every hook that shares an event name.
test('a hook is matched on its command, not its displayed event', () => {
  const observed = { hooks: [{ key: 'node /h/a.mjs', label: 'SessionStart', note: 'node /h/a.mjs' }] };
  assert.deepEqual(undeclared({ observed, declared: { hooks: new Set(['node /h/a.mjs']) } }), []);

  const rows = undeclared({ observed, declared: { hooks: new Set(['node /h/b.mjs']) } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'SessionStart');
  assert.equal(rows[0].note, 'node /h/a.mjs');
});

test('missing observed categories and missing declared sets are empty, not errors', () => {
  assert.deepEqual(undeclared({}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `undeclared is not a function` / `OBSERVED_CATEGORIES` undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `src/inventory.mjs`:

```js
// The categories the probe walks, in report order. `manifest` is not here: it
// describes the repo rather than the machine and is produced by
// manifestDefects, not by comparing against an observation.
export const OBSERVED_CATEGORIES = ['agents', 'plugins', 'marketplaces', 'hooks', 'skills'];

// Present on the machine, named by neither the manifest nor the allow list.
//
// An item carries `key` and `label` separately because they differ for hooks: a
// hook is matched on its command, which is what uniquely identifies a
// registration, but displays its event, which is what a reader recognises.
export function undeclared({ observed = {}, declared = {}, allow = {} } = {}) {
  const rows = [];

  for (const category of OBSERVED_CATEGORIES) {
    const isDeclared = declared[category] ?? new Set();
    const isAllowed = new Set(allow[category] ?? []);

    for (const found of observed[category] ?? []) {
      if (isDeclared.has(found.key) || isAllowed.has(found.key)) continue;
      rows.push({ category, key: found.key, label: found.label, note: found.note ?? '' });
    }
  }

  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inventory.mjs test/inventory.test.mjs
git commit -m "feat: derive undeclared items with allow filtering"
```

---

### Task 3: Validate the `allow` list

**Files:**
- Modify: `src/integrations/manifest.mjs`
- Test: `test/integrations-manifest.test.mjs`

**Interfaces:**
- Consumes: `OBSERVED_CATEGORIES` from Task 2.
- Produces: `validateIntegrations` and `readIntegrations` both return `{ integrations, allow, errors }`, where `allow` is `{ [category]: string[] }` and `{}` whenever the manifest is invalid.

- [ ] **Step 1: Write the failing test**

Append to `test/integrations-manifest.test.mjs`:

```js
test('a manifest with no allow list yields an empty one', () => {
  const result = validateIntegrations(manifest(PLUGIN), { repo });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.allow, {});
});

test('allow accepts known categories with string ids', () => {
  const value = { ...manifest(PLUGIN), allow: { agents: ['awesome-claude-agents'], plugins: [] } };
  const result = validateIntegrations(value, { repo });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.allow.agents, ['awesome-claude-agents']);
});

// Fail-closed, like every other check here: a typo that silently allows nothing
// is worse than one that says so.
test('allow rejects an unknown category', () => {
  const value = { ...manifest(PLUGIN), allow: { plugin: ['x'] } };
  const result = validateIntegrations(value, { repo });
  assert.ok(result.errors.some((e) => /unknown category 'plugin'/.test(e)));
  assert.deepEqual(result.integrations, []);
});

test('allow rejects a non-array value and a non-string id', () => {
  const bad = validateIntegrations({ ...manifest(PLUGIN), allow: { agents: 'x' } }, { repo });
  assert.ok(bad.errors.some((e) => /must be a list of ids/.test(e)));

  const worse = validateIntegrations({ ...manifest(PLUGIN), allow: { agents: [5] } }, { repo });
  assert.ok(worse.errors.some((e) => /must be a list of ids/.test(e)));
});

test('allow must be an object', () => {
  const result = validateIntegrations({ ...manifest(PLUGIN), allow: ['agents'] }, { repo });
  assert.ok(result.errors.some((e) => /'allow' must be an object/.test(e)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `result.allow` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/integrations/manifest.mjs`, add the import at the top of the file, beside the existing `TARGETS` import:

```js
import { OBSERVED_CATEGORIES } from '../inventory.mjs';
```

Add above `validateIntegrations`:

```js
// Extras that are present on purpose. Ids only — the same "may name environment
// variables, never their values" convention the rest of this file keeps.
function validateAllow(value, errors) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push("integrations.json: 'allow' must be an object keyed by category");
    return {};
  }

  const allow = {};
  for (const [category, ids] of Object.entries(value)) {
    if (!OBSERVED_CATEGORIES.includes(category)) {
      errors.push(
        `integrations.json: 'allow' names unknown category '${category}'; ` +
          `expected one of ${OBSERVED_CATEGORIES.join(', ')}`,
      );
      continue;
    }
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
      errors.push(`integrations.json: 'allow.${category}' must be a list of ids`);
      continue;
    }
    allow[category] = ids;
  }
  return allow;
}
```

Then change the body of `validateIntegrations` so every `return` carries an `allow`. Replace its existing returns as follows:

```js
export function validateIntegrations(value, { repo } = {}) {
  const errors = [];

  if (!isPlainObject(value)) {
    return { integrations: [], allow: {}, errors: ['integrations.json must be a JSON object'] };
  }
  if (value.version !== VERSION) {
    errors.push(`integrations.json version must be ${VERSION}, found ${JSON.stringify(value.version)}`);
  }

  const allow = validateAllow(value.allow, errors);

  if (!Array.isArray(value.integrations)) {
    return { integrations: [], allow: {}, errors: [...errors, "integrations.json needs an 'integrations' array"] };
  }

  const seen = new Set();
  value.integrations.forEach((item, index) => {
    errors.push(...validateOne(item, index, { repo, seen }));
  });

  // An invalid manifest yields no allow list either: honouring exceptions from
  // a document the validator refused would be trusting half of it.
  if (errors.length) return { integrations: [], allow: {}, errors };
  return { integrations: value.integrations, allow, errors: [] };
}
```

Finally, update the two early returns in `readIntegrations` so its shape never varies:

```js
  if (!existsSync(path)) return { integrations: [], allow: {}, errors: [] };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { integrations: [], allow: {}, errors: [`integrations.json is not valid JSON: ${err.message}`] };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS. Existing callers destructure `{ integrations, errors }` and are unaffected by the added field.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/manifest.mjs test/integrations-manifest.test.mjs
git commit -m "feat: validate the integrations allow list"
```

---

### Task 4: Expose plugin state, user scope and versions

**Files:**
- Modify: `src/integrations/claude-plugins.mjs`
- Modify: `src/integrations/adapters.mjs`
- Test: `test/inventory-probe.test.mjs` (created here)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `installedPlugins(dir)`, `knownMarketplaces(dir)` and `userScopeInstalls(dir) => Array<{ name, version: string|null }>` exported from `claude-plugins.mjs`; `defaultAdapters()` gains a `state` field carrying the Codex state.

- [ ] **Step 1: Write the failing test**

Create `test/inventory-probe.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { userScopeInstalls, knownMarketplaces } from '../src/integrations/claude-plugins.mjs';

function claudeHome(installed, marketplaces = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-probe-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify(marketplaces));
  return dir;
}

test('the v2 shape yields user-scope installs with their versions', () => {
  const dir = claudeHome({
    version: 2,
    plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', version: '6.3.0' }] },
  });
  assert.deepEqual(userScopeInstalls(dir), [{ name: 'superpowers@claude-plugins-official', version: '6.3.0' }]);
});

// A project- or managed-scope install belongs to a repository or an
// administrator; neither is the user's to declare on this machine.
test('non-user scopes are not machine-wide installs', () => {
  const dir = claudeHome({ version: 2, plugins: { 'a@m': [{ scope: 'project', version: '1' }] } });
  assert.deepEqual(userScopeInstalls(dir), []);
});

test('a plugin installed at several scopes keeps the user-scope record', () => {
  const dir = claudeHome({
    version: 2,
    plugins: { 'a@m': [{ scope: 'project', version: '1' }, { scope: 'user', version: '2' }] },
  });
  assert.deepEqual(userScopeInstalls(dir), [{ name: 'a@m', version: '2' }]);
});

// The older shape records neither scope nor version. Dropping it would report a
// machine with old state as having no plugins at all.
test('the older shape counts as user scope with an unknown version', () => {
  const dir = claudeHome({ 'a@m': true });
  assert.deepEqual(userScopeInstalls(dir), [{ name: 'a@m', version: null }]);
});

test('a missing or corrupt plugin file reads as nothing installed', () => {
  const empty = mkdtempSync(join(tmpdir(), 'nortuscc-probe-'));
  assert.deepEqual(userScopeInstalls(empty), []);
  assert.deepEqual(knownMarketplaces(empty), {});
});

test('marketplaces are readable by name', () => {
  const dir = claudeHome({ version: 2, plugins: {} }, { 'claude-plugins-official': { source: {} } });
  assert.deepEqual(Object.keys(knownMarketplaces(dir)), ['claude-plugins-official']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `userScopeInstalls is not a function` (the readers are module-private).

- [ ] **Step 3: Write minimal implementation**

In `src/integrations/claude-plugins.mjs`, change the two private readers to exports and add the scope filter after them:

```js
export function installedPlugins(dir) {
```

```js
export function knownMarketplaces(dir) {
```

Then add below `knownMarketplaces`:

```js
// What this machine has installed for the user, with versions.
//
// In the v2 shape each plugin maps to an array of install records carrying
// `scope` and `version`, so a project- or managed-scope install — a
// repository's or an administrator's, not the user's — is dropped here rather
// than reported as machine-wide drift. A value that is not an array is the
// older shape, which records neither field: it counts as a user-scope install
// whose version is unknown, because dropping it would report an out-of-date
// machine as having no plugins at all.
export function userScopeInstalls(dir) {
  const installs = [];

  for (const [name, value] of Object.entries(installedPlugins(dir))) {
    if (!Array.isArray(value)) {
      installs.push({ name, version: null });
      continue;
    }
    const record = value.find((entry) => entry?.scope === 'user');
    if (!record) continue;
    installs.push({ name, version: typeof record.version === 'string' ? record.version : null });
  }

  return installs;
}
```

In `src/integrations/adapters.mjs`, add one field to the returned object so a caller can observe Codex without spawning its CLI a second time. Below the existing `errors: codexState.errors,` line, add:

```js
    // The sets themselves, not just their errors: the inventory pass asks what
    // Codex has installed, and re-reading would spawn the CLI twice per run.
    state: codexState,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/claude-plugins.mjs src/integrations/adapters.mjs test/inventory-probe.test.mjs
git commit -m "feat: expose user-scope plugin installs and codex state"
```

---

### Task 5: Probe the agents directory and the Claude skills links

**Files:**
- Modify: `src/inventory-probe.mjs` (created here)
- Test: `test/inventory-probe.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `observedAgents({ claudeDir }) => { items, errors }` and `observedSkillLinks({ claudeDir, agentsSkills }) => { items, errors }`, where `items` is `Array<{key, label, note}>` and `errors` is `Array<{category, message}>`.

**This task carries the plan's highest-risk check.** `~/.claude/skills` on the author's machine holds 29 links written two ways — 21 relative (`../../.agents/skills/<name>`) and 8 absolute (`/Users/<user>/.agents/skills/<name>`). Both resolve to the same store. Comparing link *text* reports the 8 absolute ones as undeclared: 28% false positives on a machine that is clean. Resolve to real paths.

- [ ] **Step 1: Write the failing test**

Append to `test/inventory-probe.test.mjs`:

```js
import { symlinkSync, rmSync } from 'node:fs';
import { observedAgents, observedSkillLinks } from '../src/inventory-probe.mjs';

function homeWithStore() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-probe-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  return {
    home,
    claudeDir: () => join(home, '.claude'),
    agentsSkills: () => join(home, '.agents', 'skills'),
  };
}

test('a missing agents directory observes nothing and is not an error', () => {
  const { claudeDir } = homeWithStore();
  assert.deepEqual(observedAgents({ claudeDir }), { items: [], errors: [] });
});

test('an agents symlink is observed and reports its target', () => {
  const { home, claudeDir } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(home, 'elsewhere'), { recursive: true });
  symlinkSync(join(home, 'elsewhere'), join(home, '.claude', 'agents', 'awesome-claude-agents'));

  const { items, errors } = observedAgents({ claudeDir });
  assert.deepEqual(errors, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'awesome-claude-agents');
  assert.match(items[0].note, /-> .*elsewhere/);
});

test('a dot-prefixed agents entry is the agent\'s own bookkeeping, not an agent', () => {
  const { home, claudeDir } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents', '.internal'), { recursive: true });
  assert.deepEqual(observedAgents({ claudeDir }).items, []);
});

// The check this task exists for.
test('skill links resolve, so relative and absolute forms both read as the store', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  for (const name of ['relative-one', 'absolute-one']) {
    mkdirSync(join(home, '.agents', 'skills', name), { recursive: true });
  }
  symlinkSync('../../.agents/skills/relative-one', join(home, '.claude', 'skills', 'relative-one'));
  symlinkSync(join(home, '.agents', 'skills', 'absolute-one'), join(home, '.claude', 'skills', 'absolute-one'));

  assert.deepEqual(observedSkillLinks({ claudeDir, agentsSkills }), { items: [], errors: [] });
});

test('a real directory in the skills dir did not come from the store', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'skills', 'wayfinder'), { recursive: true });

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'wayfinder');
  assert.match(items[0].note, /not from the shared store/);
});

test('a link pointing outside the store is observed', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, 'other-skills', 'stray'), { recursive: true });
  symlinkSync(join(home, 'other-skills', 'stray'), join(home, '.claude', 'skills', 'stray'));

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'stray');
});

test('a broken link is observed as broken rather than silently skipped', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.agents', 'skills', 'gone'), { recursive: true });
  symlinkSync(join(home, '.agents', 'skills', 'gone'), join(home, '.claude', 'skills', 'gone'));
  rmSync(join(home, '.agents', 'skills', 'gone'), { recursive: true });

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.match(items[0].note, /broken link/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../src/inventory-probe.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/inventory-probe.mjs`:

```js
// Every read the inventory pass performs. src/inventory.mjs derives findings
// from what this returns and imports no node:fs, the same split state.mjs and
// copy.mjs already draw.
//
// A failed read becomes an errors[] entry and never an exception — the contract
// readLinkExposure already keeps — so one unreadable directory cannot take a
// whole status run down. A directory that is merely absent is not a failure: a
// machine that never placed an agent has none.
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir as realClaudeDir, agentsSkillsDir as realAgentsSkillsDir } from './resolve.mjs';

// Dot-prefixed entries are an agent's own bookkeeping rather than content,
// exactly as exposedSkillNames already treats them.
function entriesOf(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
}

// Nothing in this repo declares an agent — no code reads ~/.claude/agents at
// all — so presence is the only signal there is, and every entry is undeclared
// until an allow entry says otherwise. That silence is what let a symlink
// exposing 24 third-party agents survive 13 months.
export function observedAgents({ claudeDir = realClaudeDir } = {}) {
  const dir = join(claudeDir(), 'agents');
  if (!existsSync(dir)) return { items: [], errors: [] };

  try {
    const items = entriesOf(dir).map((entry) => {
      let note = '';
      if (entry.isSymbolicLink()) {
        // The target is what made the 24-agent case legible: the name alone
        // says nothing about how much it pulls in.
        try {
          note = `-> ${readlinkSync(join(dir, entry.name))}`;
        } catch {
          note = '-> unreadable link';
        }
      }
      return { key: entry.name, label: entry.name, note };
    });
    return { items, errors: [] };
  } catch (err) {
    return { items: [], errors: [{ category: 'agents', message: `could not read ${dir}: ${err.message}` }] };
  }
}

// Entries in ~/.claude/skills that did not come from the shared store.
//
// Deliberately narrow: reconcile() already reports store-level extras and
// status already prints them. This covers only the hole reconcile cannot see —
// a hand-placed directory, or a link pointing somewhere else. Claude loads it
// either way.
//
// Links are RESOLVED, never string-compared. The same store is reached by
// relative links (../../.agents/skills/<name>) and absolute ones
// (/Users/<user>/.agents/skills/<name>), and a machine holds both forms at
// once; comparing link text reported every absolute link as undeclared.
export function observedSkillLinks({ claudeDir = realClaudeDir, agentsSkills = realAgentsSkillsDir } = {}) {
  const dir = join(claudeDir(), 'skills');
  if (!existsSync(dir)) return { items: [], errors: [] };

  let store = null;
  try {
    store = realpathSync(agentsSkills());
  } catch {
    // No store at all: every entry here came from somewhere else by definition.
    store = null;
  }

  try {
    const items = [];
    for (const entry of entriesOf(dir)) {
      const path = join(dir, entry.name);
      let real = null;
      try {
        real = realpathSync(path);
      } catch {
        real = null;
      }

      if (store && real === join(store, entry.name)) continue;

      items.push({
        key: entry.name,
        label: entry.name,
        note: real ? `not from the shared store (-> ${real})` : 'broken link',
      });
    }
    return { items, errors: [] };
  } catch (err) {
    return { items: [], errors: [{ category: 'skills', message: `could not read ${dir}: ${err.message}` }] };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inventory-probe.mjs test/inventory-probe.test.mjs
git commit -m "feat: probe agents and claude skill links"
```

---

### Task 6: Probe hooks and plugins, and aggregate the observation

**Files:**
- Modify: `src/inventory-probe.mjs`
- Test: `test/inventory-probe.test.mjs`

**Interfaces:**
- Consumes: `userScopeInstalls`, `knownMarketplaces` (Task 4); `observedAgents`, `observedSkillLinks` (Task 5).
- Produces: `observedHooks({ claudeDir }) => { items, errors }`, `declaredHookCommands(integrations, { claudeDir }) => string[]`, and `probe({ target, integrations, codexState, claudeDir, agentsSkills }) => { observed, hookCommands, pluginVersions, errors }` where `observed` is keyed by the five `OBSERVED_CATEGORIES` and `pluginVersions` is `Array<[name, version|null]>`.

- [ ] **Step 1: Write the failing test**

Append to `test/inventory-probe.test.mjs`:

```js
import { observedHooks, declaredHookCommands, probe } from '../src/inventory-probe.mjs';

const settings = (home, value) =>
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(value));

test('no settings file, and settings without hooks, observe nothing', () => {
  const a = homeWithStore();
  assert.deepEqual(observedHooks({ claudeDir: a.claudeDir }), { items: [], errors: [] });

  const b = homeWithStore();
  settings(b.home, { theme: 'dark' });
  assert.deepEqual(observedHooks({ claudeDir: b.claudeDir }), { items: [], errors: [] });
});

test('a registration is observed, matched on command and displayed by event', () => {
  const { home, claudeDir } = homeWithStore();
  settings(home, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /h/x.mjs' }] }] } });

  const { items } = observedHooks({ claudeDir });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'node /h/x.mjs');
  assert.equal(items[0].label, 'SessionStart');
});

// The user's file, mid-edit or hand-broken, is never reported as "no hooks":
// that would silently pass a category that was never checked.
test('unparseable settings is an error, not an empty observation', () => {
  const { home, claudeDir } = homeWithStore();
  writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');

  const { items, errors } = observedHooks({ claudeDir });
  assert.deepEqual(items, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, 'hooks');
});

test('a declared hook yields the command that would be registered', () => {
  const { claudeDir } = homeWithStore();
  const hook = { id: 'h', label: 'h', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/x.mjs' };
  const commands = declaredHookCommands([hook], { claudeDir });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^node .*hooks[/\\]x\.mjs$/);
});

test('probe aggregates every category and reports plugin versions', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', version: '1.2.3' }] } }),
  );
  writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: {} }));

  const result = probe({ target: 'all', integrations: [], claudeDir, agentsSkills });
  assert.deepEqual(result.observed.plugins.map((p) => p.key), ['a@m']);
  assert.deepEqual(result.observed.marketplaces.map((m) => m.key), ['m']);
  assert.deepEqual(result.pluginVersions, [['a@m', '1.2.3']]);
  assert.deepEqual(result.errors, []);
});

// Claude-side categories are not walked for a Codex-only report, exactly as
// --target narrows every other section.
test('--target codex observes codex plugins and no claude-side categories', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });

  const codexState = { plugins: new Set(['c@cm']), marketplaces: new Set(['cm']), errors: [] };
  const result = probe({ target: 'codex', integrations: [], codexState, claudeDir, agentsSkills });

  assert.deepEqual(result.observed.agents, []);
  assert.deepEqual(result.observed.plugins.map((p) => p.key), ['c@cm']);
  assert.deepEqual(result.observed.marketplaces.map((m) => m.key), ['cm']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `observedHooks is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/inventory-probe.mjs`, and extend its import block to add `readFileSync` from `node:fs` plus these module imports:

```js
import { isPlainObject } from './json.mjs';
import { userScopeInstalls, knownMarketplaces } from './integrations/claude-plugins.mjs';
import { hookCommand } from './integrations/claude-hooks.mjs';
```

```js
// Every hook registered in the user's settings.json, keyed by the command that
// identifies the registration and labelled by the event a reader recognises.
//
// Plugin-provided hooks do not appear here: they live in the plugin's own
// configuration, not in this file, so a plugin's hooks are never reported as
// the user's undeclared ones.
export function observedHooks({ claudeDir = realClaudeDir } = {}) {
  const path = join(claudeDir(), 'settings.json');
  if (!existsSync(path)) return { items: [], errors: [] };

  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Distinguished from "no hooks" on purpose: the user's file, mid-edit or
    // hand-broken, must not read as a category that was checked and found clean.
    return { items: [], errors: [{ category: 'hooks', message: `could not parse ${path}` }] };
  }
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return { items: [], errors: [] };

  const items = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command !== 'string' || !hook.command) continue;
        items.push({ key: hook.command, label: event, note: hook.command });
      }
    }
  }
  return { items, errors: [] };
}

// What each declared hook would register. Computed here rather than in
// inventory.mjs because it depends on where hooks are installed, and that is a
// path — the one thing the pure module has none of.
export function declaredHookCommands(integrations = [], { claudeDir = realClaudeDir } = {}) {
  return integrations
    .filter((item) => item.type === 'hook' && item.file)
    .map((item) => hookCommand(item, { claudeDir }));
}

const named = (key) => ({ key, label: key, note: '' });

// One observation of the whole machine, narrowed by --target exactly as every
// other section is. Agents, skill links and hooks are Claude-side categories
// and are not walked for a Codex-only report.
//
// Claude and Codex plugin ids share one `plugins` list, and their declarations
// share one set. Under --target all that unions them, so a plugin declared for
// one agent and installed on the other reads as declared — a narrow blind spot,
// accepted because the alternative is a doubled shape through every function,
// and because a report covering both agents was asked about both.
export function probe({
  target = 'all',
  integrations = [],
  codexState = null,
  claudeDir = realClaudeDir,
  agentsSkills = realAgentsSkillsDir,
} = {}) {
  const observed = { agents: [], plugins: [], marketplaces: [], hooks: [], skills: [] };
  const errors = [];
  const pluginVersions = [];

  if (target === 'all' || target === 'claude') {
    const agents = observedAgents({ claudeDir });
    const skills = observedSkillLinks({ claudeDir, agentsSkills });
    const hooks = observedHooks({ claudeDir });
    observed.agents.push(...agents.items);
    observed.skills.push(...skills.items);
    observed.hooks.push(...hooks.items);
    errors.push(...agents.errors, ...skills.errors, ...hooks.errors);

    for (const { name, version } of userScopeInstalls(claudeDir())) {
      observed.plugins.push(named(name));
      pluginVersions.push([name, version]);
    }
    for (const name of Object.keys(knownMarketplaces(claudeDir()))) {
      observed.marketplaces.push(named(name));
    }
  }

  if ((target === 'all' || target === 'codex') && codexState) {
    // Codex reports no version through its CLI, so its plugins are recorded
    // with an unknown one rather than left out of the version report entirely.
    for (const name of codexState.plugins ?? []) {
      observed.plugins.push(named(name));
      pluginVersions.push([name, null]);
    }
    for (const name of codexState.marketplaces ?? []) observed.marketplaces.push(named(name));
  }

  return {
    observed,
    hookCommands: declaredHookCommands(integrations, { claudeDir }),
    pluginVersions,
    errors,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inventory-probe.mjs test/inventory-probe.test.mjs
git commit -m "feat: probe hooks and plugins into one observation"
```

---

### Task 7: Render the section and stop reporting false agreement

**Files:**
- Modify: `src/commands/status.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `probe` (Task 6), `declaredIds`/`undeclared`/`manifestDefects` (Tasks 1–2), `readIntegrations().allow` (Task 3), `adapters.state` (Task 4).
- Produces: an `undeclared` section printed after `skills`; `inventoryRows` is internal to `status.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `test/status.test.mjs`:

```js
// Runs status against an isolated HOME and returns its printed output, so the
// section can be asserted on without reading the developer's real machine.
async function statusOutput(args = [], setup = () => {}, deps = {}) {
  const isolated = mkdtempSync(join(tmpdir(), 'nortuscc-undeclared-'));
  mkdirSync(join(isolated, '.claude'), { recursive: true });
  mkdirSync(join(isolated, '.codex'), { recursive: true });
  mkdirSync(join(isolated, '.agents', 'skills'), { recursive: true });
  const repoDir = mkdtempSync(join(tmpdir(), 'nortuscc-undeclared-repo-'));
  mkdirSync(join(repoDir, 'claude'), { recursive: true });
  mkdirSync(join(repoDir, 'codex'), { recursive: true });
  writeFileSync(join(repoDir, 'claude', 'CLAUDE.md'), '# Test');
  writeFileSync(join(repoDir, 'codex', 'AGENTS.md'), '# Test codex');
  setup(isolated, repoDir);

  const saved = { ...process.env };
  process.env.NORTUSCC_CLAUDE_DIR = join(isolated, '.claude');
  process.env.NORTUSCC_CODEX_DIR = join(isolated, '.codex');
  process.env.NORTUSCC_AGENTS_DIR = join(isolated, '.agents', 'skills');
  process.env.NORTUSCC_STATE_DIR = join(isolated, 'state');
  process.env.NORTUSCC_REPO_DIR = repoDir;

  // Bring the config rows to a clean state, so the inventory section is the
  // only thing that can make these runs dirty. Without this every row reads
  // 'unmanaged', status is dirty on its own account, and "everything is in
  // agreement" could never print — which is half of what this asserts.
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
  const { resolveEntry } = await import('../src/resolve.mjs');
  const lock = readLock();
  for (const entry of SYNC) {
    const { src, dest } = resolveEntry(entry);
    const hash = hashFile(src);
    if (hash) {
      copyFileSync(src, dest);
      setBaseline(lock, `${entry.target}:${entry.dest}`, hash);
    }
  }
  writeLock(lock);

  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(chunk.toString()); return true; };
  try {
    const { run: isolatedRun } = await import('../src/commands/status.mjs');
    const code = await isolatedRun(args, {
      codexState: emptyCodex(),
      inspectExposure: () => ({ list: {}, errors: [] }),
      cliState: () => ({ state: 'unmanaged' }),
      ...deps,
    });
    return { code, output: chunks.join('') };
  } finally {
    process.stdout.write = originalWrite;
    for (const key of ['NORTUSCC_CLAUDE_DIR', 'NORTUSCC_CODEX_DIR', 'NORTUSCC_AGENTS_DIR', 'NORTUSCC_STATE_DIR', 'NORTUSCC_REPO_DIR']) {
      process.env[key] = saved[key];
    }
  }
}

test('a clean machine says every category is declared rather than staying silent', async () => {
  const { output } = await statusOutput();
  assert.match(output, /undeclared/);
  assert.match(output, /all categories\s+declared/);
});

test('an undeclared agent is named in the section', async () => {
  const { output } = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'awesome-claude-agents'), { recursive: true });
  });
  assert.match(output, /agents\s+awesome-claude-agents/);
});

// The false-green this whole section exists to close.
test('undeclared items suppress "everything is in agreement"', async () => {
  const clean = await statusOutput();
  assert.match(clean.output, /everything is in agreement/);

  const dirty = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  });
  assert.doesNotMatch(dirty.output, /everything is in agreement/);
});

// Informational by default, so a scheduled run does not start failing the day
// this ships.
test('undeclared items alone do not change the exit code', async () => {
  const { code } = await statusOutput([], (home) => {
    mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  });
  assert.equal(code, 0);
});

test('an unreadable category reports unknown rather than nothing', async () => {
  const { output } = await statusOutput([], (home) => {
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
  });
  assert.match(output, /hooks\s+unknown/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — no `undeclared` section in the output.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/status.mjs`, add to the import block:

```js
import { declaredIds, undeclared, manifestDefects } from '../inventory.mjs';
import { probe } from '../inventory-probe.mjs';
```

Capture the leftover args by changing the `parseTarget` destructure from `const { target, error } = parseTarget(modeArgs);` to:

```js
  const { target, rest: statusArgs, error } = parseTarget(modeArgs);
```

Read the allow list by changing `const { integrations, errors } = readIntegrations();` to:

```js
  const { integrations, allow, errors } = readIntegrations();
```

Compute the observation immediately after `const adapters = await defaultAdapters({ codexState });` and before the `planned` line. It is placed here, above the integrations section rather than beside its own rendering, because Task 9 reports versions from it — the probe writes nothing, so its position affects only what data is in scope:

```js
  // Read-only, like everything else here: this walks the machine and compares
  // it against the manifest. Nothing is installed, removed or written.
  const selectedIntegrations = errors.length ? [] : entriesForTarget(integrations, target);
  const inventory = probe({ target, integrations: selectedIntegrations, codexState: adapters.state });
```

Then, immediately after the `skills` section is written to stdout, add its rendering:

```js
  const inventoryRows = [
    ...undeclared({
      observed: inventory.observed,
      declared: declaredIds(selectedIntegrations, inventory.hookCommands),
      allow,
    }),
    ...manifestDefects(selectedIntegrations),
  ];

  const undeclaredLines = [
    ...inventoryRows.map((row) => formatRow(row.category, row.label, row.note)),
    ...inventory.errors.map((err) => formatRow(err.category, 'unknown', err.message)),
  ];
  if (inventoryRows.length) {
    undeclaredLines.push(
      '',
      `  ${inventoryRows.length} finding(s). Declare them in integrations.json, or list them`,
      '  under "allow" to accept them. --strict makes this exit non-zero.',
    );
  } else if (!inventory.errors.length) {
    // Printed rather than omitted, for the reason the skills section already
    // gives: silence reads as "clean", which is the one thing it is not.
    undeclaredLines.push(formatRow('all categories', 'declared', ''));
  }
  process.stdout.write(section('undeclared', undeclaredLines));

  const inventoryDirty = inventoryRows.length > 0 || inventory.errors.length > 0;
```

Finally, add `inventoryDirty === false &&` to the list of conditions guarding the `everything is in agreement` branch, immediately after `cliBehind === false &&`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS. The exit-code test passes because undeclared rows do not yet reach any `return 1` path — Task 8 makes that deliberate rather than accidental.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.mjs test/status.test.mjs
git commit -m "feat: report undeclared items in status"
```

---

### Task 8: `--strict`

**Files:**
- Modify: `src/commands/status.mjs`
- Modify: `bin/nortuscc.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `inventoryDirty` and `statusArgs` from Task 7.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/status.test.mjs`:

```js
test('--strict makes an undeclared item exit non-zero', async () => {
  const stray = (home) => mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });
  assert.equal((await statusOutput([], stray)).code, 0);
  assert.equal((await statusOutput(['--strict'], stray)).code, 1);
});

test('--strict makes an unreadable category exit non-zero', async () => {
  const broken = (home) => writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
  assert.equal((await statusOutput(['--strict'], broken)).code, 1);
});

test('--strict on a clean machine still exits zero and agrees', async () => {
  const { code, output } = await statusOutput(['--strict']);
  assert.equal(code, 0);
  assert.match(output, /everything is in agreement/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `--strict` returns 0.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/status.mjs`, add beside the `inventoryDirty` line from Task 7:

```js
  // Default stays informational so a scheduled run does not start failing the
  // day this ships. --strict is for CI or a login hook that wants drift to be
  // actionable.
  const strict = statusArgs.includes('--strict');
```

Replace the command's final `return 1;` with:

```js
  // An undeclared item is not, on its own, a machine out of agreement with what
  // it declared — every other condition above is. Under --strict it is.
  const otherDirty =
    cliBehind ||
    actionable.length > 0 ||
    errors.length > 0 ||
    pending.length > 0 ||
    skills.missing.length > 0 ||
    exposure.partial.length > 0 ||
    exposure.missing.length > 0 ||
    exposureErrors.length > 0;

  if (otherDirty) return 1;
  return strict ? 1 : 0;
```

In `bin/nortuscc.mjs`, change the `status` entry in `USAGE` to read:

```
  status [--strict] [--versions]   report: cli / config / integrations / skills
                                    and what is installed but undeclared
                                    --strict exits non-zero on undeclared items
                                    offers to update nortuscc when it is behind
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.mjs bin/nortuscc.mjs test/status.test.mjs
git commit -m "feat: add status --strict"
```

---

### Task 9: `--versions`

**Files:**
- Modify: `src/commands/status.mjs`
- Modify: `bin/nortuscc.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: `inventory.pluginVersions` (Task 6), `statusArgs` (Task 7).
- Produces: no new exports.

The integrations section collapses to `all declared / installed` when nothing is pending, which hides versions. `--versions` suppresses that collapse. Versions are reported, never declared: `claude plugin install` has no version flag, so a pin would be unenforceable and would manufacture permanent drift.

- [ ] **Step 1: Write the failing test**

Append to `test/status.test.mjs`:

```js
function withPlugin(home) {
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', version: '6.3.0' }] } }),
  );
  writeFileSync(
    join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ 'claude-plugins-official': {} }),
  );
}

test('--versions prints the installed version of a declared plugin', async () => {
  const setup = (home, repoDir) => {
    withPlugin(home);
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [{
          id: 'superpowers-claude', label: 'superpowers', target: 'claude',
          type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
        }],
      }),
    );
  };

  const plain = await statusOutput([], setup);
  assert.doesNotMatch(plain.output, /6\.3\.0/);

  const detailed = await statusOutput(['--versions'], setup);
  assert.match(detailed.output, /superpowers\s+installed\s+6\.3\.0/);
});

// An absent version must never be mistaken for a matching one.
test('--versions reports an unreadable version as unknown', async () => {
  const setup = (home, repoDir) => {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ 'a@claude-plugins-official': true }));
    writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'claude-plugins-official': {} }));
    writeFileSync(
      join(repoDir, 'integrations.json'),
      JSON.stringify({
        version: 1,
        integrations: [{ id: 'a', label: 'a', target: 'claude', type: 'plugin', default: true, plugin: 'a@claude-plugins-official' }],
      }),
    );
  };

  const { output } = await statusOutput(['--versions'], setup);
  assert.match(output, /a\s+installed\s+unknown/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — no version appears under `--versions`.

- [ ] **Step 3: Write minimal implementation**

In `src/commands/status.mjs`, add beside the `strict` line:

```js
  // Versions are reported, never declared: `claude plugin install` has no
  // version flag, so a pin in integrations.json could not be honoured and
  // would manufacture permanent drift against auto-updating marketplaces.
  // Diffing two machines' output is what this is for.
  const showVersions = statusArgs.includes('--versions');
  const versionOf = new Map(inventory.pluginVersions);
```

Replace the `integrationLines` assignment's `pending.length === 0` branch so the collapse is conditional:

```js
  const integrationLines = errors.length
    ? errors.map((message) => formatRow('manifest', 'invalid', message))
    : planned.length === 0
      ? [formatRow('none declared', 'satisfied', '')]
      : showVersions
        ? planned.map((item) =>
            formatRow(
              item.label,
              item.state,
              item.type === 'plugin' ? (versionOf.get(item.plugin) ?? 'unknown') : item.note,
            ),
          )
        : pending.length === 0
          ? [formatRow('all declared', 'installed', '')]
          : [
              ...pending.map((item) => formatRow(item.label, item.state, item.note)),
              '',
              '  nortuscc apply --install',
            ];
```

In `bin/nortuscc.mjs`, extend the `status` usage block from Task 8 with one line:

```
                                    --versions shows each plugin's installed version
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/status.mjs bin/nortuscc.mjs test/status.test.mjs
git commit -m "feat: add status --versions"
```

---

### Task 10: Pin capture's honesty, and verify against the real machine

**Files:**
- Modify: `test/capture.test.mjs`
- Test: `test/capture.test.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/capture.test.mjs`. It already defines `repo`, `claude` and `captureRun` at module level; use those rather than introducing a second convention.

```js
// Discovering an extra must never write it into the manifest: that would
// convert drift into policy behind the user's back. capture has never read
// plugin, hook or MCP state, and this is what keeps it that way.
test('capture does not adopt undeclared items into integrations.json', async () => {
  const before = JSON.stringify({
    version: 1,
    integrations: [{
      id: 'superpowers-claude', label: 'superpowers', target: 'claude',
      type: 'plugin', default: true, plugin: 'superpowers@claude-plugins-official',
    }],
  });
  const manifestFile = join(repo, 'integrations.json');
  writeFileSync(manifestFile, before);

  // An undeclared plugin, marketplace and agent, all present on the machine.
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  mkdirSync(join(claude, 'agents', 'stray'), { recursive: true });
  writeFileSync(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'claude-mem@thedotmack': [{ scope: 'user', version: '13.13.1' }] } }),
  );
  writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify({ thedotmack: {} }));

  await captureRun([]);

  assert.equal(readFileSync(manifestFile, 'utf8'), before, 'integrations.json is byte-identical after capture');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -20`
Expected: PASS immediately — `capture` never reads this state. That is the point: the test is a regression guard, not a red-then-green cycle. If it *fails*, capture has grown a read it must not have; stop and report rather than making the test pass.

- [ ] **Step 3: Verify against the real machine**

Run the CLI against the actual `~/.claude`, from the worktree:

```bash
node bin/nortuscc.mjs status
```

Expected on this machine, whose state was verified on 2026-08-20: the `undeclared` section prints `all categories  declared` and nothing else. Specifically it must **not** report `claude-plugins-official` (built-in), must **not** report any of the 29 skill links (21 relative, 8 absolute, all resolving into `~/.agents/skills`), and must **not** flag `superpowers@claude-plugins-official` as a manifest defect.

Any row at all here is a false positive. Investigate before continuing — the whole section's credibility rests on its first run being right.

Then confirm the flags:

```bash
node bin/nortuscc.mjs status --versions   # superpowers ... 6.3.0
node bin/nortuscc.mjs status --strict     # still 0 on a clean machine
```

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | tail -10`
Expected: PASS, comfortably above the 551 baseline, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add test/capture.test.mjs
git commit -m "test: pin capture against adopting undeclared items"
```

---

## Review and delivery

After Task 10:

1. Review the branch against the PR target: `git diff main...HEAD`.
2. Run `npm test` once more as the full-solution build.
3. Push `feat/status-undeclared-inventory` and open a PR against `main`.
4. The PR body ends with `Model: <model> · Harness: <harness>` as its last line. Do not merge.

Report what was tested and what remains unverified. Specifically unverified by the suite, and worth saying so: the Codex branch of `probe()` is exercised only with an injected `codexState`, never against a real `codex` CLI, matching how every other Codex path in this repo is tested.
