import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, configDomain, DecisionsStore, hashText, HistoryStore, integrationsDomain, type MachinePathsValue } from '@nortuscc/machine';
import { AgentStateStore, runJob, SetupsStore, type AgentDomains, type Policy } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, HEAD, HOOK, setupFixture, type FixtureOptions } from './support/setup-fixture.ts';

const THEME_KEY = 'config:claude:settings.json#theme';
const EFFORT_KEY = 'config:claude:settings.json#effortLevel';

type Scenario = {
  readonly policy: Policy;
  readonly paused?: boolean;
  readonly trusted?: boolean;
  readonly decide?: boolean;
  readonly fixture?: FixtureOptions;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly domains?: AgentDomains;
};

// A trusted machine with `theme: light` locally, the given policy, and both head items accepted.
const scenario = async (options: Scenario) => {
  const m = agentMachine();
  const fixture = setupFixture(join(m.root, 'setup'), options.fixture);
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify(options.settings ?? { theme: 'light' }) + '\n');
  if (options.trusted !== false) await m.trust();
  await m.run(AgentStateStore.use((s) => s.update((state) => ({
    ...state,
    policy: options.policy,
    policySource: 'person',
    paused: options.paused ? { reason: 'test pause', at: '2026-10-06T00:00:00.000Z' } : null,
  }))));
  if (options.decide !== false) {
    for (const itemId of [EFFORT, HOOK]) await m.run(DecisionsStore.use((d) => d.record(accept(itemId))));
  }
  const run = () => m.run(runJob(options.domains ?? (() => m.domains)), fixture.source);
  const job = () => run().then((r) => r.status);
  const settings = () => JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!);
  return { m, run, job, settings, fixture };
};

test('auto-apply applies the accepted inert key, holds the hook, and only reports drift', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply' });
  const status = await job();
  assert.deepEqual(settings(), { theme: 'light', effortLevel: 'high' });
  assert.equal(status.autoApply?.kind, 'ran');
  assert.deepEqual(status.drift, [THEME_KEY]);
  assert.deepEqual(status.pending.map((p) => [p.itemId, p.verdict.kind]), [[EFFORT, 'inert'], [HOOK, 'held']]);
  assert.deepEqual(await m.kinds(), ['revision-verified', 'held', 'apply-started', 'apply-finished']);
  const [held] = (await m.events()).filter((e) => e.kind === 'held');
  assert.ok(held?.kind === 'held');
  assert.deepEqual(held.items, [{ itemId: HOOK, reason: 'integration' }]);
});

// Builds the agent's domains from each job's paths, as `agent run` does, and records those paths.
const recording = () => {
  const seen: Array<MachinePathsValue> = [];
  const domains: AgentDomains = (paths) => {
    seen.push(paths);
    return [configDomain, integrationsDomain({ paths, env: {} })];
  };
  return { seen, domains };
};

test('a trusted job builds its domains from paths at the effective snapshot, and keeps its inspection', async () => {
  const factory = recording();
  const { m, run, fixture } = await scenario({ policy: 'auto-apply', domains: factory.domains });
  const { status, inspection } = await run();
  const atSnapshot = { ...m.paths, repo: fixture.dirs[HEAD] };
  assert.equal(status.autoApply?.kind, 'ran');
  assert.ok(factory.seen.length > 0);
  for (const paths of factory.seen) assert.deepEqual(paths, atSnapshot);
  assert.deepEqual(inspection?.paths, atSnapshot);
  assert.equal(inspection?.trusted, true);
  assert.equal(inspection?.desired, inspection?.report.desired);
  assert.ok(inspection?.report.items.some((i) => i.key === EFFORT_KEY));
});

test('an untrusted job builds its domains from paths at the checkout HEAD snapshot', async () => {
  const factory = recording();
  const { m, run, fixture } = await scenario({ policy: 'auto-apply', trusted: false, domains: factory.domains });
  const { inspection } = await run();
  assert.deepEqual(factory.seen, [{ ...m.paths, repo: fixture.dirs[HEAD] }]);
  assert.equal(inspection?.trusted, false);
});

test('a job that cannot resolve a configuration keeps no inspection', async () => {
  const { run } = await scenario({ policy: 'auto-apply', fixture: { unavailable: ['effective'] } });
  assert.equal((await run()).inspection, undefined);
});

