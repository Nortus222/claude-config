import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexMarketplaceCommand,
  codexPluginCommand,
  codexPluginAdapters,
} from '../src/integrations/codex-plugins.mjs';

const MARKETPLACE = {
  id: 'cm-market-codex', label: 'context-mode marketplace', target: 'codex',
  type: 'marketplace', default: true, marketplace: 'mksglu/context-mode',
};
const PLUGIN = {
  id: 'cm-codex', label: 'context-mode', target: 'codex',
  type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};

test('Codex plugin commands are argv arrays run through the codex CLI', () => {
  assert.deepEqual(codexMarketplaceCommand(MARKETPLACE), {
    cmd: 'codex',
    args: ['plugin', 'marketplace', 'add', 'mksglu/context-mode'],
  });
  assert.deepEqual(codexPluginCommand(PLUGIN), {
    cmd: 'codex',
    args: ['plugin', 'install', 'context-mode@context-mode'],
  });
});

// The Codex adapter must never reach into ~/.claude. Sharing Claude's plugin
// state would report context-mode as installed for Codex the moment Claude
// had it, and skip the Codex installation entirely.
test('inspection reads Codex\'s own directory, never Claude\'s', () => {
  const codex = mkdtempSync(join(tmpdir(), 'nortuscc-codex-plugins-'));
  mkdirSync(join(codex, 'plugins'), { recursive: true });
  writeFileSync(
    join(codex, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ plugins: { 'context-mode@context-mode': {} } }),
  );

  const adapters = codexPluginAdapters({ codexDir: () => codex, spawn: async () => ({ ok: true }) });
  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'installed');

  const empty = mkdtempSync(join(tmpdir(), 'nortuscc-codex-empty-'));
  const bare = codexPluginAdapters({ codexDir: () => empty, spawn: async () => ({ ok: true }) });
  assert.equal(bare.plugin.inspect(PLUGIN).state, 'missing');
});

test('installing a Codex plugin spawns the codex CLI, not claude', async () => {
  const codex = mkdtempSync(join(tmpdir(), 'nortuscc-codex-install-'));
  const calls = [];
  const adapters = codexPluginAdapters({
    codexDir: () => codex,
    spawn: async (command) => {
      calls.push(command);
      return { ok: true };
    },
  });

  await adapters.marketplace.install(MARKETPLACE);
  await adapters.plugin.install(PLUGIN);

  assert.deepEqual(calls.map((c) => c.cmd), ['codex', 'codex']);
  assert.deepEqual(calls.map((c) => c.args.slice(0, 3)), [
    ['plugin', 'marketplace', 'add'],
    ['plugin', 'install', 'context-mode@context-mode'],
  ]);
});

test('a Codex launch failure is reported, not thrown', async () => {
  const codex = mkdtempSync(join(tmpdir(), 'nortuscc-codex-fail-'));
  const adapters = codexPluginAdapters({
    codexDir: () => codex,
    spawn: async () => ({ ok: false, note: 'could not launch `codex`: ENOENT' }),
  });

  const result = await adapters.plugin.install(PLUGIN);
  assert.equal(result.ok, false);
  assert.match(result.note, /codex/);
});
