# Codex Targets and Interactive Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make nortuscc manage Claude, Codex, or both and provide a safe interactive installer for native integrations and shared skills on a fresh machine.

**Architecture:** Add one target-aware configuration pipeline and neutral state store, then place integrations behind typed adapters driven by a non-secret manifest. Reuse the existing selector and `npx skills` wrapper, but make installation explicitly agent-aware and keep native tools responsible for their own layouts.

**Tech Stack:** Node.js 18+ ESM, built-in `node:test`, native Claude/Codex CLIs, `npx skills`, JSON manifests, no runtime dependencies.

## Global Constraints

- `--target` accepts exactly `claude`, `codex`, or `all`; the default is `all`.
- Manage Claude `CLAUDE.md`, Codex `AGENTS.md`, and shared skills; do not sync Claude `settings.json` or Codex `config.toml`.
- Never commit credentials, sessions, history, caches, runtime state, or machine-specific MCP arguments.
- Never delete local `~/.claude/settings.json`, old nortuscc state, or pre-existing retired helper files.
- Back up every managed file before replacement and every local Claude settings file before hook registration.
- Tests must not invoke a real installer, access the network, or touch live Claude, Codex, `.agents`, or nortuscc state directories.
- Preserve unrelated worktree changes; in particular, do not stage a path unless the current task owns it.

---

### Task 1: Target Parsing and Target-Aware Configuration

**Files:**
- Create: `src/targets.mjs`
- Modify: `src/manifest.mjs`
- Modify: `src/resolve.mjs`
- Modify: `src/commands/status.mjs`
- Modify: `src/commands/apply.mjs`
- Modify: `src/commands/capture.mjs`
- Modify: `src/commands/pull.mjs`
- Modify: `src/commands/push.mjs`
- Modify: `bin/nortuscc.mjs`
- Create: `codex/AGENTS.md`
- Test: `test/targets.test.mjs`
- Modify: `test/cli.test.mjs`
- Modify: `test/status.test.mjs`
- Modify: `test/apply.test.mjs`
- Modify: `test/capture.test.mjs`

**Interfaces:**
- Produces: `parseTarget(args) -> { target: 'claude'|'codex'|'all', rest: string[], error: string|null }`
- Produces: `selectedTargets(target) -> ('claude'|'codex')[]`
- Produces: `entriesForTarget(entries, target) -> SyncEntry[]`
- Produces: `agentDir(target) -> absolute path`
- Changes: `resolveEntry(entry)` resolves `entry.dest` beneath the directory for `entry.target`.

- [ ] **Step 1: Write failing target and manifest tests**

```js
test('target defaults to all and is removed from remaining args', () => {
  assert.deepEqual(parseTarget(['--skills']), { target: 'all', rest: ['--skills'], error: null });
});

test('target accepts both supported agents', () => {
  assert.deepEqual(parseTarget(['--target', 'codex']), { target: 'codex', rest: [], error: null });
  assert.deepEqual(selectedTargets('all'), ['claude', 'codex']);
});

test('target rejects missing, unknown, and repeated values', () => {
  assert.match(parseTarget(['--target']).error, /requires/);
  assert.match(parseTarget(['--target', 'cursor']).error, /claude\|codex\|all/);
  assert.match(parseTarget(['--target', 'claude', '--target', 'codex']).error, /once/);
});

test('entriesForTarget includes both entries for all', () => {
  const entries = [
    { target: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
    { target: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy' },
  ];
  assert.deepEqual(entriesForTarget(entries, 'codex'), [entries[1]]);
  assert.deepEqual(entriesForTarget(entries, 'all'), entries);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test test/targets.test.mjs test/cli.test.mjs`

Expected: FAIL because `src/targets.mjs` and target-aware manifest entries do not exist.

- [ ] **Step 3: Implement the target seam and change the sync manifest**

```js
export const TARGETS = ['claude', 'codex'];

export function parseTarget(args) {
  let target = 'all';
  let seen = false;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--target') { rest.push(args[i]); continue; }
    if (seen) return { target, rest, error: '--target may be supplied only once' };
    seen = true;
    const value = args[++i];
    if (!value) return { target, rest, error: '--target requires claude, codex, or all' };
    if (![...TARGETS, 'all'].includes(value)) {
      return { target, rest, error: '--target must be claude|codex|all' };
    }
    target = value;
  }
  return { target, rest, error: null };
}

export const selectedTargets = (target) => target === 'all' ? [...TARGETS] : [target];
export const entriesForTarget = (entries, target) =>
  entries.filter((entry) => target === 'all' || entry.target === target);
```

