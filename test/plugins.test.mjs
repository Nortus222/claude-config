import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  marketplaceCommand,
  pluginCommand,
  claudePluginAdapters,
} from '../src/integrations/claude-plugins.mjs';

const MARKETPLACE = {
  id: 'cm-market', label: 'context-mode marketplace', target: 'claude',
  type: 'marketplace', default: true, marketplace: 'mksglu/context-mode',
};
const PLUGIN = {
  id: 'cm', label: 'context-mode', target: 'claude',
  type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};

// An argument array, never a shell string: a marketplace or plugin name is
// third-party data, and interpolating it into a shell would make quoting the
// only thing standing between a manifest and arbitrary execution.
test('the supported commands are built as argv arrays, not shell strings', () => {
  assert.deepEqual(marketplaceCommand(MARKETPLACE), {
    cmd: 'claude',
    args: ['plugin', 'marketplace', 'add', 'mksglu/context-mode'],
  });
  assert.deepEqual(pluginCommand(PLUGIN), {
    cmd: 'claude',
    args: ['plugin', 'install', 'context-mode@context-mode'],
  });
});

function claudeHome() {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-claude-plugins-'));
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  return dir;
}

function writeState(dir, { installed = {}, marketplaces = {} } = {}) {
  writeFileSync(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: installed }));
  writeFileSync(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify(marketplaces));
}

function adaptersFor(dir, calls) {
  return claudePluginAdapters({
    claudeDir: () => dir,
    spawn: async (command) => {
      calls.push(command);
      return { ok: true };
    },
  });
}

test('inspection reads Claude\'s own installed-plugin and marketplace state', () => {
  const dir = claudeHome();
  writeState(dir, {
    installed: { 'context-mode@context-mode': {} },
    marketplaces: { 'context-mode': {} },
  });
  const adapters = adaptersFor(dir, []);

  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'installed');
  assert.equal(adapters.marketplace.inspect(MARKETPLACE).state, 'installed');
});

test('a plugin absent from Claude\'s state reads as missing', () => {
  const dir = claudeHome();
  writeState(dir, { installed: {}, marketplaces: {} });
  const adapters = adaptersFor(dir, []);

  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'missing');
  assert.equal(adapters.marketplace.inspect(MARKETPLACE).state, 'missing');
});

// A machine that has never run Claude has no plugin files at all. That is a
// bare machine, not a broken one, so inspection must report missing rather
// than throw and take the whole status run down.
test('missing or corrupt Claude state reads as missing rather than throwing', () => {
  const bare = mkdtempSync(join(tmpdir(), 'nortuscc-claude-bare-'));
  const adapters = adaptersFor(bare, []);
  assert.equal(adapters.plugin.inspect(PLUGIN).state, 'missing');

  const corrupt = claudeHome();
  writeFileSync(join(corrupt, 'plugins', 'installed_plugins.json'), '{ not json');
  assert.equal(adaptersFor(corrupt, []).plugin.inspect(PLUGIN).state, 'missing');
});

test('installing runs the supported command and reports the spawn result', async () => {
  const dir = claudeHome();
  writeState(dir);
  const calls = [];
  const adapters = adaptersFor(dir, calls);

  const result = await adapters.plugin.install(PLUGIN);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ cmd: 'claude', args: ['plugin', 'install', 'context-mode@context-mode'] }]);
});

// The child never launching at all (claude not on PATH) is silent otherwise:
// stdio inheritance has nothing to show when there is no child.
test('a launch failure names the unavailable native command', async () => {
  const dir = claudeHome();
  writeState(dir);
  const adapters = claudePluginAdapters({
    claudeDir: () => dir,
    spawn: async () => ({ ok: false, note: 'could not launch `claude`: ENOENT' }),
  });

  const result = await adapters.plugin.install(PLUGIN);
  assert.equal(result.ok, false);
  assert.match(result.note, /claude/);
});

test('describe reports the exact command a run would make', () => {
  const dir = claudeHome();
  writeState(dir);
  const adapters = adaptersFor(dir, []);
  assert.equal(adapters.marketplace.describe(MARKETPLACE), 'claude plugin marketplace add mksglu/context-mode');
});
