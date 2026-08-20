import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_MARKETPLACES,
  marketplaceOf,
  declaredIds,
  manifestDefects,
  OBSERVED_CATEGORIES,
  undeclared,
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

// Verified on a real machine: Codex self-registers this one and reserves the
// name, so it appeared as the single false positive on an otherwise clean
// report until it was exempted here.
test('the Codex built-in marketplace is exempt too', () => {
  assert.ok(BUILTIN_MARKETPLACES.has('openai-curated'));
  assert.ok(declaredIds([]).marketplaces.has('openai-curated'));

  const observed = { marketplaces: [{ key: 'openai-curated', label: 'openai-curated', note: '' }] };
  assert.deepEqual(undeclared({ observed, declared: declaredIds([]) }), []);
});