Update `SYNC` to contain only target-tagged copied instruction files. Add a
minimal `codex/AGENTS.md` by translating the still-valid agent-independent rules
from `claude/CLAUDE.md`; do not carry over helper-script instructions.

- [ ] **Step 4: Thread target filtering through commands and help**

Each command calls `parseTarget(args)` before its own flag parsing, returns 2 on
`error`, filters `SYNC`, and passes the cleaned `rest` onward. `pull` and `push`
must forward the target rather than silently restoring the default. Change help
examples to advertise `[--target claude|codex|all]`.

- [ ] **Step 5: Run target/config tests and verify GREEN**

Run: `node --test test/targets.test.mjs test/cli.test.mjs test/status.test.mjs test/apply.test.mjs test/capture.test.mjs test/pull.test.mjs test/push.test.mjs`

Expected: PASS, including fixtures proving Claude-only runs never touch Codex and Codex-only runs never touch Claude.

- [ ] **Step 6: Commit the target foundation**

```bash
git add src/targets.mjs src/manifest.mjs src/resolve.mjs src/commands/status.mjs src/commands/apply.mjs src/commands/capture.mjs src/commands/pull.mjs src/commands/push.mjs bin/nortuscc.mjs codex/AGENTS.md test/targets.test.mjs test/cli.test.mjs test/status.test.mjs test/apply.test.mjs test/capture.test.mjs test/pull.test.mjs test/push.test.mjs
git commit -m "feat: add Claude and Codex targets"
```

### Task 2: Neutral State and Safe Migration

**Files:**
- Modify: `src/resolve.mjs`
- Modify: `src/lock.mjs`
- Modify: `src/backup.mjs`
- Modify: `src/commands/setup.mjs`
- Modify: `test/lock.test.mjs`
- Modify: `test/backup.test.mjs`
- Modify: `test/setup.test.mjs`

**Interfaces:**
- Consumes: `agentDir(target)` from Task 1.
- Produces: `stateRoot()`, `statePath()`, `legacyLockPath()`, and target-aware `backupRoot(target)`.
- Produces: `migrateLegacyState() -> { migrated: boolean, state: LockState }`.
- Changes: file baselines use keys `${target}:${dest}`.

- [ ] **Step 1: Write failing neutral-state and migration tests**

