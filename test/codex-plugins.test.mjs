import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codexMarketplaceCommand,
  codexPluginCommand,
  codexPluginListCommand,
  codexMarketplaceListCommand,
  readCodexState,
  codexPluginAdapters,
} from '../src/integrations/codex-plugins.mjs';

const MARKETPLACE = {
  id: 'cm-market-codex', label: 'context-mode marketplace', target: 'codex',
  type: 'marketplace', default: true, marketplace: 'mksglu/context-mode', name: 'context-mode',
};
const PLUGIN = {
  id: 'cm-codex', label: 'context-mode', target: 'codex',
  type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};

// Verified against the real CLI: `codex plugin --help` lists add/list/
// marketplace/remove and no `install`. Passing `install` exits 2 with
// "unrecognized subcommand", which is exactly how this shipped broken.
test('installing a Codex plugin uses `plugin add`, the subcommand that exists', () => {
  assert.deepEqual(codexPluginCommand(PLUGIN), {
    cmd: 'codex',
    args: ['plugin', 'add', 'context-mode@context-mode'],
  });
});

test('the plugin selector is passed as PLUGIN@MARKETPLACE in one argument', () => {
  const { args } = codexPluginCommand(PLUGIN);
  assert.equal(args[args.length - 1], 'context-mode@context-mode');
  assert.equal(args.length, 3, 'no --marketplace split: the selector already names both');
});

// This half was right all along and must stay right.
test('adding a Codex marketplace uses `plugin marketplace add`', () => {
  assert.deepEqual(codexMarketplaceCommand(MARKETPLACE), {
    cmd: 'codex',
    args: ['plugin', 'marketplace', 'add', 'mksglu/context-mode'],
  });
});

test('inspection reads Codex state through its own machine-readable output', () => {
  assert.deepEqual(codexPluginListCommand(), {
    cmd: 'codex',
    args: ['plugin', 'list', '--json'],
  });
  assert.deepEqual(codexMarketplaceListCommand(), {
    cmd: 'codex',
    args: ['plugin', 'marketplace', 'list', '--json'],
  });
});

// Shapes copied from the real CLI's output.
const PLUGIN_JSON = JSON.stringify({
  installed: [{ pluginId: 'context-mode@context-mode', name: 'context-mode', installed: true }],
  available: [],
});
const MARKETPLACE_JSON = JSON.stringify({
  marketplaces: [
    { name: 'context-mode', root: '/tmp/x', marketplaceSource: { sourceType: 'git', source: 'https://github.com/mksglu/context-mode.git' } },
    { name: 'openai-curated', root: '/tmp/y' },
  ],
});

function captureFor({ plugins = PLUGIN_JSON, marketplaces = MARKETPLACE_JSON, ok = true } = {}) {
  return async (command) => {
    const isMarketplace = command.args[1] === 'marketplace';
    return { ok, stdout: isMarketplace ? marketplaces : plugins };
  };
}

test('a plugin Codex reports as installed reads as installed', async () => {
  const state = await readCodexState({ capture: captureFor() });
  const adapters = codexPluginAdapters({ state });

  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'installed');
  assert.equal(adapters.marketplace.inspect(MARKETPLACE).state, 'installed');
});

// The bug this replaces: inspection read ~/.codex/plugins/*.json, which Codex
// never writes, so every item read as missing and every run re-added the
// marketplace and re-attempted the install.
test('a marketplace already configured is not offered for adding again', async () => {
  const state = await readCodexState({ capture: captureFor() });
  const adapters = codexPluginAdapters({ state });
  assert.equal(adapters.marketplace.inspect(MARKETPLACE).state, 'installed');
});

test('an absent plugin and an absent marketplace read as missing', async () => {
  const state = await readCodexState({
    capture: captureFor({
      plugins: JSON.stringify({ installed: [], available: [] }),
      marketplaces: JSON.stringify({ marketplaces: [] }),
    }),
  });
  const adapters = codexPluginAdapters({ state });

  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'missing');
  assert.equal(adapters.marketplace.inspect(MARKETPLACE).state, 'missing');
});

