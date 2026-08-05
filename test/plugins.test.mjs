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

// Finding 1: typeof null === 'object' crash — robustness tests
test('typeof null === "object" does not crash when plugins property is null', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': true } }, { plugins: null }, {});
  // Should degrade gracefully: null is not a valid dictionary, so treat as empty
  assert.deepEqual(r.missingPlugins, ['a@mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin install a@mkt')));
});

test('installed parameter as string does not crash', () => {
  const r = pluginReport({ enabledPlugins: { 'a@mkt': true } }, 'not-an-object', {});
  // Should degrade gracefully: string is not a valid dictionary, so treat as empty
  assert.deepEqual(r.missingPlugins, ['a@mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin install a@mkt')));
});

test('marketplaces parameter as null does not crash', () => {
  const r = pluginReport(
    { enabledPlugins: {}, extraKnownMarketplaces: { mkt: { source: 'owner/repo' } } },
    {},
    null,
  );
  // Should degrade gracefully
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
});

// Finding 2: Real nested structure from Claude Code
test('real Claude Code installed_plugins.json structure with nested plugins property', () => {
  const realStructure = {
    version: 2,
    plugins: {
      'superpowers@claude-plugins-official': [
        {
          scope: 'user',
          installPath: '/Users/user/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0',
          version: '6.2.0',
        },
      ],
      'context-mode@context-mode': [
        {
          scope: 'user',
          installPath: '/Users/user/.claude/plugins/cache/context-mode/context-mode/1.0.136',
          version: '1.0.136',
        },
      ],
    },
  };

  const r = pluginReport(
    {
      enabledPlugins: {
        'superpowers@claude-plugins-official': true,
        'context-mode@context-mode': true,
        'missing@mkt': true,
      },
    },
    realStructure,
    {},
  );

  assert.deepEqual(r.missingPlugins, ['missing@mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin install missing@mkt')));
});

// Finding 3: Source type handling
test('github source type with repo property is resolved', () => {
  const r = pluginReport(
    {
      enabledPlugins: {},
      extraKnownMarketplaces: {
        mkt: { source: { source: 'github', repo: 'owner/repo' } },
      },
    },
    {},
    {},
  );
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
  assert.ok(r.commands.some((c) => c.includes('claude plugin marketplace add owner/repo')));
});

test('git source type with url property is resolved', () => {
  const r = pluginReport(
    {
      enabledPlugins: {},
      extraKnownMarketplaces: {
        mkt: { source: { source: 'git', url: 'https://github.com/owner/repo.git' } },
      },
    },
    {},
    {},
  );
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
  assert.ok(
    r.commands.some((c) => c.includes('https://github.com/owner/repo.git')),
    'git source url is in commands',
  );
});

test('url source type with url property is resolved', () => {
  const r = pluginReport(
    {
      enabledPlugins: {},
      extraKnownMarketplaces: {
        mkt: { source: { source: 'url', url: 'https://example.com/plugins.json' } },
      },
    },
    {},
    {},
  );
  assert.deepEqual(r.missingMarketplaces, ['mkt']);
  assert.ok(
    r.commands.some((c) => c.includes('https://example.com/plugins.json')),
    'url source is in commands',
  );
});

test('unresolvable marketplace source emits comment instead of command', () => {
  const r = pluginReport(
    {
      enabledPlugins: {},
      extraKnownMarketplaces: {
        builtin: { source: { source: 'builtin' } },
        malformed: { source: { unknown: 'structure' } },
      },
    },
    {},
    {},
  );

  assert.deepEqual(r.missingMarketplaces, ['builtin', 'malformed']);
  // Commands should contain comments for these, not add commands
  const comments = r.commands.filter((c) => c.startsWith('#'));
  const adds = r.commands.filter((c) => c.includes('marketplace add'));

  assert.equal(adds.length, 0, 'no marketplace add commands for unresolvable sources');
  assert.equal(comments.length, 2, 'one comment for each unresolvable marketplace');
  assert.ok(
    comments.some((c) => c.includes('builtin')),
    'comment identifies builtin marketplace',
  );
  assert.ok(
    comments.some((c) => c.includes('malformed')),
    'comment identifies malformed marketplace',
  );
});
