import { test } from 'node:test';
import assert from 'node:assert/strict';

import { integrationPlan, runIntegrations, TYPE_ORDER, categoryOf } from '../src/integrations/runner.mjs';

const MARKETPLACE = {
  id: 'cm-market', label: 'context-mode marketplace', target: 'claude',
  type: 'marketplace', default: true, marketplace: 'mksglu/context-mode',
};
const PLUGIN = {
  id: 'cm', label: 'context-mode', target: 'claude',
  type: 'plugin', default: true, plugin: 'context-mode@context-mode',
};
const MCP = {
  id: 'srv', label: 'srv', target: 'codex', type: 'mcp', default: true, command: 'srv',
};
const HOOK = {
  id: 'hk', label: 'hk', target: 'claude', type: 'hook', default: true,
  event: 'SessionStart', file: 'claude/hooks/h.mjs',
};

// A recorder standing in for every adapter: it reports everything missing and
// logs the argv each install would have run, which is what the ordering
// assertions read.
function adaptersWithRecorder(calls, { fail = null, installed = [] } = {}) {
  const make = (cmd) => ({
    inspect: (item) =>
      installed.includes(item.id)
        ? { state: 'installed', note: 'already installed' }
        : { state: 'missing', note: '' },
    describe: (item) => `${cmd} ${argvFor(item).join(' ')}`,
    install: async (item) => {
      if (fail === item.id) return { ok: false, note: 'installer failed' };
      calls.push({ cmd, args: argvFor(item) });
      return { ok: true, note: '' };
    },
  });
  return { hook: make('claude'), marketplace: make('claude'), plugin: make('claude'), mcp: make('codex') };
}

function argvFor(item) {
  switch (item.type) {
    case 'marketplace': return ['plugin', 'marketplace', 'add', item.marketplace];
    case 'plugin': return ['plugin', 'install', item.plugin];
    case 'mcp': return ['mcp', 'add', item.id, item.command];
    default: return ['hook', item.event, item.file];
  }
}

test('Claude plugin installs marketplace before plugin', async () => {
  const calls = [];
  const plan = integrationPlan({
    // Deliberately out of order: the runner's ordering, not the manifest's, is
    // what must put the marketplace first.
    integrations: [PLUGIN, MARKETPLACE],
    target: 'claude',
    adapters: adaptersWithRecorder([]),
  });
  const result = await runIntegrations(plan, adaptersWithRecorder(calls));

  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['plugin', 'marketplace', 'add'],
    ['plugin', 'install', 'context-mode@context-mode'],
  ]);
  assert.ok(result.every((item) => item.ok));
});

test('the full type order is hook, marketplace, plugin, mcp', () => {
  assert.deepEqual(TYPE_ORDER, ['hook', 'marketplace', 'plugin', 'mcp']);

  const plan = integrationPlan({
    integrations: [MCP, PLUGIN, HOOK, MARKETPLACE],
    target: 'all',
    adapters: adaptersWithRecorder([]),
  });
  assert.deepEqual(plan.map((p) => p.type), ['hook', 'marketplace', 'plugin', 'mcp']);
});

// Two entries of the same type keep the order the manifest gave them, so a
// manifest author can express a dependency the type order cannot.
test('manifest order is preserved within a type', () => {
  const first = { ...PLUGIN, id: 'first', plugin: 'a@m' };
  const second = { ...PLUGIN, id: 'second', plugin: 'b@m' };
  const plan = integrationPlan({
    integrations: [first, second],
    target: 'claude',
    adapters: adaptersWithRecorder([]),
  });
  assert.deepEqual(plan.map((p) => p.id), ['first', 'second']);
});

// Grouped by the agent that owns the work. Typed alone, a Codex marketplace
// landed under "Claude plugins" and the two agents' context-mode rows were
// indistinguishable in the picker — the user could not tell which agent a row
// would act on.
test('groups name the agent that owns the work, not just the declaration type', () => {
  const codexMarketplace = { ...MARKETPLACE, id: 'cm-codex', target: 'codex' };
  const plan = integrationPlan({
    integrations: [MARKETPLACE, codexMarketplace, PLUGIN, MCP, HOOK],
    target: 'all',
    adapters: adaptersWithRecorder([]),
  });

  const groupOf = (id) => plan.find((p) => p.id === id).group;
  assert.equal(groupOf('cm-market'), 'Claude plugins');
  assert.equal(groupOf('cm-codex'), 'Codex plugins', 'a Codex marketplace is not a Claude plugin');
  assert.equal(groupOf('cm'), 'Claude plugins');
  assert.equal(groupOf('srv'), 'Codex MCP');
  assert.equal(groupOf('hk'), 'Claude hooks');
});

