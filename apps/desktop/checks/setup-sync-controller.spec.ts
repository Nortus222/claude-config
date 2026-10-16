import test from 'node:test';
import assert from 'node:assert/strict';
import { SetupSyncController } from '../src/setup-sync-controller.ts';
import { fixture, review, run, flush, deferred, change } from './support/setup-sync.ts';

async function setup(t: test.TestContext) {
  const f = await fixture(); const controller = new SetupSyncController(f.bridge, f.machine);
  t.after(() => { controller.dispose(); f.machine.dispose(); });
  await controller.reload(); return { ...f, controller };
}
test('Refetch shows incoming rows and offers no Apply until a choice is made', async t => {
  const f = await setup(t); await f.controller.refetch();
  assert.equal(f.controller.state.review?.rows[0]?.after, 'new');
  assert.equal(f.controller.state.eligibility.apply, false);
  await f.controller.preview(); await f.controller.apply();
  assert.equal(f.calls.some(c => c.name === 'applyChange'), false);
  assert.equal(f.calls.filter(c => c.name === 'setupReview').at(-1)?.input.refetch, true);
});
test('Apply sends one setupApply with every staged choice', async t => {
  const f = await setup(t);
  f.controller.choose({ itemId: 'setting:a', action: 'accept' }); f.controller.choose({ itemId: 'setting:b', action: 'hold' });
  await f.controller.preview(); await f.controller.apply(); await f.controller.apply();
  assert.deepEqual(f.calls.find(c => c.name === 'previewChange')?.input.change, { ...change, choices: [{ itemId: 'setting:a', action: 'accept' }, { itemId: 'setting:b', action: 'hold' }] });
  assert.equal(f.calls.filter(c => c.name === 'applyChange').length, 1);
  assert.equal(f.controller.state.run?.state, 'running'); assert.equal(f.controller.state.preview, null);
});
test('a status for another run does not end this run\'s progress', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview(); await f.controller.apply();
  const reads = f.calls.filter(c => c.name === 'getRun').length;
  f.emit({ version: 3, event: 'status', runId: 'another', status: { ...f.machine.state.status!, applying: false } }); await flush();
  assert.equal(f.controller.state.run?.state, 'running'); assert.equal(f.calls.filter(c => c.name === 'getRun').length, reads);
  f.handlers.getRun = () => run({ state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } });
  f.emit({ version: 3, event: 'status', runId: 'setup-run', status: { ...f.machine.state.status!, applying: false } }); await flush();
  assert.equal(f.controller.state.run?.state, 'succeeded');
});
test('after reconnect the controller shows the run from getRun, not the old preview', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview(); await f.controller.apply();
  f.emit({ event: 'disconnected', detail: 'lost' });
  f.handlers.getRun = () => run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  await f.reconnect(); assert.equal(f.controller.state.run?.state, 'interrupted'); assert.equal(f.controller.state.preview, null);
  assert.equal(f.calls.filter(c => c.name === 'getRun').at(-1)?.input.runId, 'setup-run');
});
test('an interrupted run can be re-previewed and abandoned without replaying its request', async t => {
  const f = await setup(t); f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } })], nextBefore: null });
  f.handlers.getRun = () => run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  f.controller.enter(); await flush(); assert.equal(f.controller.state.run?.state, 'interrupted');
  await f.controller.repreview(); assert.deepEqual(f.calls.filter(c => c.name === 'previewChange').at(-1)?.input.change, change);
  assert.equal(f.calls.some(c => c.name === 'applyChange'), false);
  await f.controller.abandon(); assert.equal(f.controller.state.run?.state, 'abandoned'); assert.equal(f.controller.state.preview, null);
  assert.equal(f.controller.state.eligibility.refetch, true);
});
test('mixed pin-group refusal is shown next to the group', async t => {
  const f = await setup(t); f.handlers.setupReview = () => review({ pinGroups: [{ source: 'owner/repo', itemIds: ['setting:a', 'setting:b'] }] }); await f.controller.reload();
  f.controller.choose({ itemId: 'setting:a', action: 'accept' }); f.controller.choose({ itemId: 'setting:b', action: 'hold' });
  f.handlers.previewChange = () => { throw new Error('Choices for owner/repo must match: its items share one pin.'); };
  await f.controller.preview(); assert.match(f.controller.state.groupErrors['owner/repo'] ?? '', /must match/); assert.equal(f.controller.state.preview, null);
});
test('paging retains issued selections and a replacement review clears them', async t => {
  const f = await setup(t); f.handlers.setupReview = input => input.cursor ? review({ rows: [{ itemId: 'setting:c', kind: 'setting', change: 'unchanged', conflict: false, held: true }], nextCursor: null }) : review({ nextCursor: 'next' });
  await f.controller.reload(); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.page('next');
  f.controller.choose({ itemId: 'unknown', action: 'accept' }); f.controller.choose({ itemId: 'setting:c', action: 'release' });
  assert.deepEqual(f.controller.state.choices, [{ itemId: 'setting:a', action: 'accept' }, { itemId: 'setting:c', action: 'release' }]);
  await f.controller.reload(); assert.deepEqual(f.controller.state.choices, []);
});
test('late review replies after disconnect or disposal cannot restore a preview', async t => {
  const f = await setup(t); const pending = deferred<unknown>(); f.handlers.setupReview = () => pending.promise;
  const loading = f.controller.refetch(); f.emit({ event: 'disconnected', detail: 'lost' }); pending.resolve(review()); await loading;
  assert.equal(f.controller.state.review, null); assert.equal(f.controller.state.pending, false);
  await f.reconnect(); const next = deferred<unknown>(); f.handlers.setupReview = () => next.promise;
  const reload = f.controller.reload(); f.controller.dispose(); const state = f.controller.state; next.resolve(review()); await reload; assert.equal(f.controller.state, state);
});
test('a stale Apply requires another explicit preview and lost Apply is never repeated', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview();
  const freshPreview = { ...f.controller.state.preview!, planId: 'fresh' };
  f.handlers.applyChange = () => ({ status: 'stale', preview: freshPreview });
  await f.controller.apply(); assert.equal(f.controller.state.preview, null); assert.match(f.controller.state.message, /Preview again/); await f.controller.apply(); assert.equal(f.calls.filter(c => c.name === 'applyChange').length, 1);
  await f.controller.preview(); f.handlers.applyChange = () => { throw new Error('Reply lost'); }; await f.controller.apply(); await f.controller.apply();
  assert.equal(f.calls.filter(c => c.name === 'applyChange').length, 2); assert.match(f.controller.state.error ?? '', /Reply lost/);
});