```js
test('state path uses the explicit test root', () => {
  process.env.NORTUSCC_STATE_DIR = join(home, 'state');
  assert.equal(statePath(), join(home, 'state', 'state.json'));
});

test('legacy migration imports repo and Claude baseline but drops settings', () => {
  writeFileSync(legacyLockPath(), JSON.stringify({
    version: 1,
    repo,
    files: {
      'CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-01-01T00:00:00.000Z' },
      'settings.json': { hash: 'sha256:b', appliedAt: '2026-01-01T00:00:00.000Z' },
    },
  }));
  const result = migrateLegacyState();
  assert.equal(result.state.repo, repo);
  assert.deepEqual(Object.keys(result.state.files), ['claude:CLAUDE.md']);
  assert.ok(existsSync(legacyLockPath()));
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run: `node --test test/lock.test.mjs test/backup.test.mjs test/setup.test.mjs`

Expected: FAIL because state still lives under `~/.claude` and has no migration.

- [ ] **Step 3: Implement neutral state and atomic migration**

Use `NORTUSCC_STATE_DIR` as the complete test override. Default to
`~/.config/nortuscc` on Unix and `join(process.env.APPDATA, 'nortuscc')` on
Windows. Write state via a sibling temporary file followed by `renameSync`.
Only migrate when neutral state is absent; map `CLAUDE.md` to
`claude:CLAUDE.md`, copy `repo`, ignore every other old file key, and never
unlink the old lock.

- [ ] **Step 4: Make copied-file baselines and backups target-aware**

Change callers of `inspectCopy`, `applyCopy`, and `captureCopy` to pass
`${entry.target}:${entry.dest}` as the lock key while retaining `entry.dest` for
display. Put backups beneath `<stateRoot>/backups/<stamp>/<target>/`.

- [ ] **Step 5: Run migration tests and verify GREEN**

Run: `node --test test/lock.test.mjs test/backup.test.mjs test/setup.test.mjs test/copy.test.mjs`

Expected: PASS; the migration test confirms byte-for-byte preservation of the old lock.

- [ ] **Step 6: Commit neutral state**

```bash
git add src/resolve.mjs src/lock.mjs src/backup.mjs src/commands/setup.mjs test/lock.test.mjs test/backup.test.mjs test/setup.test.mjs test/copy.test.mjs
git commit -m "feat: migrate nortuscc state outside Claude"
```

### Task 3: Retire Settings, Helpers, Hooks, and Link Reconciliation

**Files:**
- Delete: `claude/settings.json`
- Delete: `claude/bin/sp`
- Delete: `claude/bin/sdd-pkg.sh`
- Delete: `claude/hooks/context-mode-cache-heal.mjs`
- Modify: `claude/CLAUDE.md`
- Delete: `src/link.mjs`
- Delete: `test/link.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/commands/apply.mjs`
- Modify: `src/commands/status.mjs`
- Modify: `test/state.test.mjs`
- Modify: `test/status.test.mjs`
- Modify: `test/apply.test.mjs`

**Interfaces:**
- Consumes: copy-only `SYNC` from Task 1.
- Produces: a copy-only configuration pipeline with no `link` mode or link states.

- [ ] **Step 1: Replace legacy behavior tests with retirement tests**

```js
test('the sync manifest contains no settings, helper, hook, or link entry', () => {
  assert.equal(SYNC.some((entry) => entry.mode === 'link'), false);
  assert.equal(SYNC.some((entry) => /settings|bin|hooks/.test(entry.src)), false);
});

test('Claude instructions do not name retired helpers', () => {
  const text = readFileSync(join(repo, 'claude', 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(text, /sdd-pkg|\.claude\/bin\/sp/);
});
```

- [ ] **Step 2: Run retirement tests and verify RED**

Run: `node --test test/manifest.test.mjs test/status.test.mjs test/apply.test.mjs`

Expected: FAIL while retired paths and link branches still exist.

- [ ] **Step 3: Remove retired assets and link-only code**

Delete the four tracked runtime assets. Remove both helper bullets from
`claude/CLAUDE.md`. Remove link imports, branches, link-specific errors, and
restart text that names `settings.json`. Delete `src/link.mjs` and its test;
remove `clobbered`, `wrong-target`, and `broken-link` if no remaining producer
uses them.

- [ ] **Step 4: Run configuration tests and verify GREEN**

Run: `node --test test/manifest.test.mjs test/state.test.mjs test/status.test.mjs test/apply.test.mjs test/capture.test.mjs`

Expected: PASS and no test fixture needs `claude/settings.json`, `claude/bin`, or `claude/hooks`.

- [ ] **Step 5: Commit the retirement**

```bash
git add -A -- claude src/link.mjs src/state.mjs src/commands/apply.mjs src/commands/status.mjs test/link.test.mjs test/state.test.mjs test/status.test.mjs test/apply.test.mjs test/capture.test.mjs test/manifest.test.mjs
git commit -m "refactor: retire legacy Claude configuration helpers"
```

### Task 4: Integration Manifest and Adapter Contracts

**Files:**
- Create: `integrations.json`
- Create: `src/integrations/manifest.mjs`
- Create: `src/integrations/runner.mjs`
- Create: `src/integrations/claude-plugins.mjs`
- Create: `src/integrations/codex-plugins.mjs`
- Create: `src/integrations/claude-hooks.mjs`
- Create: `src/integrations/codex-mcp.mjs`
- Replace: `src/plugins.mjs`
- Create: `test/integrations-manifest.test.mjs`
- Create: `test/integrations-runner.test.mjs`
- Replace: `test/plugins.test.mjs`
- Create: `test/codex-plugins.test.mjs`
- Create: `test/codex-mcp.test.mjs`
- Create: `test/hooks.test.mjs`

**Interfaces:**
- Produces: `readIntegrations() -> Integration[]` and `validateIntegrations(value, { repo }) -> { integrations, errors }`.
- Produces adapter shape `{ inspect(item), describe(item), install(item) }` where inspect returns `{ state: 'installed'|'missing'|'blocked', note }` and install returns `{ ok, note }`.
- Produces: `integrationPlan({ integrations, target, disabled, adapters }) -> PlannedIntegration[]`.
- Produces: `runIntegrations(plan, adapters) -> IntegrationResult[]`.

- [ ] **Step 1: Write failing manifest validation tests**

```js
test('valid manifest accepts stable IDs, targets, types, and env names', () => {
  const result = validateIntegrations({ version: 1, integrations: [{
    id: 'context-mode-claude', label: 'context-mode', target: 'claude',
    type: 'plugin', default: true, plugin: 'context-mode@context-mode',
  }] }, { repo });
  assert.deepEqual(result.errors, []);
});

test('manifest rejects duplicate IDs and probable secret values', () => {
  const result = validateIntegrations({ version: 1, integrations: [
    { id: 'x', label: 'x', target: 'codex', type: 'mcp', default: true, token: 'sk-live-secret' },
    { id: 'x', label: 'x2', target: 'codex', type: 'mcp', default: true },
  ] }, { repo });
  assert.match(result.errors.join('\n'), /duplicate.*x/i);
  assert.match(result.errors.join('\n'), /secret/i);
});
```

- [ ] **Step 2: Write failing adapter command and preservation tests**

```js
test('Claude plugin installs marketplace before plugin', async () => {
  const calls = [];
  const result = await runIntegrations(plan, adaptersWithRecorder(calls));
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['plugin', 'marketplace', 'add'],
    ['plugin', 'install', 'context-mode@context-mode'],
  ]);
  assert.ok(result.every((item) => item.ok));
});

