# Machine Integrations Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port hooks, marketplaces, plugins and MCP for Claude and Codex onto `@nortuscc/machine` as the `integrations` `Domain`, reading declarations from the profile engine's `DesiredConfig` (issue #56, sub-issue 3/6 of #42).

**Architecture:** Four small adapter modules under `packages/machine/src/integrations/` port the legacy `src/integrations/*.mjs`: `plugins.ts` (Claude and Codex plugins and marketplaces), `mcp.ts` (Codex MCP), `hooks.ts` (Claude hooks), and `declaration.ts` (the typed view of an engine declaration). `domain.ts` ports the runner as `integrationsDomain(options)`. `inspect` reads each agent's state once, `steps` turns `apply` items into `install-integration` steps in type order, and `run` installs one item. Installers run through `Processes` as interruptible steps. The hook step is a file step: it backs up through `Backups` and writes through `Fs`. No command is cut over (#59 does that), and the legacy `.mjs` stays until then.

**Tech Stack:** Node ≥ 24 (type stripping), TypeScript 7.0.2 (`tsc --noEmit`), `effect` 4.0.1, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (sections "@nortuscc/machine" and "Domains").

## Global Constraints

- Erasable-syntax TypeScript with `.ts` import extensions; no `enum`, `namespace` or parameter properties. `node:`-prefixed builtins.
- `effect` `4.0.1` is the only runtime dependency. Add no dependency.
- Child processes take argv arrays through `Processes`, never a shell string.
- Nothing under `packages/machine/src` reads `process.env` or the home directory. The domain receives `env` and paths from its caller.
- Tests: `packages/machine/checks/*.spec.ts`, `node:test` and `node:assert/strict`, temporary directories and fake executables only. Helpers that are not tests live in `packages/machine/checks/support/` (the glob `checks/*.spec.ts` does not run them).
- Item keys are `integration:<id>` (spec, "Inspect"). Integration `state` keeps the legacy vocabulary: `installed`, `missing`, `blocked`, and `unknown` (a native CLI could not answer; legacy `status` prints it).
- Backups use the legacy layout: `Backups.preserve(path, 'settings.json', 'claude')`.
- Do not edit `src/integrations/*.mjs`, `src/commands/*`, or any root `test/*.test.mjs`. They stay until cutover (#59).
- Shared foundation files (`model.ts`, `run.ts`, `index.ts`, `README.md`, the spec) change only where Task 1 and Task 6 say.
- Commit after every task with a conventional-commit prefix. Never commit `skills-manifest.txt`: after any root `npm test`, run `git status --short` and restore it with `git checkout -- skills-manifest.txt` if it changed.
- Commands: `npm test -w packages/machine` and `npm run typecheck -w packages/machine`. To run one file: `node --test packages/machine/checks/<file>.spec.ts`.

## Review Focus

1. **The desktop backend runs an installer.** The backend speaks JSON lines on stdout, so an installer inheriting stdout corrupts the protocol. Expect `installerOutput: 'capture'` to run every installer with captured output (Task 5 test).
2. **`codex` is not on PATH.** Expect `inspect` to still succeed, Codex plugin and marketplace items to read `unknown` with disposition `blocked`, one probe error per failed list, and Claude items to be planned as usual. No Codex spawn happens when no Codex plugin or marketplace is declared (Task 4 tests).
3. **`settings.json` is corrupt or unreadable.** Expect the hook item to be `blocked` at inspect, and `run` to refuse without writing or copying anything (Task 3 tests).
4. **The user cancels while `claude plugin install` runs.** Expect the installer's process group to be killed, the step to finish `cancelled`, and later steps not to start. A hook step is never interrupted halfway (Task 5 test).
5. **A default-off integration is ticked in the picker.** `plan` receives it in `selection.only`. Expect it to become a step. An unticked default-off item is skipped as `not enabled on this machine` (Task 4 tests).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/machine/src/model.ts` (modify) | `Domain.steps` gains a fourth parameter, `desired` |
| `packages/machine/src/run.ts` (modify) | `plan` passes `report.desired` to each domain's `steps` |
| `packages/machine/src/integrations/declaration.ts` | `Declaration`, `Inspected`, `Installer`, `asDeclaration`, `commandLine` |
| `packages/machine/src/integrations/plugins.ts` | Claude and Codex plugin and marketplace commands, state readers, inspection |
| `packages/machine/src/integrations/mcp.ts` | Codex MCP command, env prerequisites, description, inspection |
| `packages/machine/src/integrations/hooks.ts` | Claude hook paths, inspection, install (backup, copy, register) |
| `packages/machine/src/integrations/domain.ts` | `integrationsDomain`: inspect, steps, run; type order, groups, categories |
| `packages/machine/src/integrations/index.ts` | The integrations exports |
| `packages/machine/src/index.ts` (modify) | Re-exports `./integrations/index.ts` |
| `packages/machine/checks/support/integrations.ts` | Fake `claude`/`codex` executables, declaration fixtures, `desiredOf` |
| `packages/machine/checks/integrations-plugins.spec.ts` | Port of `test/plugins.test.mjs` and `test/codex-plugins.test.mjs` |
| `packages/machine/checks/integrations-mcp.spec.ts` | Port of `test/codex-mcp.test.mjs` |
| `packages/machine/checks/integrations-hooks.spec.ts` | Port of `test/hooks.test.mjs` |
| `packages/machine/checks/integrations-domain.spec.ts` | Port of `test/integrations-runner.test.mjs` plus domain and executor tests |
| `packages/machine/README.md`, the spec (modify) | Record the `steps` change and the integrations domain |

---

### Task 1: `steps` receives the desired config

The integrations domain cannot build a step from an `Observed` item alone. The item carries no declaration type, which `--no-plugins` and the type order need, and no installer command, which the summary needs. This is the smallest additive change: a fourth argument that existing domains may ignore.

**Files:**
- Modify: `packages/machine/src/model.ts` (the `Domain` type)
- Modify: `packages/machine/src/run.ts` (`plan`)
- Test: `packages/machine/checks/run.spec.ts`

**Interfaces:**
- Produces: `Domain.steps: (items, selection, kind, desired: DesiredConfig) => { steps; skipped }`. `plan(kind, report, selection, domains)` calls it with `report.desired`.

- [ ] **Step 1: Write the failing test.** Append to `packages/machine/checks/run.spec.ts`:

```ts
test('plan hands each domain the desired config the report came from', () => {
  const report: MachineReport = { desired, items: [item('a')], probeErrors: [] };
  let seen: DesiredConfig | undefined;
  const domain: Domain = {
    ...fake(() => Effect.succeed({ ok: true })),
    steps: (_items, _selection, _kind, given) => { seen = given; return { steps: [], skipped: [] }; },
  };
  plan('apply', report, selectAll, [domain]);
  assert.equal(seen, desired);
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `node --test packages/machine/checks/run.spec.ts`
Expected: typecheck aside, the test fails with `undefined !== desired` (Node strips types, so it runs).

- [ ] **Step 3: Implement.** In `packages/machine/src/model.ts`, replace the `steps` member of `Domain`:

```ts
  // `desired` is the report's: a step may need a declaration the observed item does not carry.
  readonly steps: (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind, desired: DesiredConfig) =>
    { steps: ReadonlyArray<Step>; skipped: ReadonlyArray<Skipped> };
```

In `packages/machine/src/run.ts`, in `plan`, change the call:

```ts
    const part = domain.steps(chosen.filter((item) => item.domain === domain.name), selection, kind, report.desired);
```

- [ ] **Step 4: Run tests and typecheck.**

Run: `npm test -w packages/machine && npm run typecheck -w packages/machine`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit.**

```bash
git add packages/machine/src/model.ts packages/machine/src/run.ts packages/machine/checks/run.spec.ts
git commit -m "feat: pass the desired config to a domain's steps"
```

---

### Task 2: Plugins and marketplaces for Claude and Codex

Port `src/integrations/claude-plugins.mjs` and `codex-plugins.mjs`, plus the typed declaration view and the fake-executable test support that later tasks reuse.

**Files:**
- Create: `packages/machine/src/integrations/declaration.ts`
- Create: `packages/machine/src/integrations/plugins.ts`
- Create: `packages/machine/checks/support/integrations.ts`
- Test: `packages/machine/checks/integrations-plugins.spec.ts`

**Interfaces:**
- Consumes: `Fs` (`readText`), `Processes` (`run`), `LaunchFailed` from `../errors.ts`.
- Produces (`declaration.ts`):
  - `type IntegrationType = 'hook' | 'marketplace' | 'plugin' | 'mcp'`
  - `type Declaration = { id; label; target: Target; type: IntegrationType; default: boolean; plugin?; marketplace?; name?; command?; args?: ReadonlyArray<string>; requiresEnv?: ReadonlyArray<string>; prerequisite?; event?; file? }`, with every field readonly and every unlisted type `string`.
  - `type IntegrationState = 'installed' | 'missing' | 'blocked' | 'unknown'`
  - `type Inspected = { readonly state: IntegrationState; readonly note: string }`
  - `type Installer = { readonly cmd: string; readonly args: ReadonlyArray<string> }`
  - `asDeclaration(integration: Integration): Declaration` and `commandLine(installer: Installer): string`
- Produces (`plugins.ts`):
  - `marketplaceCommand(d)`, `pluginCommand(d)`, `codexMarketplaceCommand(d)`, `codexPluginCommand(d)`, `codexPluginListCommand()`, `codexMarketplaceListCommand()`, all returning `Installer`.
  - `installCommand(d: Declaration): Installer` for a plugin or marketplace of either target.
  - `type PluginState = { plugins: ReadonlySet<string>; marketplaces: ReadonlySet<string>; pluginError?: string; marketplaceError?: string }`, readonly, and `EMPTY_PLUGIN_STATE`.
  - `claudePluginState(claudeDir: string): Effect<PluginState, never, Fs>`
  - `readCodexState: Effect<PluginState, never, Processes>`
  - `inspectPlugin(d: Declaration, state: PluginState): Inspected` for a `plugin` or a `marketplace`.
  - `userScopeInstalls(claudeDir): Effect<{ name: string; version: string | null }[], never, Fs>` and `knownMarketplaces(claudeDir): Effect<Record<string, unknown>, never, Fs>`, ported for the undeclared probe (#57).
- Produces (`checks/support/integrations.ts`): `fakeBin()`, the fixtures `CLAUDE_MARKETPLACE`, `CLAUDE_PLUGIN`, `CODEX_MARKETPLACE`, `CODEX_PLUGIN`, `MCP`, `HOOK`, and `desiredOf(...)`.

- [ ] **Step 1: Write the test support.** Create `packages/machine/checks/support/integrations.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import type { Declaration } from '../../src/integrations/declaration.ts';

// A temp bin of fake agent CLIs. Each records "<name> <args>" to a log, then runs `body` (sh).
export const fakeBin = () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-agents-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const tool = (name: string, body = 'exit 0') => {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${log}'\n${body}\n`);
    chmodSync(file, 0o755);
  };
  // A fake codex answering the two --json list commands from fixture files.
  const codex = (plugins: unknown, marketplaces: unknown, installBody = 'exit 0') => {
    writeFileSync(join(dir, 'plugins.json'), JSON.stringify(plugins));
    writeFileSync(join(dir, 'marketplaces.json'), JSON.stringify(marketplaces));
    tool('codex', [
      'case "$*" in',
      `  "plugin list --json") cat '${join(dir, 'plugins.json')}' ;;`,
      `  "plugin marketplace list --json") cat '${join(dir, 'marketplaces.json')}' ;;`,
      `  *) ${installBody} ;;`,
      'esac',
    ].join('\n'));
  };
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { dir, bin, path: `${bin}:/usr/bin:/bin`, tool, codex, calls };
};

export const CLAUDE_MARKETPLACE: Declaration = {
  id: 'cm-market', label: 'context-mode marketplace', target: 'claude', type: 'marketplace', default: true,
  marketplace: 'mksglu/context-mode', name: 'context-mode',
};
export const CLAUDE_PLUGIN: Declaration = {
  id: 'cm', label: 'context-mode', target: 'claude', type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};
export const CODEX_MARKETPLACE: Declaration = { ...CLAUDE_MARKETPLACE, id: 'cm-market-codex', target: 'codex' };
export const CODEX_PLUGIN: Declaration = { ...CLAUDE_PLUGIN, id: 'cm-codex', target: 'codex' };
export const MCP: Declaration = { id: 'srv', label: 'srv', target: 'codex', type: 'mcp', default: true, command: 'srv' };
export const HOOK: Declaration = {
  id: 'hk', label: 'hk', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/h.mjs',
};

// A resolved profile holding exactly these declarations; `enabled` overrides `default` per id.
export const desiredOf = (declarations: Declaration[], enabled: Record<string, boolean> = {}): DesiredConfig => ({
  files: [], skills: [], allow: {}, issues: [],
  integrations: declarations.map((d) => ({
    id: d.id,
    declaration: d,
    enabled: enabled[d.id] ?? d.default,
    from: { layer: 'base' as const, source: 'integrations.json' },
  })),
});
```

- [ ] **Step 2: Write the failing tests.** Create `packages/machine/checks/integrations-plugins.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { Fs, nodeFs, nodeProcesses } from '../src/index.ts';
import {
  claudePluginState, codexMarketplaceCommand, codexMarketplaceListCommand, codexPluginCommand, codexPluginListCommand,
  inspectPlugin, installCommand, knownMarketplaces, marketplaceCommand, pluginCommand, readCodexState, userScopeInstalls,
  type PluginState,
} from '../src/integrations/plugins.ts';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, CODEX_MARKETPLACE, CODEX_PLUGIN, fakeBin } from './support/integrations.ts';