// The registered name is declared, not derived. Observed on a real machine:
// `mksglu/context-mode` registers as `context-mode` (the repo) while
// `thedotmack/claude-mem` registers as `thedotmack` (the owner) — no rule maps
// a source to a name, and guessing meant inspection never matched, so the
// marketplace was re-added on every single run.
test('the declared name is what matches, whatever shape the source takes', async () => {
  const state = await readCodexState({ capture: captureFor() });
  const adapters = codexPluginAdapters({ state });

  assert.equal(
    adapters.marketplace.inspect({ ...MARKETPLACE, marketplace: 'https://github.com/mksglu/context-mode.git' }).state,
    'installed',
    'the source shape is irrelevant; the declared name is what Codex recorded',
  );
});

test('a marketplace whose name is the owner rather than the repo still matches', async () => {
  const state = await readCodexState({
    capture: captureFor({ marketplaces: JSON.stringify({ marketplaces: [{ name: 'thedotmack' }] }) }),
  });
  const adapters = codexPluginAdapters({ state });

  const ownerNamed = { ...MARKETPLACE, marketplace: 'thedotmack/claude-mem', name: 'thedotmack' };
  assert.equal(adapters.marketplace.inspect(ownerNamed).state, 'installed');

  // The tail-of-source guess this replaced would have looked for `claude-mem`
  // and found nothing.
  const guessed = { ...MARKETPLACE, marketplace: 'thedotmack/claude-mem', name: 'claude-mem' };
  assert.equal(adapters.marketplace.inspect(guessed).state, 'missing');
});

// A machine without codex on PATH is a machine with no Codex plugins, not a
// crashed status run.
test('an unavailable codex CLI degrades to "nothing installed" rather than throwing', async () => {
  const state = await readCodexState({
    capture: async () => ({ ok: false, stdout: '', note: 'could not launch `codex`: ENOENT' }),
  });
  const adapters = codexPluginAdapters({ state });

  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'missing');
  assert.deepEqual(state.errors.length > 0, true, 'the failure is still recorded, not swallowed silently');
});

test('unparseable output degrades the same way', async () => {
  const state = await readCodexState({ capture: async () => ({ ok: true, stdout: 'not json' }) });
  const adapters = codexPluginAdapters({ state });
  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'missing');
  assert.ok(state.errors.length > 0);
});

test('installing spawns the codex CLI, never claude', async () => {
  const calls = [];
  const adapters = codexPluginAdapters({
    state: { plugins: new Set(), marketplaces: new Set(), errors: [] },
    spawn: async (command) => { calls.push(command); return { ok: true }; },
  });

  await adapters.marketplace.install(MARKETPLACE);
  await adapters.plugin.install(PLUGIN);

  assert.deepEqual(calls.map((c) => c.cmd), ['codex', 'codex']);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['plugin', 'marketplace'], ['plugin', 'add']]);
});

test('a launch failure is reported, not thrown', async () => {
  const adapters = codexPluginAdapters({
    state: { plugins: new Set(), marketplaces: new Set(), errors: [] },
    spawn: async () => ({ ok: false, note: 'could not launch `codex`: ENOENT' }),
  });

  const result = await adapters.plugin.install(PLUGIN);
  assert.equal(result.ok, false);
  assert.match(result.note, /codex/);
});

test('describe reports the exact command a run would make', () => {
  const adapters = codexPluginAdapters({ state: { plugins: new Set(), marketplaces: new Set(), errors: [] } });
  assert.equal(adapters.plugin.describe(PLUGIN), 'codex plugin add context-mode@context-mode');
  assert.equal(
    adapters.marketplace.describe(MARKETPLACE),
    'codex plugin marketplace add mksglu/context-mode',
  );
});
