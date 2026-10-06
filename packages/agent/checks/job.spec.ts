import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { canonical, DecisionsStore, hashText, HistoryStore } from '@nortuscc/machine';
import { AgentStateStore, runJob, type Policy } from '../src/index.ts';
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
  const job = () => m.run(runJob(m.domains), fixture.source);
  const settings = () => JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!);
  return { m, job, settings };
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

test('a paused auto-apply machine applies nothing but still records held items', async () => {
  const { m, job, settings } = await scenario({ policy: 'auto-apply', paused: true });
  const status = await job();
  assert.deepEqual(settings(), { theme: 'light' });
  assert.equal(status.autoApply, undefined);
  assert.equal(status.paused?.reason, 'test pause');
  assert.deepEqual(await m.kinds(), ['revision-verified', 'held']);
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

test('nothing applies from a setup this machine does not trust', async () => {
  const { job, settings } = await scenario({ policy: 'auto-apply', trusted: false });
  const status = await job();
  assert.equal(status.trusted, false);
  assert.deepEqual(status.pending, []);
  assert.deepEqual(settings(), { theme: 'light' });
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