test('reconnect recovery can prepare a fresh Apply without an earlier review', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview(); await f.controller.apply();
  f.emit({ event: 'disconnected', detail: 'lost' });
  f.handlers.getRun = () => run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } }); await f.reconnect();
  await f.controller.repreview(); assert.equal(f.controller.state.eligibility.apply, true);
  f.handlers.getRun = () => run({ runId: 'fresh-run' }); f.handlers.applyChange = () => ({ status: 'started', run: run({ runId: 'fresh-run' }) });
  await f.controller.apply();
  const requests = f.calls.filter(c => c.name === 'applyChange'); assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.input.requestId, requests[1]?.input.requestId); assert.notEqual(requests[1]?.input.requestId, 'request');
  assert.equal(f.controller.state.run?.runId, 'fresh-run');
});
test('cancel targets the current run and retains partial evidence', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview(); await f.controller.apply();
  f.handlers.cancelRun = () => run({ state: 'cancelled', result: { status: 'cancelled', remaining: ['setting:b'] } }); await f.controller.cancel();
  assert.equal(f.controller.state.run?.state, 'cancelled'); assert.deepEqual(f.controller.state.run?.parity?.backupIds, ['backup-1']);
  assert.deepEqual(f.calls.find(c => c.name === 'cancelRun')?.input, { scope: { kind: 'machine' }, runId: 'setup-run' });
});
test('an older run read cannot replace a newer terminal receipt', async t => {
  const f = await setup(t); f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview(); await f.controller.apply();
  const older = deferred<unknown>(); f.handlers.getRun = () => older.promise;
  f.emit({ version: 3, event: 'operation-run', runId: 'setup-run' });
  f.handlers.getRun = () => run({ state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } });
  f.emit({ version: 3, event: 'operation-run', runId: 'setup-run' }); await flush(); older.resolve(run()); await flush();
  assert.equal(f.controller.state.run?.state, 'succeeded');
});
test('an untrusted source is shown without offering choices or refetch', async t => {
  const f = await setup(t); f.handlers.inspectSetups = () => ({ generation: '1', items: [{ setupId: 'local', trusted: false, repository: '/repo', accountId: null }], nextCursor: null });
  await f.controller.reload(); assert.equal(f.controller.state.source?.trusted, false); assert.equal(f.controller.state.eligibility.choose, false); assert.equal(f.controller.state.eligibility.refetch, false);
});