const withFs = <A>(effect: Effect.Effect<A, never, Fs>) => Effect.runPromise(effect.pipe(Effect.provide(nodeFs)));
const codexState = (path: string) =>
  Effect.runPromise(readCodexState.pipe(Effect.provide(Layer.merge(nodeFs, nodeProcesses({ path })))));

const claudeHome = (installed: unknown = { plugins: {} }, marketplaces: unknown = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-claude-plugins-'));
  mkdirSync(join(dir, 'plugins'));
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify(installed));
  writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify(marketplaces));
  return dir;
};

// Argument arrays, never a shell string: names come from a manifest.
test('Claude commands are argv arrays', () => {
  assert.deepEqual(marketplaceCommand(CLAUDE_MARKETPLACE), { cmd: 'claude', args: ['plugin', 'marketplace', 'add', 'mksglu/context-mode'] });
  assert.deepEqual(pluginCommand(CLAUDE_PLUGIN), { cmd: 'claude', args: ['plugin', 'install', 'context-mode@context-mode'] });
});

// `codex plugin install` exits 2 ("unrecognized subcommand"); `add` takes PLUGIN@MARKETPLACE as one argument.
test('Codex commands use plugin add and plugin marketplace add', () => {
  assert.deepEqual(codexPluginCommand(CODEX_PLUGIN), { cmd: 'codex', args: ['plugin', 'add', 'context-mode@context-mode'] });
  assert.deepEqual(codexMarketplaceCommand(CODEX_MARKETPLACE), { cmd: 'codex', args: ['plugin', 'marketplace', 'add', 'mksglu/context-mode'] });
  assert.deepEqual(codexPluginListCommand(), { cmd: 'codex', args: ['plugin', 'list', '--json'] });
  assert.deepEqual(codexMarketplaceListCommand(), { cmd: 'codex', args: ['plugin', 'marketplace', 'list', '--json'] });
});

test('installCommand dispatches by target so a Codex plugin never reaches claude', () => {
  assert.equal(installCommand(CLAUDE_PLUGIN).cmd, 'claude');
  assert.equal(installCommand(CODEX_PLUGIN).cmd, 'codex');
  assert.deepEqual(installCommand(CODEX_MARKETPLACE).args.slice(0, 2), ['plugin', 'marketplace']);
});

test('Claude state comes from its own installed-plugin and marketplace files', async () => {
  const state = await withFs(claudePluginState(claudeHome({ plugins: { 'context-mode@context-mode': {} } }, { 'context-mode': {} })));
  assert.equal(inspectPlugin(CLAUDE_PLUGIN, state).state, 'installed');
  assert.equal(inspectPlugin(CLAUDE_MARKETPLACE, state).state, 'installed');
});

test('absent Claude entries read as missing', async () => {
  const state = await withFs(claudePluginState(claudeHome()));
  assert.equal(inspectPlugin(CLAUDE_PLUGIN, state).state, 'missing');
  assert.equal(inspectPlugin(CLAUDE_MARKETPLACE, state).state, 'missing');
});

// A machine that never ran Claude, or a file of any shape, is "nothing installed", never a crash.
test('missing or corrupt Claude state reads as missing', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'machine-claude-bare-'));
  assert.equal(inspectPlugin(CLAUDE_PLUGIN, await withFs(claudePluginState(bare))).state, 'missing');
  const corrupt = claudeHome();
  writeFileSync(join(corrupt, 'plugins', 'installed_plugins.json'), '{ not json');
  assert.equal(inspectPlugin(CLAUDE_PLUGIN, await withFs(claudePluginState(corrupt))).state, 'missing');
});

test('the v2 shape yields user-scope installs with their versions', async () => {
  const dir = claudeHome({ version: 2, plugins: { 'superpowers@claude-plugins-official': [{ scope: 'user', version: '6.3.0' }] } });
  assert.deepEqual(await withFs(userScopeInstalls(dir)), [{ name: 'superpowers@claude-plugins-official', version: '6.3.0' }]);
});

test('non-user scopes are not machine-wide installs', async () => {
  const dir = claudeHome({ version: 2, plugins: { 'a@m': [{ scope: 'project', version: '1' }] } });
  assert.deepEqual(await withFs(userScopeInstalls(dir)), []);
});

test('a plugin installed at several scopes keeps the user-scope record', async () => {
  const dir = claudeHome({ version: 2, plugins: { 'a@m': [{ scope: 'project', version: '1' }, { scope: 'user', version: '2' }] } });
  assert.deepEqual(await withFs(userScopeInstalls(dir)), [{ name: 'a@m', version: '2' }]);
});

test('the older shape counts as user scope with an unknown version', async () => {
  assert.deepEqual(await withFs(userScopeInstalls(claudeHome({ 'a@m': true }))), [{ name: 'a@m', version: null }]);
});

test('a missing plugin file reads as nothing installed, and marketplaces are keyed by name', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'machine-claude-empty-'));
  assert.deepEqual(await withFs(userScopeInstalls(empty)), []);
  assert.deepEqual(await withFs(knownMarketplaces(empty)), {});
  const dir = claudeHome({ plugins: {} }, { 'claude-plugins-official': { source: {} } });
  assert.deepEqual(Object.keys(await withFs(knownMarketplaces(dir))), ['claude-plugins-official']);
});

// Shapes copied from the real CLI's output.
const PLUGINS = { installed: [{ pluginId: 'context-mode@context-mode', name: 'context-mode', installed: true }], available: [] };
const MARKETPLACES = { marketplaces: [{ name: 'context-mode', root: '/tmp/x' }, { name: 'openai-curated', root: '/tmp/y' }] };

test('Codex state is read through its --json output', async () => {
  const fake = fakeBin();
  fake.codex(PLUGINS, MARKETPLACES);
  const state = await codexState(fake.path);
  assert.equal(inspectPlugin(CODEX_PLUGIN, state).state, 'installed');
  assert.equal(inspectPlugin(CODEX_MARKETPLACE, state).state, 'installed');
  assert.deepEqual(fake.calls(), ['codex plugin list --json', 'codex plugin marketplace list --json']);
});

test('absent Codex entries read as missing', async () => {
  const fake = fakeBin();
  fake.codex({ installed: [], available: [] }, { marketplaces: [] });
  const state = await codexState(fake.path);
  assert.equal(inspectPlugin(CODEX_PLUGIN, state).state, 'missing');
  assert.equal(inspectPlugin(CODEX_MARKETPLACE, state).state, 'missing');
});

