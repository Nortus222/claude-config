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