test('hook registration preserves unrelated settings and hooks', async () => {
  writeFileSync(settings, JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ command: 'mine' }] }] } }));
  await installHook(item, { settingsPath: settings, preserve, spawn });
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.theme, 'dark');
  assert.equal(after.hooks.Stop[0].hooks[0].command, 'mine');
  assert.match(JSON.stringify(after.hooks.SessionStart), /nortuscc-hook/);
});

test('MCP adapter blocks before spawning when required env is absent', async () => {
  const calls = [];
  const result = await installMcp(item, { env: {}, spawn: record(calls) });
  assert.equal(result.ok, false);
  assert.match(result.note, /OPENAI_API_KEY/);
  assert.deepEqual(calls, []);
});
```

- [ ] **Step 3: Run adapter tests and verify RED**

Run: `node --test test/integrations-manifest.test.mjs test/integrations-runner.test.mjs test/plugins.test.mjs test/codex-plugins.test.mjs test/codex-mcp.test.mjs test/hooks.test.mjs`

Expected: FAIL because manifest and adapters do not exist.

- [ ] **Step 4: Implement strict manifest parsing and adapters**

Create these exact default entries: Claude `superpowers@claude-plugins-official`;
Claude marketplace `mksglu/context-mode` followed by
`context-mode@context-mode`; Claude marketplace `thedotmack/claude-mem`
followed by `claude-mem@thedotmack`; and the native Codex context-mode plugin
from marketplace `mksglu/context-mode`. Do not declare the retired repair hook.
Codex MCP declarations use `codex mcp add`; additional MCP servers enter the
manifest explicitly rather than being inferred from `config.toml`. Inject all
filesystem and child-process operations into adapter functions. Use
`execFile`-style argument arrays, never a shell string. Redact values for fields
named by `requiresEnv` in `describe` and result formatting.

- [ ] **Step 5: Implement ordered, failure-isolated execution**

Sort selected work by `hook`, `marketplace`, `plugin`, `mcp`; preserve manifest
order inside each type. Catch each adapter failure into `{ id, ok: false, note }`
and continue. Reject the entire manifest before calling any adapter if validation
has errors.

- [ ] **Step 6: Run adapter tests and verify GREEN**

Run: `node --test test/integrations-manifest.test.mjs test/integrations-runner.test.mjs test/plugins.test.mjs test/codex-plugins.test.mjs test/codex-mcp.test.mjs test/hooks.test.mjs`

Expected: PASS with fixture executables only.

- [ ] **Step 7: Commit integration adapters**

```bash
git add integrations.json src/integrations src/plugins.mjs test/integrations-manifest.test.mjs test/integrations-runner.test.mjs test/plugins.test.mjs test/codex-plugins.test.mjs test/codex-mcp.test.mjs test/hooks.test.mjs
git commit -m "feat: add native integration adapters"
```

### Task 5: Native Agent-Aware Skill Installation

**Files:**
- Modify: `src/skills-cli.mjs`
- Modify: `src/skills.mjs`
- Modify: `src/commands/update.mjs`
- Modify: `test/skills-cli.test.mjs`
- Modify: `test/skills.test.mjs`
- Modify: `test/update.test.mjs`

**Interfaces:**
- Consumes: `selectedTargets(target)` from Task 1.
- Changes: `buildCommand({ source, skills, agents })` adds variadic `--agent` values.
- Produces: `skillExposure({ names, agents, list }) -> { exposed, partial, missing }`.
- Changes: `installGroups(groups, { agents, dryRun, run })`.

- [ ] **Step 1: Write failing explicit-agent command tests**

```js
test('skill add names exact skills and both selected agents', () => {
  const command = buildCommand({
    source: 'owner/repo', skills: ['one', 'two'], agents: ['claude-code', 'codex'],
  });
  assert.deepEqual(command.args, [
    '-y', 'skills', 'add', 'owner/repo', '--skill', 'one', 'two',
    '--agent', 'claude-code', 'codex', '--global', '--yes',
  ]);
});