test('selection is capped across pages and unselected earlier rows cannot be staged off-page', async t => {
  const f = await setup(t);
  f.handlers.setupReview = input => {
    const offset = input.cursor ? Number(input.cursor) : 0;
    return review({ rows: Array.from({ length: Math.min(100, 1001 - offset) }, (_, i) => ({ itemId: `item:${offset + i}`, kind: 'setting', change: 'changed', held: false, conflict: false })), nextCursor: offset < 1000 ? String(offset + 100) : null });
  };
  await f.controller.reload(); await f.controller.page('next'); f.controller.choose({ itemId: 'item:0', action: 'accept' }); assert.equal(f.controller.state.choices.length, 0);
  await f.controller.page('previous');
  for (let offset = 0; offset <= 1000; offset += 100) {
    if (offset) await f.controller.page('next');
    for (const row of f.controller.state.review!.rows) f.controller.choose({ itemId: row.itemId, action: 'accept' });
  }
  assert.equal(f.controller.state.choices.length, 1000); assert.equal(f.controller.state.choices.some(c => c.itemId === 'item:1000'), false);
});
test('disposed controllers cannot issue further agent operations', async t => {
  const f = await setup(t); f.controller.dispose(); const count = f.calls.length;
  await f.controller.reload(); await f.controller.refetch(); f.controller.enter(); await flush(); assert.equal(f.calls.length, count);
});

test('reload discovers an Apply whose reply was lost after an earlier completed run', async t => {
  const f = await setup(t); f.handlers.listRuns = () => ({ runs: [run({ runId: 'old', state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } })], nextBefore: null });
  f.handlers.getRun = () => run({ runId: 'old', state: 'succeeded', result: { status: 'done', ok: 1, failed: 0 } }); f.controller.enter(); await flush();
  f.controller.choose({ itemId: 'setting:a', action: 'accept' }); await f.controller.preview();
  f.handlers.applyChange = () => { throw new Error('Reply lost'); }; await f.controller.apply();
  f.handlers.listRuns = () => ({ runs: [run()], nextBefore: null }); f.handlers.getRun = () => run(); await f.controller.reload();
  assert.equal(f.controller.state.run?.runId, 'setup-run'); assert.equal(f.controller.state.run?.state, 'running');
  assert.equal(f.controller.state.preview, null); assert.equal(f.controller.state.eligibility.apply, false);
});

test('a read started during Abandon cannot replace its terminal receipt', async t => {
  const f = await setup(t); const interrupted = run({ state: 'interrupted', result: { status: 'interrupted', message: 'Restarted' } });
  f.handlers.listRuns = () => ({ runs: [interrupted], nextBefore: null }); f.handlers.getRun = () => interrupted; f.controller.enter(); await flush();
  const late = deferred<unknown>(); f.handlers.getRun = () => late.promise;
  f.handlers.abandonRun = () => { f.emit({ version: 3, event: 'operation-run', runId: 'setup-run' }); return run({ state: 'abandoned', result: { status: 'interrupted', message: 'Abandoned' } }); };
  await f.controller.abandon(); late.resolve(interrupted); await flush();
  assert.equal(f.controller.state.run?.state, 'abandoned');
});
