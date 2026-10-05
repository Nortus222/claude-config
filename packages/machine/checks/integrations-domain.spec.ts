import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { backupsForRun, execute, machinePaths, nodeFs, nodeProcesses, plan, Processes, selectAll, type MachineReport, type Progress, type Selection } from '../src/index.ts';
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

test('the package root exports the integrations domain', async () => {
  const root = await import('../src/index.ts');
  assert.equal(typeof root.integrationsDomain, 'function');
  assert.ok(typeof root.readCodexState === 'object' || Effect.isEffect(root.readCodexState));
  assert.equal(typeof root.userScopeInstalls, 'function');
});