// The registered name is declared, not derived: `thedotmack/claude-mem` registers as `thedotmack`.
test('the declared marketplace name is what matches, whatever the source', () => {
  const state: PluginState = { plugins: new Set(), marketplaces: new Set(['thedotmack', 'context-mode']) };
  assert.equal(inspectPlugin({ ...CODEX_MARKETPLACE, marketplace: 'https://github.com/mksglu/context-mode.git' }, state).state, 'installed');
  assert.equal(inspectPlugin({ ...CODEX_MARKETPLACE, marketplace: 'thedotmack/claude-mem', name: 'thedotmack' }, state).state, 'installed');
  assert.equal(inspectPlugin({ ...CODEX_MARKETPLACE, marketplace: 'thedotmack/claude-mem', name: 'claude-mem' }, state).state, 'missing');
});

// Unknown, not missing: a failed probe cannot tell "absent" from "unreadable".
test('a codex CLI that cannot launch leaves both lists unknown with a reason', async () => {
  const fake = fakeBin();
  const state = await codexState(fake.path);
  assert.equal(inspectPlugin(CODEX_PLUGIN, state).state, 'unknown');
  assert.match(inspectPlugin(CODEX_PLUGIN, state).note, /could not list Codex plugins: could not launch codex/);
  assert.match(state.marketplaceError ?? '', /could not list Codex marketplaces/);
});

test('a non-zero exit and unparseable output degrade the same way', async () => {
  const exits = fakeBin();
  exits.tool('codex', 'exit 3');
  assert.match((await codexState(exits.path)).pluginError ?? '', /could not list Codex plugins: exited 3/);
  const garbage = fakeBin();
  garbage.tool('codex', 'echo not-json');
  assert.match((await codexState(garbage.path)).pluginError ?? '', /could not read the Codex plugin list/);
});

test('a marketplace probe failure does not erase a successful plugin result', async () => {
  const fake = fakeBin();
  fake.codex(PLUGINS, 'not an object');
  const state = await codexState(fake.path);
  assert.equal(inspectPlugin(CODEX_PLUGIN, state).state, 'installed');
  assert.equal(inspectPlugin(CODEX_MARKETPLACE, state).state, 'unknown');
});
```

The `'not an object'` marketplace fixture is the JSON string `"not an object"`. It parses, but has no `marketplaces` array, so it must be reported as unreadable.

- [ ] **Step 3: Run them and watch them fail.**

Run: `node --test packages/machine/checks/integrations-plugins.spec.ts`
Expected: FAIL, `Cannot find module .../src/integrations/plugins.ts`.

- [ ] **Step 4: Implement `declaration.ts`.** Create `packages/machine/src/integrations/declaration.ts`:

```ts
import type { Integration, Target } from '@nortuscc/profile-engine';

export type IntegrationType = 'hook' | 'marketplace' | 'plugin' | 'mcp';

// One integrations.json entry as the engine validated it. Fields beyond the common five belong to one type.
export type Declaration = {
  readonly id: string;
  readonly label: string;
  readonly target: Target;
  readonly type: IntegrationType;
  readonly default: boolean;
  readonly plugin?: string;
  readonly marketplace?: string;
  readonly name?: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly requiresEnv?: ReadonlyArray<string>;
  readonly prerequisite?: string;
  readonly event?: string;
  readonly file?: string;
};

// `unknown`: the agent's CLI could not say whether the item is installed.
export type IntegrationState = 'installed' | 'missing' | 'blocked' | 'unknown';
export type Inspected = { readonly state: IntegrationState; readonly note: string };
// An installer invocation: argv only, never a shell string.
export type Installer = { readonly cmd: string; readonly args: ReadonlyArray<string> };

// The engine refuses a document with any invalid entry, so a resolved declaration already has its type's fields.
export const asDeclaration = (integration: Integration): Declaration => integration as unknown as Declaration;

export const commandLine = (installer: Installer): string => [installer.cmd, ...installer.args].join(' ');
```

- [ ] **Step 5: Implement `plugins.ts`.** Create `packages/machine/src/integrations/plugins.ts`:

```ts
import { join } from 'node:path';
import { Effect } from 'effect';
import { Fs } from '../fs.ts';
import { Processes } from '../processes.ts';
import type { Declaration, Inspected, Installer } from './declaration.ts';

// Each agent owns where its plugins land and how they update; nortuscc only asks it to install them.
export const marketplaceCommand = (d: Declaration): Installer => ({ cmd: 'claude', args: ['plugin', 'marketplace', 'add', d.marketplace!] });
export const pluginCommand = (d: Declaration): Installer => ({ cmd: 'claude', args: ['plugin', 'install', d.plugin!] });
// Codex has no `plugin install`; `add` takes the PLUGIN@MARKETPLACE selector the manifest already spells.
export const codexMarketplaceCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['plugin', 'marketplace', 'add', d.marketplace!] });
export const codexPluginCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['plugin', 'add', d.plugin!] });
export const codexPluginListCommand = (): Installer => ({ cmd: 'codex', args: ['plugin', 'list', '--json'] });
export const codexMarketplaceListCommand = (): Installer => ({ cmd: 'codex', args: ['plugin', 'marketplace', 'list', '--json'] });

// The installer for a plugin or marketplace, chosen by target so a Codex item never reaches claude.
export const installCommand = (d: Declaration): Installer =>
  d.target === 'codex'
    ? (d.type === 'marketplace' ? codexMarketplaceCommand(d) : codexPluginCommand(d))
    : (d.type === 'marketplace' ? marketplaceCommand(d) : pluginCommand(d));

// What an agent reports installed. An error means that list is unknown, not empty.
export type PluginState = {
  readonly plugins: ReadonlySet<string>;
  readonly marketplaces: ReadonlySet<string>;
  readonly pluginError?: string;
  readonly marketplaceError?: string;
};