// Two agents can declare the same upstream integration. If the rows are
// distinguishable only by group, the group has to be part of what the user
// reads — otherwise the picker shows two identical lines.
test('the same integration on two agents lands in two different groups', () => {
  const plan = integrationPlan({
    integrations: [PLUGIN, { ...PLUGIN, id: 'cm-codex', target: 'codex' }],
    target: 'all',
    adapters: adaptersWithRecorder([]),
  });
  const groups = plan.map((p) => p.group);
  assert.deepEqual(groups, ['Claude plugins', 'Codex plugins']);
  assert.equal(new Set(groups).size, 2, 'identical labels must still be told apart by group');
});

test('a plan for one target excludes the other agent entirely', () => {
  const plan = integrationPlan({
    integrations: [PLUGIN, MCP],
    target: 'codex',
    adapters: adaptersWithRecorder([]),
  });
  assert.deepEqual(plan.map((p) => p.id), ['srv']);
});

test('category opt-outs remove whole groups from the plan', () => {
  const all = [HOOK, MARKETPLACE, PLUGIN, MCP];
  const adapters = adaptersWithRecorder([]);

  const noPlugins = integrationPlan({ integrations: all, target: 'all', disabled: new Set(['plugins']), adapters });
  assert.deepEqual(noPlugins.map((p) => p.id), ['hk', 'srv']);

  const noMcp = integrationPlan({ integrations: all, target: 'all', disabled: new Set(['mcp']), adapters });
  assert.deepEqual(noMcp.map((p) => p.id), ['hk', 'cm-market', 'cm']);

  const noHooks = integrationPlan({ integrations: all, target: 'all', disabled: new Set(['hooks']), adapters });
  assert.deepEqual(noHooks.map((p) => p.id), ['cm-market', 'cm', 'srv']);
});

// A marketplace is machinery for installing plugins, so --no-plugins has to
// drop it too. Leaving it behind would add a marketplace for plugins the user
// just declined.
test('a marketplace belongs to the plugins category', () => {
  assert.equal(categoryOf('marketplace'), 'plugins');
  assert.equal(categoryOf('plugin'), 'plugins');
  assert.equal(categoryOf('hook'), 'hooks');
  assert.equal(categoryOf('mcp'), 'mcp');
});

test('an already-installed item is planned as satisfied and never reinstalled', async () => {
  const calls = [];
  const plan = integrationPlan({
    integrations: [MARKETPLACE, PLUGIN],
    target: 'claude',
    adapters: adaptersWithRecorder([], { installed: ['cm-market'] }),
  });
  assert.deepEqual(plan.map((p) => p.state), ['installed', 'missing']);

  const results = await runIntegrations(plan, adaptersWithRecorder(calls, { installed: ['cm-market'] }));
  assert.deepEqual(calls.map((c) => c.args[1]), ['install'], 'the satisfied marketplace must not be re-added');
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.find((r) => r.id === 'cm-market').skipped, true);
});

// One failing installer must not take the rest of the run with it: the design
// calls for per-item failures with unrelated selected items continuing.
test('a failed install is recorded and the remaining items still run', async () => {
  const calls = [];
  const plan = integrationPlan({
    integrations: [MARKETPLACE, PLUGIN, MCP],
    target: 'all',
    adapters: adaptersWithRecorder([]),
  });
  const results = await runIntegrations(plan, adaptersWithRecorder(calls, { fail: 'cm-market' }));

  const failed = results.find((r) => r.id === 'cm-market');
  assert.equal(failed.ok, false);
  assert.match(failed.note, /failed/i);
  assert.deepEqual(results.filter((r) => r.id !== 'cm-market').map((r) => r.ok), [true, true]);
});

// An adapter that throws is a bug, not a plan: it must be caught into the same
// per-item result shape rather than aborting every later item.
test('an adapter that throws becomes a failed result, not an aborted run', async () => {
  const plan = integrationPlan({
    integrations: [MARKETPLACE, PLUGIN],
    target: 'claude',
    adapters: adaptersWithRecorder([]),
  });
  const adapters = adaptersWithRecorder([]);
  const exploding = {
    ...adapters,
    marketplace: {
      ...adapters.marketplace,
      install: async () => { throw new Error('boom'); },
    },
  };

  const results = await runIntegrations(plan, exploding);
  assert.equal(results[0].ok, false);
  assert.match(results[0].note, /boom/);
  assert.equal(results[1].ok, true, 'the plugin must still be attempted');
});

test('an empty plan runs nothing and returns nothing', async () => {
  const calls = [];
  const results = await runIntegrations([], adaptersWithRecorder(calls));
  assert.deepEqual(results, []);
  assert.deepEqual(calls, []);
});