test('exposure reports a canonical skill missing from one selected agent', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': ['review'], codex: [] },
  });
  assert.deepEqual(result.partial, [{ name: 'review', missingAgents: ['codex'] }]);
});
```

- [ ] **Step 2: Run skill tests and verify RED**

Run: `node --test test/skills-cli.test.mjs test/skills.test.mjs test/update.test.mjs`

Expected: FAIL because add commands omit `--agent` and status has no exposure model.

- [ ] **Step 3: Implement targeted add and exposure inspection**

Map nortuscc targets to installer IDs in one exported constant:

```js
export const SKILL_AGENTS = { claude: 'claude-code', codex: 'codex' };
```

Use an injected runner for `npx -y skills list --global --agent <agent> --json`.
Parse malformed output as an inspection error, not as an empty successful list.
Keep canonical source/provenance logic in `.skill-lock.json` unchanged.

- [ ] **Step 4: Reconcile exposure after skill updates**

After `npx skills update`, re-run exposure inspection and call `installGroups`
only for updated or existing manifest skills absent from a selected agent. Do not
manually create symlinks. Remove `brokenSkillLinks()` and `claudeSkillsDir()`.

- [ ] **Step 5: Run skill tests and verify GREEN**

Run: `node --test test/skills-cli.test.mjs test/skills.test.mjs test/update.test.mjs test/skill-updates.test.mjs`

Expected: PASS; command tests prove both targets and single-target cases.

- [ ] **Step 6: Commit native targeted skills**

```bash
git add src/skills-cli.mjs src/skills.mjs src/commands/update.mjs test/skills-cli.test.mjs test/skills.test.mjs test/update.test.mjs test/skill-updates.test.mjs
git commit -m "feat: install skills for selected agents"
```

### Task 6: Shared Interactive Installation Workflow

**Files:**
- Create: `src/install-plan.mjs`
- Create: `src/commands/install.mjs`
- Modify: `src/select.mjs`
- Modify: `src/commands/setup.mjs`
- Modify: `src/commands/apply.mjs`
- Modify: `bin/nortuscc.mjs`
- Create: `test/install-plan.test.mjs`
- Create: `test/install.test.mjs`
- Modify: `test/select-render.test.mjs`
- Modify: `test/setup.test.mjs`
- Modify: `test/apply.test.mjs`

**Interfaces:**
- Consumes: integration plans from Task 4 and target-aware skills from Task 5.
- Produces: `parseInstallFlags(args) -> { yes, disabled: Set<string>, error, rest }`.
- Produces: `buildInstallChoices({ config, integrations, skills }) -> SelectItem[]`.
- Produces: `runInstall({ target, flags, deps }) -> Promise<number>`.

- [ ] **Step 1: Write failing flag and choice tests**

```js
test('install flags support yes and all category opt-outs', () => {
  const flags = parseInstallFlags(['--yes', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills']);
  assert.equal(flags.yes, true);
  assert.deepEqual([...flags.disabled].sort(), ['hooks', 'mcp', 'plugins', 'skills']);
  assert.equal(flags.error, null);
});

test('already installed choices are visible but unchecked', () => {
  const choices = buildInstallChoices({ config: [], integrations: [{
    id: 'plugin:x', group: 'Claude plugins', label: 'x', state: 'installed', default: true,
  }], skills: [] });
  assert.equal(choices[0].checked, false);
  assert.match(choices[0].note, /installed/);
});
```

- [ ] **Step 2: Write failing setup orchestration tests**

```js
test('non-TTY setup refuses before install without --yes', async () => {
  const calls = [];
  const code = await runInstall({ target: 'all', flags: parseInstallFlags([]), deps: fixtureDeps({ isTTY: false, calls }) });
  assert.equal(code, 2);
  assert.deepEqual(calls, []);
});

test('--yes installs defaults in dependency order and reports failures', async () => {
  const calls = [];
  const code = await runInstall({ target: 'all', flags: parseInstallFlags(['--yes']), deps: fixtureDeps({ calls, fail: 'mcp:x' }) });
  assert.deepEqual(calls, ['config:claude', 'config:codex', 'plugin:x', 'mcp:x', 'skill:y']);
  assert.equal(code, 1);
});
```

- [ ] **Step 3: Run install workflow tests and verify RED**

Run: `node --test test/install-plan.test.mjs test/install.test.mjs test/setup.test.mjs test/apply.test.mjs test/select-render.test.mjs`

Expected: FAIL because the shared workflow does not exist.

- [ ] **Step 4: Implement planning, review, and execution**

Reuse `select()` for group toggles. Add a read-only review formatter showing
files and redacted commands. Interactive flow selects rows, prints review, then
calls `confirm('Install these items?')`; cancellation or decline changes
nothing. `--yes` selects defaults directly. Empty plans return 0 without a TTY.

- [ ] **Step 5: Wire setup and apply**

`setup` always calls the shared workflow after repo/state preparation. `apply`
calls it only with `--install`; keep `--skills` as an alias that disables hooks,
MCP, and plugins and prints one deprecation warning. Ensure apply configuration
conflicts stop before installation. Keep orchestration in the internal
`src/commands/install.mjs` module, imported by setup and apply but absent from
the public verb list.

- [ ] **Step 6: Run install workflow tests and verify GREEN**

Run: `node --test test/install-plan.test.mjs test/install.test.mjs test/setup.test.mjs test/apply.test.mjs test/select.test.mjs test/select-render.test.mjs`

Expected: PASS for interactive, `--yes`, non-TTY, category opt-outs, cancellation, and partial failures.

- [ ] **Step 7: Commit interactive setup**

```bash
git add src/install-plan.mjs src/commands/install.mjs src/select.mjs src/commands/setup.mjs src/commands/apply.mjs bin/nortuscc.mjs test/install-plan.test.mjs test/install.test.mjs test/select-render.test.mjs test/setup.test.mjs test/apply.test.mjs
git commit -m "feat: add interactive native setup"
```

### Task 7: Target-Aware Status, Capture, Pull, Push, and Update

**Files:**
- Modify: `src/commands/status.mjs`
- Modify: `src/commands/capture.mjs`
- Modify: `src/commands/pull.mjs`
- Modify: `src/commands/push.mjs`
- Modify: `src/commands/update.mjs`
- Modify: `test/status.test.mjs`
- Modify: `test/capture.test.mjs`
- Modify: `test/pull.test.mjs`
- Modify: `test/push.test.mjs`
- Modify: `test/update.test.mjs`

**Interfaces:**
- Consumes: `parseTarget`, integration inspection, and `skillExposure`.
- Produces status sections `config`, `integrations`, and `skills` filtered by target.

- [ ] **Step 1: Write failing end-to-end command tests**

```js
test('Codex status omits Claude integrations', async () => {
  const out = await captureOutput(() => statusRun(['--target', 'codex'], fixtureDeps));
  assert.match(out, /AGENTS\.md/);
  assert.match(out, /Codex MCP/);
  assert.doesNotMatch(out, /Claude plugins|CLAUDE\.md/);
});

test('capture never imports local MCP configuration', async () => {
  writeFileSync(join(codex, 'config.toml'), '[mcp_servers.private]\ncommand="secret"\n');
  await captureRun(['--target', 'codex'], fixtureEntries);
  assert.equal(readFileSync(join(repo, 'integrations.json'), 'utf8'), manifestBefore);
  assert.deepEqual(capturedPaths(), ['codex/AGENTS.md', 'skills-manifest.txt']);
});
```

- [ ] **Step 2: Run command tests and verify RED**

Run: `node --test test/status.test.mjs test/capture.test.mjs test/pull.test.mjs test/push.test.mjs test/update.test.mjs`

Expected: FAIL until all commands compose the new target and adapter seams.

- [ ] **Step 3: Implement target-aware reporting and command forwarding**

Status reports integration states without calling install. Treat selected
missing/blocked integrations and partial skill exposure as actionable. Capture
may write target instruction files and `skills-manifest.txt` only. Pull reports
new missing integrations after apply but installs them only with `--install`.
Push forwards target and stages exactly `capturedPaths()`. Update forwards target
to post-update skill exposure reconciliation.

- [ ] **Step 4: Run command tests and verify GREEN**

Run: `node --test test/status.test.mjs test/capture.test.mjs test/pull.test.mjs test/push.test.mjs test/update.test.mjs`

Expected: PASS, including Claude-only, Codex-only, and all-target fixtures.

- [ ] **Step 5: Commit command integration**

```bash
git add src/commands/status.mjs src/commands/capture.mjs src/commands/pull.mjs src/commands/push.mjs src/commands/update.mjs test/status.test.mjs test/capture.test.mjs test/pull.test.mjs test/push.test.mjs test/update.test.mjs
git commit -m "feat: reconcile selected agent targets"
```

### Task 8: Documentation and Fresh-Machine Verification

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `bin/nortuscc.mjs`
- Create: `test/fresh-machine.test.mjs`
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: completed command behavior from Tasks 1-7.
- Produces: documented onboarding and a hermetic empty-home acceptance test.

- [ ] **Step 1: Write the failing empty-home acceptance test**

```js
test('fresh machine setup installs selected defaults for both agents', async () => {
  const env = emptyHomeFixture();
  const result = await runCli(['setup', '--target', 'all', '--yes'], {
    env, fixtureBinDir: fakeNativeInstallers(),
  });
  assert.equal(result.code, 0);
  assert.equal(readFileSync(join(env.claude, 'CLAUDE.md'), 'utf8'), readFileSync(join(repo, 'claude', 'CLAUDE.md'), 'utf8'));
  assert.equal(readFileSync(join(env.codex, 'AGENTS.md'), 'utf8'), readFileSync(join(repo, 'codex', 'AGENTS.md'), 'utf8'));
  assert.deepEqual(readInstallerLog(env), expectedDefaultInstallCalls());
  assert.equal(existsSync(join(env.claude, 'settings.json')), false);
});
```

- [ ] **Step 2: Run the acceptance test and verify RED**

Run: `node --test test/fresh-machine.test.mjs test/cli.test.mjs`

Expected: FAIL until fixtures and final help/documentation behavior are complete.

- [ ] **Step 3: Rewrite README and CLI help around the new model**

Document `--target`, default `all`, interactive setup, non-TTY `--yes`, category
opt-outs, `apply --install`, deprecated `--skills`, neutral state migration,
native integration ownership, shared skills, and exclusions for settings,
config, and secrets. Remove every claim that settings, bin, hooks, or the old
Claude lock are normally synced.

- [ ] **Step 4: Complete hermetic fake installers and make acceptance GREEN**

Fake `claude`, `codex`, and `npx` executables must log argv as JSON lines and
write only inside the empty test home. Assert exact calls, ordering, target
selection, rerun idempotency, and absence of network access.

Run: `node --test test/fresh-machine.test.mjs test/cli.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run: `npm test`

Expected: all tests pass with zero real installer invocations and no writes outside test fixtures.

Run: `git diff --check HEAD`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only task-owned documentation/test changes are staged or committed; pre-existing unrelated changes remain untouched.

- [ ] **Step 6: Commit documentation and acceptance coverage**

```bash
git add README.md package.json bin/nortuscc.mjs test/fresh-machine.test.mjs test/cli.test.mjs
git commit -m "docs: document multi-agent onboarding"
```