export const EMPTY_PLUGIN_STATE: PluginState = { plugins: new Set(), marketplaces: new Set() };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A file another tool owns can be absent, unreadable or any shape; all of them read as "nothing".
const readJsonObject = (path: string): Effect.Effect<Record<string, unknown>, never, Fs> =>
  Fs.use((fs) => fs.readText(path)).pipe(
    Effect.map((text) => {
      if (text === undefined) return {};
      try {
        const parsed: unknown = JSON.parse(text);
        return isPlainObject(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }),
    Effect.orElseSucceed(() => ({})),
  );

const installedPlugins = (claudeDir: string) =>
  readJsonObject(join(claudeDir, 'plugins', 'installed_plugins.json')).pipe(
    Effect.map((raw) => (isPlainObject(raw.plugins) ? raw.plugins : 'plugins' in raw ? {} : raw)),
  );

export const knownMarketplaces = (claudeDir: string) => readJsonObject(join(claudeDir, 'plugins', 'known_marketplaces.json'));

// User-scope installs with versions. A v2 record carries scope and version; a project or managed
// install is someone else's. The older non-array shape counts as user scope, version unknown.
export const userScopeInstalls = (claudeDir: string) =>
  installedPlugins(claudeDir).pipe(
    Effect.map((plugins) => {
      const installs: { name: string; version: string | null }[] = [];
      for (const [name, value] of Object.entries(plugins)) {
        if (!Array.isArray(value)) {
          installs.push({ name, version: null });
          continue;
        }
        const record = value.find((entry) => isPlainObject(entry) && entry.scope === 'user') as Record<string, unknown> | undefined;
        if (record) installs.push({ name, version: typeof record.version === 'string' ? record.version : null });
      }
      return installs;
    }),
  );

// Claude records its state in files under its own directory.
export const claudePluginState = (claudeDir: string): Effect.Effect<PluginState, never, Fs> =>
  Effect.all([installedPlugins(claudeDir), knownMarketplaces(claudeDir)]).pipe(
    Effect.map(([plugins, marketplaces]) => ({ plugins: new Set(Object.keys(plugins)), marketplaces: new Set(Object.keys(marketplaces)) })),
  );

type Listed = { readonly names: ReadonlySet<string> } | { readonly error: string };

// One `--json` list: the `field` of each entry in `parsed[list]`. A launch failure, a non-zero exit or
// output of another shape becomes an error, never a failure. An absent list reads as empty, as before.
const listNames = (installer: Installer, noun: string, list: string, field: string): Effect.Effect<Listed, never, Processes> =>
  Processes.use((p) => p.run({ cmd: installer.cmd, args: installer.args, output: 'capture' })).pipe(
    Effect.map(({ code, stdout }): Listed => {
      if (code !== 0) return { error: `could not list Codex ${noun}s: exited ${code}` };
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (!isPlainObject(parsed)) throw new Error('unexpected output');
        const entries = parsed[list] ?? [];
        if (!Array.isArray(entries)) throw new Error(`'${list}' is not a list`);
        return { names: new Set(entries.flatMap((e) => (isPlainObject(e) && typeof e[field] === 'string' ? [e[field]] : []))) };
      } catch (err) {
        return { error: `could not read the Codex ${noun} list: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
    Effect.catchTag('LaunchFailed', (err) => Effect.succeed<Listed>({ error: `could not list Codex ${noun}s: ${err.message}` })),
  );

// Codex keeps no readable state files; its CLI's --json output is the supported answer. Read once per inspect.
export const readCodexState: Effect.Effect<PluginState, never, Processes> = Effect.gen(function* () {
  const plugins = yield* listNames(codexPluginListCommand(), 'plugin', 'installed', 'pluginId');
  const marketplaces = yield* listNames(codexMarketplaceListCommand(), 'marketplace', 'marketplaces', 'name');
  return {
    plugins: 'names' in plugins ? plugins.names : new Set<string>(),
    marketplaces: 'names' in marketplaces ? marketplaces.names : new Set<string>(),
    ...('error' in plugins ? { pluginError: plugins.error } : {}),
    ...('error' in marketplaces ? { marketplaceError: marketplaces.error } : {}),
  };
});

// A marketplace matches by the name it registers as, which the manifest declares.
export const inspectPlugin = (d: Declaration, state: PluginState): Inspected => {
  if (d.type === 'marketplace') {
    if (state.marketplaceError) return { state: 'unknown', note: state.marketplaceError };
    return state.marketplaces.has(d.name!) ? { state: 'installed', note: 'already added' } : { state: 'missing', note: '' };
  }
  if (state.pluginError) return { state: 'unknown', note: state.pluginError };
  return state.plugins.has(d.plugin!) ? { state: 'installed', note: 'already installed' } : { state: 'missing', note: '' };
};
```

- [ ] **Step 6: Run the tests and the typecheck.**

Run: `node --test packages/machine/checks/integrations-plugins.spec.ts && npm run typecheck -w packages/machine`
Expected: all pass, no type errors.

- [ ] **Step 7: Commit.**

```bash
git add packages/machine/src/integrations/declaration.ts packages/machine/src/integrations/plugins.ts packages/machine/checks/support/integrations.ts packages/machine/checks/integrations-plugins.spec.ts
git commit -m "feat: port Claude and Codex plugin and marketplace adapters to @nortuscc/machine"
```

---

### Task 3: Codex MCP and Claude hooks

Port `src/integrations/codex-mcp.mjs` (pure; `env` is passed in) and `claude-hooks.mjs` (through `Fs` and `Backups`).

**Files:**
- Create: `packages/machine/src/integrations/mcp.ts`
- Create: `packages/machine/src/integrations/hooks.ts`
- Test: `packages/machine/checks/integrations-mcp.spec.ts`
- Test: `packages/machine/checks/integrations-hooks.spec.ts`

**Interfaces:**
- Consumes: `Declaration`, `Inspected`, `Installer` (Task 2); `Fs`, `Backups`, `FsFailed`, `StepResult`.
- Produces (`mcp.ts`):
  - `type Env = Readonly<Record<string, string | undefined>>`
  - `mcpCommand(d): Installer`, `missingEnv(d, env): string[]`, `blockedNote(d, missing): string`
  - `describeMcp(d, env): string`
  - `inspectMcp(d, env, installed?: ReadonlyArray<string>): Inspected`
- Produces (`hooks.ts`):
  - `hookPaths(claudeDir, d): { settings: string; installed: string }`
  - `hookCommand(claudeDir, d): string`
  - `describeHook(claudeDir, d): string`
  - `inspectHook(claudeDir, d): Effect<Inspected, never, Fs>`
  - `installHook(paths: { repo: string; claude: string }, d): Effect<StepResult, FsFailed, Fs | Backups>`

- [ ] **Step 1: Write the failing MCP tests.** Create `packages/machine/checks/integrations-mcp.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMcp, inspectMcp, mcpCommand, missingEnv } from '../src/integrations/mcp.ts';
import type { Declaration } from '../src/integrations/declaration.ts';

const PLAIN: Declaration = { id: 'files', label: 'files', target: 'codex', type: 'mcp', default: true, command: 'mcp-files', args: ['--root', '/srv'] };
const NEEDS_KEY: Declaration = { id: 'openai', label: 'openai', target: 'codex', type: 'mcp', default: false, command: 'openai-mcp', requiresEnv: ['OPENAI_API_KEY'] };

// `--` keeps a server flag from being read as a flag to `codex mcp add`.
test('an MCP declaration becomes a codex mcp add argv array', () => {
  assert.deepEqual(mcpCommand(PLAIN), { cmd: 'codex', args: ['mcp', 'add', 'files', '--', 'mcp-files', '--root', '/srv'] });
});

test('inspection reports blocked, not missing, when a prerequisite is absent', () => {
  assert.equal(inspectMcp(NEEDS_KEY, {}).state, 'blocked');
  assert.equal(inspectMcp(NEEDS_KEY, { OPENAI_API_KEY: 'x' }).state, 'missing');
  assert.equal(inspectMcp(PLAIN, {}, ['files']).state, 'installed');
});

test('a blocked note names every missing variable and the guidance, never a value', () => {
  const item = { ...NEEDS_KEY, requiresEnv: ['ONE_KEY', 'TWO_KEY'], prerequisite: 'See the runbook.' };
  const note = inspectMcp(item, { SOMETHING_ELSE: 'sk-super-secret-value' }).note;
  assert.match(note, /ONE_KEY/);
  assert.match(note, /TWO_KEY/);
  assert.match(note, /See the runbook\./);
  assert.doesNotMatch(note, /sk-super-secret-value/);
});

test('an empty-string variable counts as absent', () => {
  assert.deepEqual(missingEnv(NEEDS_KEY, { OPENAI_API_KEY: '' }), ['OPENAI_API_KEY']);
});

test('describe names the variable but never its value', () => {
  const description = describeMcp(NEEDS_KEY, { OPENAI_API_KEY: 'sk-super-secret-value' });
  assert.equal(description, 'codex mcp add openai -- openai-mcp  (reads OPENAI_API_KEY from the environment)');
  assert.match(describeMcp(NEEDS_KEY, {}), /\[blocked: OPENAI_API_KEY not set\]$/);
});
```

- [ ] **Step 2: Write the failing hook tests.** Create `packages/machine/checks/integrations-hooks.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { backupsForRun, machinePaths, nodeFs } from '../src/index.ts';
import { hookCommand, inspectHook, installHook } from '../src/integrations/hooks.ts';
import type { Declaration } from '../src/integrations/declaration.ts';

const ITEM: Declaration = {
  id: 'nortuscc-demo-hook', label: 'demo hook', target: 'claude', type: 'hook', default: false,
  event: 'SessionStart', file: 'claude/hooks/nortuscc-hook.mjs',
};

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-hooks-'));
  const repo = join(home, 'repo');
  const claude = join(home, '.claude');
  mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(repo, 'claude', 'hooks', 'nortuscc-hook.mjs'), '// hook body\n');
  const paths = {
    repo, claude, codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const settings = join(claude, 'settings.json');
  return {
    repo, claude, settings, paths,
    install: () => Effect.runPromise(installHook({ repo, claude }, ITEM).pipe(Effect.provide(layer))),
    inspect: () => Effect.runPromise(inspectHook(claude, ITEM).pipe(Effect.provide(nodeFs))),
    read: () => JSON.parse(readFileSync(settings, 'utf8')),
    backups: () => (existsSync(paths.backups) ? readdirSync(paths.backups) : []),
  };
};

test('hook registration preserves every unrelated key and hook', async () => {
  const fx = fixture();
  const before = {
    theme: 'dark', permissions: { allow: ['Bash(gh pr view:*)'] }, enabledPlugins: { 'a@b': true },
    hooks: { Stop: [{ hooks: [{ command: 'mine' }] }] },
  };
  writeFileSync(fx.settings, JSON.stringify(before));
  await fx.install();
  const after = fx.read();
  for (const key of ['theme', 'permissions', 'enabledPlugins'] as const) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
  assert.match(JSON.stringify(after.hooks.SessionStart), /nortuscc-hook/);
});

test('the settings file is backed up in the legacy layout before it changes', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, JSON.stringify({ theme: 'dark' }));
  await fx.install();
  const [run] = fx.backups();
  assert.ok(run?.startsWith('nortuscc-'));
  assert.equal(readFileSync(join(fx.paths.backups, run!, 'claude', 'settings.json'), 'utf8'), JSON.stringify({ theme: 'dark' }));
});

test('the hook file is copied into the Claude hooks directory', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  assert.equal((await fx.install()).ok, true);
  assert.equal(readFileSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'), 'utf8'), '// hook body\n');
});

// Re-running must not make the hook fire twice.
test('registering twice does not duplicate the entry', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  await fx.install();
  assert.deepEqual(await fx.install(), { ok: true, note: 'already registered' });
  const commands = fx.read().hooks.SessionStart.flatMap((g: { hooks?: { command: string }[] }) => g.hooks ?? [])
    .filter((h: { command: string }) => h.command.endsWith('nortuscc-hook.mjs'));
  assert.equal(commands.length, 1);
});

test('an existing hook on the same event is kept alongside the new one', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } }));
  await fx.install();
  const json = JSON.stringify(fx.read().hooks.SessionStart);
  assert.match(json, /someone-elses-hook/);
  assert.match(json, /nortuscc-hook/);
});

test('a missing settings file is created, with nothing to back up', async () => {
  const fx = fixture();
  assert.equal((await fx.install()).ok, true);
  assert.deepEqual(fx.backups(), []);
  assert.match(JSON.stringify(fx.read()), /nortuscc-hook/);
});

// The user's file, possibly mid-edit: never replaced, and nothing else is touched either.
test('a corrupt settings file is refused and nothing is written or copied', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{ not json');
  const result = await fx.install();
  assert.equal(result.ok, false);
  assert.match(result.note ?? '', /settings\.json could not be parsed/);
  assert.equal(readFileSync(fx.settings, 'utf8'), '{ not json');
  assert.equal(existsSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs')), false);
  assert.equal((await fx.inspect()).state, 'blocked');
});

test('inspection reads missing, then installed once registered', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  assert.equal((await fx.inspect()).state, 'missing');
  await fx.install();
  assert.equal((await fx.inspect()).state, 'installed');
});

// Registered but the file was deleted: missing again, and a reinstall restores the file without a second entry.
test('a registered hook whose file is gone reads as missing', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  await fx.install();
  rmSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'));
  assert.equal((await fx.inspect()).state, 'missing');
  assert.deepEqual(await fx.install(), { ok: true, note: 'already registered' });
  assert.equal(existsSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs')), true);
});

test('the registered command points at the installed copy, not the repo', () => {
  const fx = fixture();
  const command = hookCommand(fx.claude, ITEM);
  assert.equal(command, `node ${join(fx.claude, 'hooks', 'nortuscc-hook.mjs')}`);
  assert.ok(!command.includes(fx.repo));
});
```

- [ ] **Step 3: Run them and watch them fail.**

Run: `node --test packages/machine/checks/integrations-mcp.spec.ts packages/machine/checks/integrations-hooks.spec.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `mcp.ts`.** Create `packages/machine/src/integrations/mcp.ts`:

```ts
import type { Declaration, Inspected, Installer } from './declaration.ts';

export type Env = Readonly<Record<string, string | undefined>>;

// Codex's supported command, not a hand-edited config.toml, whose format Codex owns.
// `--` keeps a server flag from being read as a flag to `codex mcp add`.
export const mcpCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['mcp', 'add', d.id, '--', d.command!, ...(d.args ?? [])] });

// Only names are ever declared, so only names can be printed. An empty value counts as unset.
export const missingEnv = (d: Declaration, env: Env): string[] => (d.requiresEnv ?? []).filter((name) => !env[name]);

export const blockedNote = (d: Declaration, missing: ReadonlyArray<string>): string =>
  `set ${missing.join(', ')} before installing ${d.label}.${d.prerequisite ? ` ${d.prerequisite}` : ''}`.trimEnd();

// The command line never carries a credential; this names the variables the server reads instead.
export const describeMcp = (d: Declaration, env: Env): string => {
  const { cmd, args } = mcpCommand(d);
  const required = d.requiresEnv ?? [];
  const missing = missingEnv(d, env);
  const reads = required.length ? `  (reads ${required.join(', ')} from the environment)` : '';
  const blocked = missing.length ? `  [blocked: ${missing.join(', ')} not set]` : '';
  return `${[cmd, ...args].join(' ')}${reads}${blocked}`;
};

// Blocked, not missing: nothing nortuscc can run will install it until the variables are set.
export const inspectMcp = (d: Declaration, env: Env, installed: ReadonlyArray<string> = []): Inspected => {
  if (installed.includes(d.id)) return { state: 'installed', note: 'already configured' };
  const missing = missingEnv(d, env);
  return missing.length ? { state: 'blocked', note: blockedNote(d, missing) } : { state: 'missing', note: '' };
};
```

The legacy CLI never told the MCP adapter what Codex already has configured: `installed` was always `[]`. The default keeps that behaviour. Changing it is out of scope; the PR lists it as a follow-up.

- [ ] **Step 5: Implement `hooks.ts`.** Create `packages/machine/src/integrations/hooks.ts`:

```ts
import { basename, join } from 'node:path';
import { Effect } from 'effect';
import { Backups } from '../backups.ts';
import type { FsFailed } from '../errors.ts';
import { Fs } from '../fs.ts';
import type { StepResult } from '../model.ts';
import type { Declaration, Inspected } from './declaration.ts';

type Settings = Record<string, unknown>;
type Read = { readonly settings: Settings; readonly existed: boolean } | { readonly corrupt: true };

const isPlainObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// The hook runs from a nortuscc-owned copy under the Claude directory, so moving the clone cannot break it.
export const hookPaths = (claudeDir: string, d: Declaration) => ({
  settings: join(claudeDir, 'settings.json'),
  installed: join(claudeDir, 'hooks', basename(d.file!)),
});

export const hookCommand = (claudeDir: string, d: Declaration): string => `node ${hookPaths(claudeDir, d).installed}`;

export const describeHook = (claudeDir: string, d: Declaration): string =>
  `register ${d.event} hook -> ${hookPaths(claudeDir, d).installed}`;

// "No settings yet" is a bare machine; "cannot parse" is the user's file, never ours to replace.
const readSettings = (path: string): Effect.Effect<Read, FsFailed, Fs> =>
  Fs.use((fs) => fs.readText(path)).pipe(
    Effect.map((text): Read => {
      if (text === undefined) return { settings: {}, existed: false };
      try {
        const parsed: unknown = JSON.parse(text);
        return isPlainObject(parsed) ? { settings: parsed, existed: true } : { corrupt: true };
      } catch {
        return { corrupt: true };
      }
    }),
  );

const registrations = (settings: Settings, event: string): unknown[] => {
  const forEvent = isPlainObject(settings.hooks) ? settings.hooks[event] : undefined;
  return Array.isArray(forEvent) ? forEvent : [];
};

const registered = (settings: Settings, event: string, command: string) =>
  registrations(settings, event).some((group) =>
    isPlainObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isPlainObject(hook) && hook.command === command));

const CORRUPT = 'local settings.json could not be parsed';

export const inspectHook = (claudeDir: string, d: Declaration): Effect.Effect<Inspected, never, Fs> =>
  Effect.gen(function* () {
    const { settings, installed } = hookPaths(claudeDir, d);
    const read = yield* readSettings(settings);
    if ('corrupt' in read) return { state: 'blocked' as const, note: CORRUPT };
    const present = yield* Fs.use((fs) => fs.exists(installed));
    return present && registered(read.settings, d.event!, hookCommand(claudeDir, d))
      ? { state: 'installed' as const, note: 'already registered' }
      : { state: 'missing' as const, note: '' };
  }).pipe(Effect.catchTag('FsFailed', (err) => Effect.succeed<Inspected>({ state: 'blocked', note: err.message })));

// Adds only the declared registration, only when absent; never replaces the document or removes another hook.
// The file lands first, so a registration never points at a hook that is not there yet.
export const installHook = (
  paths: { readonly repo: string; readonly claude: string },
  d: Declaration,
): Effect.Effect<StepResult, FsFailed, Fs | Backups> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const { settings: path, installed } = hookPaths(paths.claude, d);
    const read = yield* readSettings(path);
    if ('corrupt' in read) return { ok: false, note: `${CORRUPT}; left it untouched (${path})` };

    yield* fs.copy(join(paths.repo, d.file!), installed);
    const command = hookCommand(paths.claude, d);
    if (registered(read.settings, d.event!, command)) return { ok: true, note: 'already registered' };

    if (read.existed) yield* (yield* Backups).preserve(path, 'settings.json', 'claude');
    const hooks = isPlainObject(read.settings.hooks) ? read.settings.hooks : {};
    const next = {
      ...read.settings,
      hooks: { ...hooks, [d.event!]: [...registrations(read.settings, d.event!), { hooks: [{ type: 'command', command }] }] },
    };
    yield* fs.writeTextAtomic(path, JSON.stringify(next, null, 2) + '\n');
    return { ok: true, note: `registered ${d.event}` };
  });
```

- [ ] **Step 6: Run the tests and the typecheck.**

Run: `node --test packages/machine/checks/integrations-mcp.spec.ts packages/machine/checks/integrations-hooks.spec.ts && npm run typecheck -w packages/machine`
Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add packages/machine/src/integrations/mcp.ts packages/machine/src/integrations/hooks.ts packages/machine/checks/integrations-mcp.spec.ts packages/machine/checks/integrations-hooks.spec.ts
git commit -m "feat: port the Codex MCP and Claude hook adapters to @nortuscc/machine"
```

---

### Task 4: The domain's inspect and steps

Port the runner's planning half, `integrationPlan`, as `integrationsDomain(options).inspect` and `.steps`.

**Files:**
- Create: `packages/machine/src/integrations/domain.ts`
- Test: `packages/machine/checks/integrations-domain.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–3. `Domain`, `Observed`, `Disposition`, `InstallCategory`, `Step`, `Skipped`, `MachinePathsValue`, `Fs`, `Processes`, `Backups`.
- Produces:
  - `TYPE_ORDER: readonly IntegrationType[]`, which is `['hook', 'marketplace', 'plugin', 'mcp']`
  - `categoryOf(type: IntegrationType): InstallCategory`
  - `groupLabel(d: Declaration): string`
  - `integrationKey(id: string): string`, which is `` `integration:${id}` ``
  - `type IntegrationsOptions = { paths: Pick<MachinePathsValue, 'repo' | 'claude'>; env: Env; installerOutput?: 'inherit' | 'capture' }`
  - `type IntegrationsServices = Fs | Processes | Backups`
  - `integrationsDomain(options): Domain<IntegrationsServices>`. Task 5 fills in `run`.

Rules, in priority order:

- **`inspect`:**
  - Orders items by `TYPE_ORDER`, then by declaration order.
  - Reads Claude plugin state only when a Claude plugin or marketplace is declared, and Codex state only when a Codex one is.
  - `probeErrors` are the Codex `pluginError` and `marketplaceError`, if any.
  - The disposition is `in-sync` for `installed`, `blocked` for `blocked` or `unknown`, `apply` for `missing` and enabled, and `excluded` for `missing` and not enabled.
  - `note` is set only when non-empty, and `from` is the resolved integration's.
- **`steps`:**
  - Every kind other than `apply` yields nothing.
  - For each item, in this order:
    1. An item whose key is no longer declared is skipped: `no longer declared`.
    2. `in-sync` yields nothing.
    3. A target outside `selection.targets` is skipped: `target not selected`.
    4. A declined category is skipped: `declined (--no-<category>)`.
    5. `blocked` is skipped with the item's note, else its state.
    6. `apply` becomes a step. So does `excluded` when `selection.only` names its key.
    7. Any other `excluded` item is skipped: `not enabled on this machine`.
- **A step:**
  - `action` is `install-integration`.
  - `summary` is the hook description, `describeMcp`, or the installer's `commandLine`.
  - `touches` is `[settings, installed]` for a hook and `[]` otherwise.
  - `interruptible` is `false` for a hook and `true` otherwise.

- [ ] **Step 1: Write the failing tests.** Create `packages/machine/checks/integrations-domain.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { backupsForRun, machinePaths, nodeFs, nodeProcesses, plan, selectAll, type MachineReport, type Selection } from '../src/index.ts';
import { categoryOf, integrationKey, integrationsDomain, TYPE_ORDER, type IntegrationsOptions } from '../src/integrations/domain.ts';
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, CODEX_MARKETPLACE, CODEX_PLUGIN, desiredOf, fakeBin, HOOK, MCP } from './support/integrations.ts';

