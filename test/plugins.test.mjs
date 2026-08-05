import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginReport } from '../src/plugins.mjs';

test('nothing missing when everything is installed', () => {
  const r = pluginReport(
    { enabledPlugins: { 'a@mkt': true }, extraKnownMarketplaces: { mkt: { source: 'x/y' } } },
    { 'a@mkt': {} },
    { mkt: {} },
  );
  assert.deepEqual(r.missingPlugins, []);
  assert.deepEqual(r.missingMarketplaces, []);
  assert.deepEqual(r.commands, []);
});

test('an uninstalled plugin is reported with an install command', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': true } }, {}, { mkt: {} });
  assert.deepEqual(r.missingPlugins, ['a@mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin install a@mkt')));
});

test('a disabled plugin is not reported as missing', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': false } }, {}, { mkt: {} });
  assert.deepEqual(r.missingPlugins, []);
});

test('an unknown marketplace is reported with an add command', () => {
  const r = pluginReport(
    { enabledPlugins: {}, extraKnownMarketplaces: { mkt: { source: 'owner/repo' } } },
    {},
    {},
  );
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin marketplace add owner/repo')));
});

test('missing sections default to empty rather than throwing', () => {
  const r = pluginReport({}, {}, {});
  assert.deepEqual(r.missingPlugins, []);
  assert.deepEqual(r.missingMarketplaces, []);
});