test('notify records ready and held once, and applies nothing', async () => {
  const { m, job, settings } = await scenario({ policy: 'notify' });
  await job();
  await job();
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), ['revision-verified', 'held', 'ready']);
  const [ready] = (await m.events()).filter((e) => e.kind === 'ready');
  assert.ok(ready?.kind === 'ready');
  assert.deepEqual(ready.items, [{ itemId: EFFORT, reason: 'inert' }]);
});

test('manual shows pending items in status only', async () => {
  const { m, job, settings } = await scenario({ policy: 'manual' });
  const status = await job();
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), ['revision-verified']);
  assert.deepEqual(status.pending.map((p) => p.itemId), [EFFORT, HOOK]);
  assert.deepEqual(status.drift, [THEME_KEY]);
});

test('a paused auto-apply machine applies nothing and records its items as a notify machine would', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', paused: true });
  const status = await job();
  assert.deepEqual(settings(), { theme: 'light' });
  assert.equal(status.autoApply, undefined);
  assert.equal(status.paused?.reason, 'test pause');
  assert.deepEqual(await m.kinds(), ['revision-verified', 'held', 'ready']);
  const [ready] = (await m.events()).filter((e) => e.kind === 'ready');
  assert.ok(ready?.kind === 'ready');
  assert.deepEqual(ready.items, [{ itemId: EFFORT, reason: 'inert' }]);
});

test('an invalid profile makes the job inspect-only and report PROFILE_INVALID', async () => {
  const { m, job, settings } = await scenario({
    policy: 'auto-apply',
    fixture: { headFiles: { 'integrations.json': JSON.stringify({ version: 1, integrations: [{ id: 'hk' }] }) } },
  });
  const status = await job();
  assert.equal(status.error, 'PROFILE_INVALID');
  assert.deepEqual(status.pending, []);
  assert.ok(status.drift.includes(EFFORT_KEY));
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), ['revision-verified']);
});

test('a rejected revision is recorded once and its decisions are not used', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', fixture: { rejectHead: true } });
  await job();
  const status = await job();
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
  const events = await m.events();
  assert.deepEqual(events.map((e) => e.kind), ['revision-rejected']);
  assert.ok(events[0]?.kind === 'revision-rejected');
  assert.equal(events[0].revision, HEAD);
  assert.equal(events[0].error, 'RevisionMismatch');
});

test('an untrusted checkout is inspected for drift at its HEAD, and nothing is fetched, verified or applied', async () => {
  const { m, job, settings, fixture } = await scenario({ policy: 'auto-apply', trusted: false });
  const status = await job();
  assert.equal(status.trusted, false);
  assert.equal(status.error, undefined);
  assert.deepEqual(status.pending, []);
  assert.ok(status.drift.includes(THEME_KEY));
  assert.ok(status.drift.includes(EFFORT_KEY));
  assert.deepEqual(fixture.calls, ['current']);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), []);
});

test('an own entry for another checkout trusts nothing here', async () => {
  const { m, job, fixture } = await scenario({ policy: 'auto-apply', trusted: false });
  await m.run(SetupsStore.use((s) => s.write([{ setupId: null, repoUrl: null, checkout: join(m.root, 'elsewhere'), trustedAt: '2026-10-06T00:00:00.000Z' }])));
  const status = await job();
  assert.equal(status.trusted, false);
  assert.ok(status.drift.includes(THEME_KEY));
  assert.deepEqual(fixture.calls, ['current']);
  assert.deepEqual(await m.kinds(), []);
});

test('an untrusted checkout whose HEAD cannot be read reports REVISION_UNAVAILABLE', async () => {
  const { m, job } = await scenario({ policy: 'auto-apply', trusted: false, fixture: { unavailable: ['current'] } });
  const status = await job();
  assert.equal(status.trusted, false);
  assert.equal(status.error, 'REVISION_UNAVAILABLE');
  assert.deepEqual(status.drift, []);
  assert.deepEqual(await m.kinds(), []);
});

test('an interrupted run pauses once and stops auto-apply', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply' });
  await m.run(HistoryStore.use((h) => h.append({ kind: 'apply-started', actor: 'agent', runId: 'crashed', automatic: true, keys: [EFFORT_KEY] })));
  const status = await job();
  await job();
  assert.equal(status.paused?.runId, 'crashed');
  assert.equal(status.autoApply, undefined);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.equal((await m.kinds()).filter((k) => k === 'paused').length, 1);
});