// A temp machine: repo with the hook file, an empty Claude home, a fake bin, and the layers to run the domain.
const machine = (options: Partial<IntegrationsOptions> = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'machine-integrations-'));
  const repo = join(home, 'repo');
  const claude = join(home, '.claude');
  mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
  mkdirSync(join(claude, 'plugins'), { recursive: true });
  writeFileSync(join(repo, 'claude', 'hooks', 'h.mjs'), '// hook\n');
  const fake = fakeBin();
  const paths = {
    repo, claude, codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const domain = integrationsDomain({ paths, env: {}, ...options });
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses({ path: fake.path }))));
  const inspect = (desired: DesiredConfig): Promise<MachineReport> =>
    Effect.runPromise(domain.inspect(desired).pipe(Effect.map((part) => ({ desired, ...part })), Effect.provide(layer)));
  const claudeState = (installed: Record<string, unknown>, marketplaces: Record<string, unknown> = {}) => {
    writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: installed }));
    writeFileSync(join(claude, 'plugins', 'known_marketplaces.json'), JSON.stringify(marketplaces));
  };
  return { home, repo, claude, paths, fake, domain, layer, inspect, claudeState };
};

const keys = (items: ReadonlyArray<{ key: string }>) => items.map((i) => i.key);
const selection = (overrides: Partial<Selection> = {}): Selection => ({ ...selectAll, ...overrides });

