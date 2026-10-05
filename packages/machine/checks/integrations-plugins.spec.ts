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