test('a corrupt decisions.json applies nothing and is left alone', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', decide: false });
  const path = join(m.paths.stateRoot, 'decisions.json');
  m.write(path, '{ not json');
  const status = await job();
  assert.equal(status.error, 'DECISIONS_INVALID');
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.equal(m.read(path), '{ not json');
});

test('a key changed on both sides is not auto-applied', async () => {
  // Applied earlier as "medium", since edited here to "low"; the accepted revision says "high".
  const { m, job, settings } = await scenario({ policy: 'auto-apply', settings: { theme: 'light', effortLevel: 'low' } });
  m.write(join(m.paths.stateRoot, 'state.json'), JSON.stringify({
    version: 1, repo: null,
    files: { 'claude:settings.json#effortLevel': { hash: hashText(canonical('medium')), appliedAt: '2026-10-01T00:00:00.000Z' } },
  }));
  const status = await job();
  assert.equal(settings().effortLevel, 'low');
  assert.equal(status.autoApply, undefined);
  assert.ok(!status.pending.some((p) => p.itemId === EFFORT));
});

test('a key this machine already holds, with no baseline, is not auto-applied', async () => {
  // Hand-set to "low" and never applied by nortuscc; the accepted revision says "high".
  const { m, job, settings } = await scenario({ policy: 'auto-apply', settings: { theme: 'dark', effortLevel: 'low' } });
  const status = await job();
  assert.deepEqual(settings(), { theme: 'dark', effortLevel: 'low' });
  assert.equal(status.autoApply, undefined);
  assert.ok(!status.pending.some((p) => p.itemId === EFFORT));
  assert.ok(status.drift.includes(EFFORT_KEY));
  assert.ok(!(await m.kinds()).includes('apply-started'));
});

test('an item set that clears and recurs is recorded again', async () => {
  const { m, job } = await scenario({ policy: 'notify' });
  await job();
  // The machine catches up, as an apply would leave it: nothing is ready, and the ready batch is reset.
  const statePath = join(m.paths.stateRoot, 'state.json');
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', effortLevel: 'high' }) + '\n');
  m.write(statePath, JSON.stringify({
    version: 1, repo: null,
    files: { 'claude:settings.json#effortLevel': { hash: hashText(canonical('high')), appliedAt: '2026-10-06T00:00:00.000Z' } },
  }));
  assert.deepEqual((await job()).pending.map((p) => p.itemId), [HOOK]);
  await job();
  // The same item falls behind again.
  rmSync(statePath);
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light' }) + '\n');
  await job();
  const ready = (await m.events()).flatMap((e) => (e.kind === 'ready' ? [e.items.map((i) => i.itemId)] : []));
  assert.deepEqual(ready, [[EFFORT], [], [EFFORT]]);
  assert.equal((await m.kinds()).filter((k) => k === 'held').length, 1);
});

test('an unreachable fetch verifies nothing and applies nothing', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', fixture: { unavailable: ['fetch'] } });
  const status = await job();
  assert.equal(status.error, undefined);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), []);
});

test('a revision that cannot be loaded records nothing and is verified by a later job', async () => {
  const { m, job, settings, fixture } = await scenario({ policy: 'auto-apply', fixture: { unavailable: ['load'] } });
  const status = await job();
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), []);
  fixture.unavailable.delete('load');
  await job();
  assert.deepEqual(await m.kinds(), ['revision-verified', 'held', 'apply-started', 'apply-finished']);
  assert.deepEqual(settings(), { theme: 'light', effortLevel: 'high' });
});

test('an unavailable effective configuration reports REVISION_UNAVAILABLE and applies nothing', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', fixture: { unavailable: ['effective'] } });
  const status = await job();
  assert.equal(status.error, 'REVISION_UNAVAILABLE');
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), ['revision-verified']);
});

test('an inspect-only job records revision verdicts but no batches, and applies nothing', async () => {
  const { m, fixture, settings } = await scenario({ policy: 'auto-apply' });
  const { status, inspection } = await m.run(runJob(() => m.domains, { inspectOnly: true }), fixture.source);
  assert.equal(status.autoApply, undefined);
  assert.deepEqual(settings(), { theme: 'light' });
  assert.deepEqual(await m.kinds(), ['revision-verified']);
  assert.equal(inspection?.revision, HEAD);
  assert.ok(inspection?.report.items.some((i) => i.key === EFFORT_KEY));
});