test('items are keyed integration:<id> and ordered hook, marketplace, plugin, mcp, then declaration order', async () => {
  assert.deepEqual(TYPE_ORDER, ['hook', 'marketplace', 'plugin', 'mcp']);
  const m = machine();
  const first = { ...CLAUDE_PLUGIN, id: 'first', plugin: 'a@m' };
  const second = { ...CLAUDE_PLUGIN, id: 'second', plugin: 'b@m' };
  const report = await m.inspect(desiredOf([MCP, first, HOOK, second, CLAUDE_MARKETPLACE]));
  assert.deepEqual(keys(report.items), ['hk', 'cm-market', 'first', 'second', 'srv'].map(integrationKey));
  assert.ok(report.items.every((o) => o.domain === 'integrations'));
});

// Grouped by the agent that owns the work: a Codex marketplace is not a Claude plugin.
test('groups name the agent that owns the work', async () => {
  const m = machine();
  m.fake.codex({ installed: [] }, { marketplaces: [] });
  const report = await m.inspect(desiredOf([HOOK, CLAUDE_MARKETPLACE, CODEX_MARKETPLACE, CLAUDE_PLUGIN, CODEX_PLUGIN, MCP]));
  const group = (id: string) => report.items.find((o) => o.key === integrationKey(id))?.group;
  assert.equal(group('hk'), 'Claude hooks');
  assert.equal(group('cm-market'), 'Claude plugins');
  assert.equal(group('cm-market-codex'), 'Codex plugins');
  assert.equal(group('cm'), 'Claude plugins');
  assert.equal(group('cm-codex'), 'Codex plugins');
  assert.equal(group('srv'), 'Codex MCP');
});

test('dispositions follow state and whether the machine enables the item', async () => {
  const m = machine();
  m.claudeState({ 'context-mode@context-mode': {} });
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN, { ...CLAUDE_MARKETPLACE, default: false }, { ...MCP, requiresEnv: ['KEY'] }]));
  const by = Object.fromEntries(report.items.map((o) => [o.key, [o.state, o.disposition]]));
  assert.deepEqual(by[integrationKey('cm')], ['installed', 'in-sync']);
  assert.deepEqual(by[integrationKey('cm-market')], ['missing', 'excluded']);
  assert.deepEqual(by[integrationKey('srv')], ['blocked', 'blocked']);
  assert.deepEqual(report.items.find((o) => o.key === integrationKey('cm'))?.from, { layer: 'base', source: 'integrations.json' });
});

// A missing codex is a probe failure, not a crash, and Claude items are unaffected.
test('an absent codex CLI makes Codex items unknown and blocked and reports probe errors', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN, CODEX_PLUGIN, CODEX_MARKETPLACE]));
  const codex = report.items.find((o) => o.key === integrationKey('cm-codex'))!;
  assert.equal(codex.state, 'unknown');
  assert.equal(codex.disposition, 'blocked');
  assert.match(codex.note ?? '', /could not list Codex plugins/);
  assert.equal(report.probeErrors.length, 2);
  assert.equal(report.items.find((o) => o.key === integrationKey('cm'))?.disposition, 'apply');
  const planned = plan('apply', report, selectAll, [m.domain]);
  assert.deepEqual(keys(planned.steps), [integrationKey('cm')]);
  assert.ok(planned.skipped.some((s) => s.key === integrationKey('cm-codex') && /could not list Codex plugins/.test(s.reason)));
});

test('no Codex probe runs when no Codex plugin or marketplace is declared', async () => {
  const m = machine();
  m.fake.codex({ installed: [] }, { marketplaces: [] });
  await m.inspect(desiredOf([CLAUDE_PLUGIN, MCP]));
  assert.deepEqual(m.fake.calls(), []);
});

test('apply steps carry the exact installer command and are interruptible; the hook step is not', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN, CLAUDE_MARKETPLACE, HOOK, MCP]));
  const { steps } = plan('apply', report, selectAll, [m.domain]);
  assert.deepEqual(steps.map((s) => [s.key, s.action, s.summary, s.interruptible]), [
    [integrationKey('hk'), 'install-integration', `register SessionStart hook -> ${join(m.claude, 'hooks', 'h.mjs')}`, false],
    [integrationKey('cm-market'), 'install-integration', 'claude plugin marketplace add mksglu/context-mode', true],
    [integrationKey('cm'), 'install-integration', 'claude plugin install context-mode@context-mode', true],
    [integrationKey('srv'), 'install-integration', 'codex mcp add srv -- srv', true],
  ]);
  assert.deepEqual(steps[0]!.touches, [join(m.claude, 'settings.json'), join(m.claude, 'hooks', 'h.mjs')]);
  assert.deepEqual(steps[1]!.touches, []);
});

test('an installed item is never a step', async () => {
  const m = machine();
  m.claudeState({}, { 'context-mode': {} });
  const report = await m.inspect(desiredOf([CLAUDE_MARKETPLACE, CLAUDE_PLUGIN]));
  const planned = plan('apply', report, selectAll, [m.domain]);
  assert.deepEqual(keys(planned.steps), [integrationKey('cm')]);
  assert.deepEqual(planned.skipped, []);
});

test('a plan for one target skips the other agent', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN, MCP]));
  const planned = plan('apply', report, selection({ targets: ['codex'] }), [m.domain]);
  assert.deepEqual(keys(planned.steps), [integrationKey('srv')]);
  assert.deepEqual(planned.skipped, [{ key: integrationKey('cm'), reason: 'target not selected' }]);
});

// --no-plugins drops marketplaces too: they are machinery for plugins the user just declined.
test('declined categories remove whole groups, and a marketplace belongs to plugins', async () => {
  assert.deepEqual([categoryOf('hook'), categoryOf('marketplace'), categoryOf('plugin'), categoryOf('mcp')], ['hooks', 'plugins', 'plugins', 'mcp']);
  const m = machine();
  const report = await m.inspect(desiredOf([HOOK, CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, MCP]));
  const stepsFor = (declined: Selection['declined']) => keys(plan('apply', report, selection({ declined }), [m.domain]).steps);
  assert.deepEqual(stepsFor(['plugins']), ['hk', 'srv'].map(integrationKey));
  assert.deepEqual(stepsFor(['mcp']), ['hk', 'cm-market', 'cm'].map(integrationKey));
  assert.deepEqual(stepsFor(['hooks']), ['cm-market', 'cm', 'srv'].map(integrationKey));
  assert.ok(plan('apply', report, selection({ declined: ['plugins'] }), [m.domain]).skipped
    .some((s) => s.key === integrationKey('cm-market') && s.reason === 'declined (--no-plugins)'));
});

test('a default-off item installs only when explicitly picked', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([{ ...CLAUDE_PLUGIN, default: false }]));
  const key = integrationKey('cm');
  assert.deepEqual(plan('apply', report, selectAll, [m.domain]).skipped, [{ key, reason: 'not enabled on this machine' }]);
  assert.deepEqual(keys(plan('apply', report, selection({ only: [key] }), [m.domain]).steps), [key]);
});

test('a machine override enabling a default-off item makes it an apply step', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([{ ...CLAUDE_PLUGIN, default: false }], { cm: true }));
  assert.deepEqual(keys(plan('apply', report, selectAll, [m.domain]).steps), [integrationKey('cm')]);
});

test('uninstall and capture plans never touch integrations', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN]));
  for (const kind of ['uninstall', 'capture'] as const) {
    assert.deepEqual(plan(kind, report, selectAll, [m.domain]), { kind, steps: [], skipped: [] });
  }
});

test('an item whose declaration disappeared is skipped, not planned', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN]));
  const stale = { ...report, desired: desiredOf([]) };
  assert.deepEqual(plan('apply', stale, selectAll, [m.domain]).skipped, [{ key: integrationKey('cm'), reason: 'no longer declared' }]);
});

test('steps are deterministic, so a preview can be compared', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([HOOK, CLAUDE_PLUGIN, MCP]));
  assert.deepEqual(plan('apply', report, selectAll, [m.domain]), plan('apply', report, selectAll, [m.domain]));
});
```

Task 5 appends to this same file and reuses `machine()`. The `Effect`, `Layer`, `backupsForRun`, `machinePaths`, `nodeFs` and `nodeProcesses` imports serve the helper.

- [ ] **Step 2: Run them and watch them fail.**

Run: `node --test packages/machine/checks/integrations-domain.spec.ts`
Expected: FAIL, `Cannot find module .../src/integrations/domain.ts`.

- [ ] **Step 3: Implement.** Create `packages/machine/src/integrations/domain.ts`:

```ts
import { Effect } from 'effect';
import type { DesiredConfig, ResolvedIntegration } from '@nortuscc/profile-engine';
import type { Backups } from '../backups.ts';
import type { Fs } from '../fs.ts';
import type { Disposition, Domain, InstallCategory, Observed, Skipped, Step } from '../model.ts';
import type { MachinePathsValue } from '../paths.ts';
import type { Processes } from '../processes.ts';
import { asDeclaration, commandLine, type Declaration, type Inspected, type IntegrationType } from './declaration.ts';
import { describeHook, hookPaths, inspectHook } from './hooks.ts';
import { describeMcp, inspectMcp, type Env } from './mcp.ts';
import { claudePluginState, EMPTY_PLUGIN_STATE, inspectPlugin, installCommand, readCodexState } from './plugins.ts';

