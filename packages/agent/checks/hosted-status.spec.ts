import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as agent from '../src/index.ts';
import type { Decision } from '@nortuscc/machine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';
const ids = ['setting:claude:settings.json#theme', 'integration:hook', 'file:claude:CLAUDE.md', 'skill:owner/repo/name', 'setting:claude:settings.json#model'];
const records: SyncRevision[] = [{ setupId: 'setup1', number: 1, commitSha: 'a'.repeat(40), tag: 'r1', changelog: '', requiredEnv: [], items: ids.map((id) => ({ id, kind: id.split(':')[0] as any, change: 'added' })) }];
const decisions: Decision[] = ids.slice(0, 4).map((itemId, i) => ({ setupId: 'setup1', itemId, revision: 1, commit: null, decision: i === 2 ? 'skip' : 'accept', source: 'local', machineId: null, decidedAt: '2026-10-07T00:00:00Z' }));

test('complete cumulative status distinguishes adoption, skips, inert auto work and person waiting', () => {
  assert.equal(typeof agent.projectHostedSetup, 'function');
  const status: agent.AgentStatus = { at: '', policy: 'auto-apply', paused: null, trusted: true, pending: [
    { key: 'x', itemId: ids[0]!, verdict: { kind: 'inert' } }, { key: 'y', itemId: ids[1]!, verdict: { kind: 'held', reason: 'integration' } },
  ], drift: [], conflicts: [], probeErrors: [] };
  const input = { records, decisions, observed: [ids[3]!], status, revisionApplied: 1 };
  assert.deepEqual(agent.projectHostedSetup(input), { setupId: 'setup1', revisionApplied: 1, adopted: [ids[3]], skipped: [ids[2]], pending: [ids[0]], waitingForPerson: [ids[1], ids[4]] });
  for (const next of [{ ...status, policy: 'manual' as const }, { ...status, policy: 'notify' as const }, { ...status, paused: { reason: 'failed', at: '' } }]) {
    const projected = agent.projectHostedSetup({ ...input, status: next });
    assert.deepEqual(projected.pending, []);
    assert.ok(projected.waitingForPerson.includes(ids[0]!));
  }
  const removed = [...records, { ...records[0]!, number: 2, items: [{ id: ids[3]!, kind: 'skill' as const, change: 'removed' as const }] }];
  const projected = agent.projectHostedSetup({ ...input, records: removed });
  assert.deepEqual(projected.adopted, []);
  assert.ok(projected.waitingForPerson.includes(ids[3]!));
});

test('positive observations require every row, readable probes and effective HEAD equality', async () => {
  const { Effect } = await import('effect');
  const { agentMachine } = await import('./support/agent-machine.ts');
  const { setupFixture, HEAD } = await import('./support/setup-fixture.ts');
  const m = agentMachine(); const f = setupFixture(m.root);
  await m.run(Effect.gen(function* () {
    const head = yield* f.service.load(HEAD);
    const config = { key: 'config:claude:settings.json#effortLevel', domain: 'config' as const, label: 'effort', group: 'claude', state: 'clean', disposition: 'in-sync' as const };
    const hook = { key: 'integration:hk', domain: 'integrations' as const, label: 'hook', group: 'claude', state: 'installed', disposition: 'in-sync' as const };
    const inspection = { paths: { ...m.paths, repo: head.repo }, revision: HEAD, desired: head.desired, report: { desired: head.desired, items: [config, hook], probeErrors: [] }, domains: [], trusted: true };
    const candidates = ['setting:claude:settings.json#effortLevel', 'integration:hk'];
    assert.deepEqual(yield* agent.observedHostedItems(inspection, head, candidates), [candidates[0]]);
    assert.deepEqual(yield* agent.observedHostedItems(inspection, head, candidates, candidates), [candidates[0]], 'even a successful hook step does not prove bytes');
    const pluginHead = { ...head, desired: { ...head.desired, integrations: head.desired.integrations.map((i) => ({ ...i, declaration: { ...i.declaration, type: 'plugin' } })) } };
    const pluginInspection = { ...inspection, desired: pluginHead.desired };
    assert.deepEqual(yield* agent.observedHostedItems(pluginInspection, pluginHead, ['integration:hk']), [], 'installed presence alone does not prove ownership');
    assert.deepEqual(yield* agent.observedHostedItems(pluginInspection, pluginHead, ['integration:hk'], ['integration:hk']), ['integration:hk'], 'selected successful operation plus matching fresh probe proves adoption');
    assert.deepEqual(yield* agent.observedHostedItems({ ...inspection, report: { ...inspection.report, probeErrors: ['private path: failed'] } }, head, candidates), []);
    assert.deepEqual(yield* agent.observedHostedItems({ ...inspection, report: { ...inspection.report, items: [config, { ...config, disposition: 'blocked' }] } }, head, candidates), []);
    const changed = { ...head, desired: { ...head.desired, files: head.desired.files.map((file) => file.id !== 'claude:settings.json' ? file : { ...file, keys: { ...file.keys, effortLevel: { ...file.keys!.effortLevel!, value: 'different' } } }) } };
    assert.deepEqual(yield* agent.observedHostedItems(inspection, changed, candidates), []);
  }), f.source);
});
