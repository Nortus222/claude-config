import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { loadProfile, nodeFiles, type DesiredConfig } from '@nortuscc/profile-engine';
import { backupsForRun, inspect, type MachineReport, type Observed, type StepAction } from '@nortuscc/machine';
import { autoApply, type AgentDomain, type AutoApplyOutcome } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';

type Machine = ReturnType<typeof agentMachine>;
const STAMP = new Date('2026-10-06T12:00:00.000Z');
const EMPTY: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };
const item = (key: string, domain: Observed['domain'] = 'config'): Observed =>
  ({ key, domain, label: key, group: 'g', state: 's', disposition: 'apply' });
const reportOf = (...items: Observed[]): MachineReport => ({ desired: EMPTY, items, probeErrors: [] });

// Plans one `action` step per selected item and answers each run with `ok`.
const fakeDomain = (name: AgentDomain['name'], action: StepAction, ok = true): AgentDomain => ({
  name,
  inspect: () => Effect.succeed({ items: [], probeErrors: [] }),
  steps: (items) => ({
    steps: items.map((i) => ({ key: i.key, domain: name, action, summary: i.key, touches: [], interruptible: false })),
    skipped: [],
  }),
  run: () => Effect.succeed({ ok, note: ok ? 'written' : 'disk full' }),
});

const applyWith = (
  m: Machine, report: MachineReport, keys: ReadonlyArray<string>, domains: ReadonlyArray<AgentDomain>, signal?: AbortSignal,
): Promise<AutoApplyOutcome> =>
  m.run(autoApply(report, keys, domains, { signal }).pipe(Effect.provide(backupsForRun(STAMP))));

test('an inert settings key is applied under the lock, bracketed by History, with a backup', async () => {
  const m = agentMachine();
  m.write(join(m.paths.repo, 'claude', 'settings.keys.json'), JSON.stringify({ effortLevel: 'high' }));
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light' }) + '\n');
  const report = await m.run(Effect.gen(function* () {
    const desired = yield* loadProfile(m.paths.repo).pipe(Effect.provide(nodeFiles), Effect.orDie);
    return yield* inspect(desired, m.domains).pipe(Effect.provide(backupsForRun(STAMP)));
  }));

  const outcome = await applyWith(m, report, ['config:claude:settings.json#effortLevel'], m.domains);

  assert.ok(outcome.kind === 'ran');
  assert.equal(outcome.result, 'done');
  assert.equal(outcome.failed, 0);
  assert.equal(outcome.backup, join(m.paths.backups, 'nortuscc-2026-10-06T12-00-00-000Z'));
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'light', effortLevel: 'high' });
  assert.equal(m.read(join(outcome.backup!, 'claude', 'settings.json')), JSON.stringify({ theme: 'light' }) + '\n');
  assert.deepEqual(await m.kinds(), ['apply-started', 'apply-finished']);
  assert.equal(m.agentJson().paused ?? null, null);
  assert.equal(existsSync(join(m.paths.stateRoot, 'apply.lock')), false);
});

for (const action of ['install-skills', 'update-skills', 'install-integration', 'remove', 'restore'] as const) {
  test(`a plan with a ${action} step is refused and pauses auto-apply`, async () => {
    const m = agentMachine();
    const outcome = await applyWith(m, reportOf(item('skill:tdd', 'skills')), ['skill:tdd'], [fakeDomain('skills', action)]);
    assert.deepEqual(outcome, { kind: 'refused', step: 'skill:tdd', action });
    assert.deepEqual(await m.kinds(), ['paused']);
    assert.match(m.agentJson().paused.reason, new RegExp(action));
  });
}

test('a failed step pauses auto-apply, naming the run', async () => {
  const m = agentMachine();
  const outcome = await applyWith(m, reportOf(item('config:a')), ['config:a'], [fakeDomain('config', 'write-file', false)]);
  assert.ok(outcome.kind === 'ran');
  assert.equal(outcome.failed, 1);
  assert.deepEqual(await m.kinds(), ['apply-started', 'apply-finished', 'paused']);
  assert.equal(m.agentJson().paused.runId, outcome.runId);
});

test('a cancelled run is recorded and does not pause', async () => {
  const m = agentMachine();
  const controller = new AbortController();
  controller.abort();
  const outcome = await applyWith(m, reportOf(item('config:a')), ['config:a'], [fakeDomain('config', 'write-file')], controller.signal);
  assert.ok(outcome.kind === 'ran');
  assert.equal(outcome.result, 'cancelled');
  assert.deepEqual(await m.kinds(), ['apply-started', 'apply-finished']);
  assert.equal(m.agentJson().paused ?? null, null);
});

test('a held apply.lock skips the run without pausing or recording anything', async () => {
  const m = agentMachine();
  mkdirSync(m.paths.stateRoot, { recursive: true });
  writeFileSync(join(m.paths.stateRoot, 'apply.lock'), JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
  const outcome = await applyWith(m, reportOf(item('config:a')), ['config:a'], [fakeDomain('config', 'write-file')]);
  assert.deepEqual(outcome, { kind: 'lock-held' });
  assert.deepEqual(await m.kinds(), []);
  assert.equal(m.agentJson().paused ?? null, null);
});

test('nothing to do runs nothing', async () => {
  const m = agentMachine();
  const outcome = await applyWith(m, reportOf(item('config:a')), ['config:other'], [fakeDomain('config', 'write-file')]);
  assert.deepEqual(outcome, { kind: 'nothing' });
  assert.deepEqual(await m.kinds(), []);
});