// Prerequisites first: a marketplace before its plugins; hooks are inert, so cheapest first.
// Within a type the manifest's order holds, which is how an author expresses any other dependency.
export const TYPE_ORDER: ReadonlyArray<IntegrationType> = ['hook', 'marketplace', 'plugin', 'mcp'];

// A marketplace is machinery for plugins, so --no-plugins drops it too.
export const categoryOf = (type: IntegrationType): InstallCategory =>
  type === 'hook' ? 'hooks' : type === 'mcp' ? 'mcp' : 'plugins';

// Grouped by the agent that owns the work, so two agents' same-named rows stay distinguishable.
export const groupLabel = (d: Declaration): string => {
  const agent = d.target === 'codex' ? 'Codex' : 'Claude';
  return d.type === 'hook' ? `${agent} hooks` : d.type === 'mcp' ? `${agent} MCP` : `${agent} plugins`;
};

export const integrationKey = (id: string): string => `integration:${id}`;

export type IntegrationsOptions = {
  readonly paths: Pick<MachinePathsValue, 'repo' | 'claude'>;
  // The environment MCP prerequisites are checked against; only variable names are ever reported.
  readonly env: Env;
  // 'capture' keeps installer stdout off the caller's stdout, which is the desktop backend's protocol channel.
  readonly installerOutput?: 'inherit' | 'capture';
};

export type IntegrationsServices = Fs | Processes | Backups;

const isPluginType = (d: Declaration) => d.type === 'plugin' || d.type === 'marketplace';

const dispositionOf = (state: Inspected['state'], enabled: boolean): Disposition =>
  state === 'installed' ? 'in-sync' : state === 'missing' ? (enabled ? 'apply' : 'excluded') : 'blocked';

const ordered = (integrations: ReadonlyArray<ResolvedIntegration>) =>
  integrations
    .map((resolved, index) => ({ resolved, d: asDeclaration(resolved.declaration), index }))
    .sort((a, b) => TYPE_ORDER.indexOf(a.d.type) - TYPE_ORDER.indexOf(b.d.type) || a.index - b.index);

// Hooks, marketplaces, plugins and MCP for Claude and Codex, from the engine's declarations.
export const integrationsDomain = (options: IntegrationsOptions): Domain<IntegrationsServices> => {
  const { paths, env } = options;

  const summaryOf = (d: Declaration): string =>
    d.type === 'hook' ? describeHook(paths.claude, d) : d.type === 'mcp' ? describeMcp(d, env) : commandLine(installCommand(d));

  const stepFor = (d: Declaration): Step => {
    const hook = d.type === 'hook' ? hookPaths(paths.claude, d) : undefined;
    return {
      key: integrationKey(d.id),
      domain: 'integrations',
      action: 'install-integration',
      summary: summaryOf(d),
      touches: hook ? [hook.settings, hook.installed] : [],
      // A hook edit is a file step and always completes; an installer can be cancelled.
      interruptible: d.type !== 'hook',
    };
  };

  return {
    name: 'integrations',

    inspect: (desired) =>
      Effect.gen(function* () {
        const entries = ordered(desired.integrations);
        const wants = (target: Declaration['target']) => entries.some(({ d }) => d.target === target && isPluginType(d));
        const claude = wants('claude') ? yield* claudePluginState(paths.claude) : EMPTY_PLUGIN_STATE;
        const codex = wants('codex') ? yield* readCodexState : EMPTY_PLUGIN_STATE;

        const items: Observed[] = [];
        for (const { resolved, d } of entries) {
          const inspected = d.type === 'hook'
            ? yield* inspectHook(paths.claude, d)
            : d.type === 'mcp'
              ? inspectMcp(d, env)
              : inspectPlugin(d, d.target === 'codex' ? codex : claude);
          items.push({
            key: integrationKey(d.id),
            domain: 'integrations',
            target: d.target,
            label: d.label,
            group: groupLabel(d),
            state: inspected.state,
            disposition: dispositionOf(inspected.state, resolved.enabled),
            ...(inspected.note ? { note: inspected.note } : {}),
            from: resolved.from,
          });
        }
        const probeErrors = [codex.pluginError, codex.marketplaceError].filter((e): e is string => Boolean(e));
        return { items, probeErrors };
      }),

    steps: (items, selection, kind, desired: DesiredConfig) => {
      if (kind !== 'apply') return { steps: [], skipped: [] };
      const declared = new Map(desired.integrations.map((r) => [integrationKey(r.id), asDeclaration(r.declaration)]));
      const steps: Step[] = [];
      const skipped: Skipped[] = [];
      const skip = (key: string, reason: string) => skipped.push({ key, reason });
      for (const item of items) {
        const d = declared.get(item.key);
        if (!d) skip(item.key, 'no longer declared');
        else if (item.disposition === 'in-sync') continue;
        else if (!selection.targets.includes(item.target)) skip(item.key, 'target not selected');
        else if (selection.declined.includes(categoryOf(d.type))) skip(item.key, `declined (--no-${categoryOf(d.type)})`);
        else if (item.disposition === 'blocked') skip(item.key, item.note ?? item.state);
        else if (item.disposition === 'apply' || selection.only?.includes(item.key)) steps.push(stepFor(d));
        else skip(item.key, 'not enabled on this machine');
      }
      return { steps, skipped };
    },

    run: (step) => Effect.succeed({ ok: false, note: `not yet implemented: ${step.key}` }),
  };
};
```

`run` is a stub until Task 5. No test exercises it here.

- [ ] **Step 4: Run the tests and the typecheck.**

Run: `node --test packages/machine/checks/integrations-domain.spec.ts && npm run typecheck -w packages/machine`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/machine/src/integrations/domain.ts packages/machine/checks/integrations-domain.spec.ts
git commit -m "feat: inspect and plan integrations from the engine's declarations"
```

---

### Task 5: The domain's run, through the executor and fake executables

Port `runIntegrations` and the install half of each adapter as `run(step, report)`. Prove it end to end through `execute`, with fake `claude` and `codex` executables.

**Files:**
- Modify: `packages/machine/src/integrations/domain.ts` (replace the `run` stub)
- Test: `packages/machine/checks/integrations-domain.spec.ts` (append)

**Interfaces:**
- Consumes: `installHook` (Task 3), `installCommand` (Task 2), `mcpCommand`, `missingEnv` and `blockedNote` (Task 3), `Processes`, `execute`.
- Produces: `run(step, report)` for integrations. It finds the declaration in `report.desired` by key, then:
  - A **hook** runs `installHook(paths, d)`.
  - An **MCP** item re-checks `env` first; a variable unset since planning gives `{ ok: false, note: blockedNote }` and spawns nothing. Otherwise it runs `mcpCommand`.
  - A **plugin or marketplace** runs `installCommand`.
  - An installer gives `{ ok: code === 0, note: code === 0 ? '' : 'exited <code>' }`. A `LaunchFailed` propagates, so the executor's note reads `could not launch <cmd>: …`.
  - A key that is not declared gives `{ ok: false, note: 'no longer declared' }`.

- [ ] **Step 1: Write the failing tests.** Append to `packages/machine/checks/integrations-domain.spec.ts`. Merge these imports into the file's existing import lines rather than adding duplicates:

