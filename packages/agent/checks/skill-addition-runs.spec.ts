import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { makeAgentRuns, operationDigest } from '../src/runs.ts';
import { RunStore, type RunReceipt } from '../src/run-store.ts';
import { decodeRunView } from '../src/operations/index.ts';

const accepted = { source: 'owner/repo', acceptedRevision: 'a'.repeat(40), sourceDir: 'skills/review', selectorName: 'Review', installedName: 'review', blob: 'b'.repeat(40), tree: 'c'.repeat(40), internal: false, targets: ['codex'], declaration: { source: 'owner/repo', name: 'review', targets: ['codex'] }, policy: 'upstream' } as const;
const change = { kind: 'addSkill', candidateId: 'candidate', targets: ['codex'] } as const;
const view = () => decodeRunView({ runId: 'run', state: 'accepted', operation: 'applyChange', scope: { kind: 'machine' }, intent: { requestId: 'request', inputDigest: operationDigest('plan'), planId: 'plan', change, skillAddition: accepted }, intentSaved: false, intentState: 'pending', steps: [], result: null });

test('addition acceptance retains a bounded resolved tuple, not just a candidate cache ID', () => {
  assert.deepEqual(view().intent.skillAddition, accepted);
  assert.throws(() => decodeRunView({ ...view(), intent: { ...view().intent, skillAddition: { ...accepted, acceptedRevision: 'main' } } }));
  assert.throws(() => decodeRunView({ ...view(), intent: { ...view().intent, skillAddition: undefined } }));
});

test('restart preserves accepted addition and uncertain intent without installer replay', async () => {
  const writes: RunReceipt[] = [];
  const receipt: RunReceipt = { version: 1, sequence: 1, actor: 'mcp', inFlight: 'skill-intent:review', view: { ...view(), intentState: 'needsInspection' } };
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runs = yield* makeAgentRuns({ start: () => Effect.die('must not replay'), cancel: () => Effect.void });
    const recovered = yield* runs.get('run');
    assert.equal(recovered.intentSaved, false);
    assert.equal(recovered.intentState, 'needsInspection');
    assert.equal(recovered.installation?.state, 'needsInspection');
    assert.deepEqual(recovered.intent.skillAddition, accepted);
  })).pipe(Effect.provideService(RunStore, { read: Effect.succeed([receipt]), write: r => Effect.sync(() => { writes.push(r); }) })));
  assert.equal(writes.length, 1);
});