```ts
import { readFileSync, existsSync } from 'node:fs';
import { Stream } from 'effect';
import { execute, Processes, type Progress } from '../src/index.ts';

const runAll = async (m: ReturnType<typeof machine>, desired: DesiredConfig, options: { signal?: AbortSignal; select?: Selection } = {}) => {
  const report = await m.inspect(desired);
  const chosen = plan('apply', report, options.select ?? selectAll, [m.domain]);
  const events = await Effect.runPromise(
    Stream.runCollect(execute(chosen, report, [m.domain], { signal: options.signal })).pipe(Effect.map((c) => [...c]), Effect.provide(m.layer)),
  );
  return events as Progress[];
};
const outcomes = (events: Progress[]) => events.flatMap((e) => (e.type === 'finished' ? [`${e.key}:${e.outcome}`] : []));

// Out of manifest order on purpose: the domain's order, not the manifest's, puts the marketplace first.
test('installers run in type order through the real executor', async () => {
  const m = machine();
  m.fake.tool('claude');
  m.fake.tool('codex');
  const events = await runAll(m, desiredOf([MCP, CLAUDE_PLUGIN, HOOK, CLAUDE_MARKETPLACE]));
  assert.deepEqual(m.fake.calls(), [
    'claude plugin marketplace add mksglu/context-mode',
    'claude plugin install context-mode@context-mode',
    'codex mcp add srv -- srv',
  ]);
  assert.deepEqual(outcomes(events), ['hk', 'cm-market', 'cm', 'srv'].map((id) => `${integrationKey(id)}:ok`));
  assert.match(readFileSync(join(m.claude, 'settings.json'), 'utf8'), /h\.mjs/);
});

test('a Codex plugin and marketplace install through codex, never claude', async () => {
  const m = machine();
  m.fake.codex({ installed: [] }, { marketplaces: [] });
  m.fake.tool('claude', 'exit 9');
  await runAll(m, desiredOf([CODEX_PLUGIN, CODEX_MARKETPLACE]));
  assert.deepEqual(m.fake.calls().slice(2), ['codex plugin marketplace add mksglu/context-mode', 'codex plugin add context-mode@context-mode']);
});

// One failing installer never takes the rest of the run with it.
test('a failed or unlaunchable installer is a failed step and later steps still run', async () => {
  const m = machine();
  m.fake.tool('claude', 'case "$*" in "plugin marketplace"*) exit 4 ;; esac');
  const events = await runAll(m, desiredOf([CLAUDE_MARKETPLACE, CLAUDE_PLUGIN, MCP]));
  const finished = events.flatMap((e) => (e.type === 'finished' ? [e] : []));
  assert.deepEqual(finished.map((e) => e.outcome), ['failed', 'ok', 'failed']);
  assert.equal(finished[0]!.note, 'exited 4');
  // codex is not in the fake bin, so the MCP installer cannot launch.
  assert.match(finished[2]!.note, /could not launch codex/);
  assert.deepEqual(events.at(-1), { type: 'done', ok: 1, failed: 2, backups: undefined });
});

test('an MCP prerequisite unset after planning fails before spawning anything', async () => {
  const m = machine({ env: { KEY: 'set' } });
  m.fake.tool('codex');
  const desired = desiredOf([{ ...MCP, requiresEnv: ['KEY'] }]);
  const report = await m.inspect(desired);
  const chosen = plan('apply', report, selectAll, [m.domain]);
  const unset = integrationsDomain({ paths: m.paths, env: {} });
  const events = await Effect.runPromise(
    Stream.runCollect(execute(chosen, report, [unset])).pipe(Effect.map((c) => [...c]), Effect.provide(m.layer)),
  );
  const finished = events.find((e) => e.type === 'finished');
  assert.equal(finished?.type === 'finished' && finished.outcome, 'failed');
  assert.match(finished?.type === 'finished' ? finished.note : '', /set KEY before installing srv/);
  assert.deepEqual(m.fake.calls(), []);
});

test('the hook step backs settings.json up into the run folder', async () => {
  const m = machine();
  writeFileSync(join(m.claude, 'settings.json'), '{"theme":"dark"}');
  const events = await runAll(m, desiredOf([HOOK]));
  const done = events.at(-1);
  assert.equal(done?.type, 'done');
  const folder = done?.type === 'done' ? done.backups : undefined;
  assert.ok(folder);
  assert.equal(readFileSync(join(folder!, 'claude', 'settings.json'), 'utf8'), '{"theme":"dark"}');
});

test('cancelling during an installer kills it and stops before the next step', async () => {
  const m = machine();
  const marker = join(m.home, 'started');
  m.fake.tool('claude', `touch '${marker}'; sleep 30`);
  m.fake.tool('codex');
  const controller = new AbortController();
  const watcher = setInterval(() => { if (existsSync(marker)) controller.abort(); }, 20);
  const started = Date.now();
  const events = await runAll(m, desiredOf([CLAUDE_PLUGIN, MCP]), { signal: controller.signal });
  clearInterval(watcher);
  assert.ok(Date.now() - started < 10_000, 'the sleeping installer must be killed, not awaited');
  assert.deepEqual(outcomes(events), [`${integrationKey('cm')}:cancelled`]);
  assert.deepEqual(events.at(-1), { type: 'cancelled', remaining: [integrationKey('srv')], backups: undefined });
  assert.equal(m.fake.calls().some((c) => c.startsWith('codex')), false);
});

// The desktop backend speaks JSON lines on stdout: its installers must not inherit it.
test('installerOutput capture runs installers with captured output; the default inherits', async () => {
  const seen: string[] = [];
  const recording = Layer.succeed(Processes, {
    run: (command) => Effect.sync(() => { seen.push(command.output); return { code: 0, stdout: '' }; }),
  });
  for (const installerOutput of ['capture', undefined] as const) {
    const m = machine(installerOutput ? { installerOutput } : {});
    const report = await m.inspect(desiredOf([CLAUDE_PLUGIN]));
    const chosen = plan('apply', report, selectAll, [m.domain]);
    await Effect.runPromise(
      Stream.runCollect(execute(chosen, report, [m.domain]))
        .pipe(Effect.provide(backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(m.paths), nodeFs, recording))))),
    );
  }
  assert.deepEqual(seen, ['capture', 'inherit']);
});

test('run reports a step whose declaration is gone as failed', async () => {
  const m = machine();
  const report = await m.inspect(desiredOf([CLAUDE_PLUGIN]));
  const chosen = plan('apply', report, selectAll, [m.domain]);
  const events = await Effect.runPromise(
    Stream.runCollect(execute(chosen, { ...report, desired: desiredOf([]) }, [m.domain])).pipe(Effect.map((c) => [...c]), Effect.provide(m.layer)),
  );
  const finished = events.find((e) => e.type === 'finished');
  assert.deepEqual(finished?.type === 'finished' && [finished.outcome, finished.note], ['failed', 'no longer declared']);
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `node --test packages/machine/checks/integrations-domain.spec.ts`
Expected: the new tests FAIL with `not yet implemented`, and the Task 4 tests still pass.

- [ ] **Step 3: Implement `run`.** In `packages/machine/src/integrations/domain.ts`, add these imports:

```ts
import { Processes } from '../processes.ts';                    // value import now, replacing the type-only one
import type { StepResult } from '../model.ts';                  // merge into the existing model.ts type import
import { installHook } from './hooks.ts';                       // merge into the existing hooks.ts import
import { blockedNote, mcpCommand, missingEnv } from './mcp.ts'; // merge into the existing mcp.ts import
import type { Installer } from './declaration.ts';              // merge into the existing declaration.ts import
```

Inside `integrationsDomain`, after `stepFor`, add:

```ts
  const output = options.installerOutput ?? 'inherit';

  // An installer's exit code is the step's result. A launch failure propagates; its message names the command.
  const runInstaller = (installer: Installer): Effect.Effect<StepResult, unknown, Processes> =>
    Processes.use((p) => p.run({ cmd: installer.cmd, args: installer.args, output })).pipe(
      Effect.map(({ code }) => ({ ok: code === 0, note: code === 0 ? '' : `exited ${code}` })),
    );
```

Replace the `run` stub:

```ts
    run: (step, report) => {
      const resolved = report.desired.integrations.find((r) => integrationKey(r.id) === step.key);
      if (!resolved) return Effect.succeed({ ok: false, note: 'no longer declared' });
      const d = asDeclaration(resolved.declaration);
      if (d.type === 'hook') return installHook(paths, d);
      if (d.type === 'mcp') {
        // Checked again here: the environment may have changed since the plan was made.
        const missing = missingEnv(d, env);
        return missing.length ? Effect.succeed({ ok: false, note: blockedNote(d, missing) }) : runInstaller(mcpCommand(d));
      }
      return runInstaller(installCommand(d));
    },
```

- [ ] **Step 4: Run the tests and the typecheck.**

Run: `node --test packages/machine/checks/integrations-domain.spec.ts && npm run typecheck -w packages/machine`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/machine/src/integrations/domain.ts packages/machine/checks/integrations-domain.spec.ts
git commit -m "feat: install integrations through Processes as interruptible steps"
```

---

### Task 6: Exports, documentation and full verification

**Files:**
- Create: `packages/machine/src/integrations/index.ts`
- Modify: `packages/machine/src/index.ts`
- Modify: `packages/machine/README.md`
- Modify: `docs/superpowers/specs/2026-10-05-machine-rebuild-design.md` (the `Domain` type block)
- Test: `packages/machine/checks/integrations-domain.spec.ts` (one export test)

- [ ] **Step 1: Write the failing export test.** Append to `packages/machine/checks/integrations-domain.spec.ts`:

```ts
test('the package root exports the integrations domain', async () => {
  const root = await import('../src/index.ts');
  assert.equal(typeof root.integrationsDomain, 'function');
  assert.equal(typeof root.readCodexState, 'object');
  assert.equal(typeof root.userScopeInstalls, 'function');
});
```

Run: `node --test packages/machine/checks/integrations-domain.spec.ts`
Expected: FAIL. `root.integrationsDomain` is `undefined`.

- [ ] **Step 2: Add the exports.** Create `packages/machine/src/integrations/index.ts`:

```ts
export * from './declaration.ts';
export * from './plugins.ts';
export * from './mcp.ts';
export * from './hooks.ts';
export * from './domain.ts';
```

Append to `packages/machine/src/index.ts`:

```ts
export * from './integrations/index.ts';
```

Run: `node --test packages/machine/checks/integrations-domain.spec.ts && npm run typecheck -w packages/machine`
Expected: PASS. If two modules export the same name, rename the one in the integrations module; never edit foundation names.

- [ ] **Step 3: Document.**

In `packages/machine/README.md`, change the domain bullet so it reads:

```markdown
- A domain (`config`, `integrations`, `skills`) implements `Domain<R>`: `inspect`, `steps(items, selection, kind, desired)`,
  and `run(step, report)`, which receives the report the plan was made from. `inspect`, `plan` and
  `execute` accept domains needing different services; the requirement is their union.
- `integrationsDomain({ paths, env, installerOutput })` installs hooks, marketplaces, plugins and MCP for Claude and
  Codex from `DesiredConfig.integrations`. Installers run through `Processes` as interruptible steps;
  pass `installerOutput: 'capture'` where stdout is a protocol channel (the desktop backend).
```

In the spec's "Domains" type block, change the `steps` line to:

```ts
  steps: (items: Observed[], selection: Selection, kind: 'apply' | 'uninstall' | 'capture', desired: DesiredConfig) =>
```

Add a sentence after the paragraph that starts with "`inspect`, `plan` and `execute` take the domain array generically":

```markdown
`plan` passes each domain's `steps` the report's `desired`, because an observed item does not carry its
declaration (the integrations domain needs a declaration's type and installer command).
```

- [ ] **Step 4: Full verification.**

Run:

```bash
npm run test:packages
npm run typecheck
npm test
git status --short
```

Expected: the package suites and the typecheck pass. The root suite passes apart from the known pre-existing issues: the `apps/desktop/checks/backend.spec.ts` teardown abort on Node 24.19, and the intermittent `test/fresh-machine.test.mjs`. Report any other failure.

If `git status` shows `skills-manifest.txt` modified, run `git checkout -- skills-manifest.txt`.

- [ ] **Step 5: Commit.**

```bash
git add packages/machine/src/integrations/index.ts packages/machine/src/index.ts packages/machine/README.md docs/superpowers/specs/2026-10-05-machine-rebuild-design.md packages/machine/checks/integrations-domain.spec.ts
git commit -m "docs: export and document the integrations domain"
```

---

## Out of scope, for the PR body

- Cutting `apply`, `status` and `pull` over to the domain, and deleting `src/integrations/*.mjs` and their tests: #59.
- The undeclared-items probe: #57. It can reuse `userScopeInstalls`, `knownMarketplaces`, `readCodexState` and `hookCommand`.
- MCP inspection still never learns what Codex has configured (`installed` is `[]`, as in the legacy CLI), so a declared MCP server always reads `missing`. A follow-up could read `codex mcp list --json`.
