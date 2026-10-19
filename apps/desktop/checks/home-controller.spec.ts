import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeController, interruptedRuns, unannouncedRun, draftCount } from '../src/home-controller.ts';
import { fixture, run, flush, deferred } from './support/setup-sync.ts';
import { authorRun, draft, draftId } from './support/author.ts';

async function setup(t: test.TestContext) {
  const f = await fixture();
  f.handlers.drafts = () => ({ drafts: [draft] });
  const controller = new HomeController(f.bridge, f.machine);
  t.after(() => { controller.dispose(); f.machine.dispose(); });
  return { ...f, controller };
}
const named = (calls: { name: string; input: any }[], name: string) => calls.filter(call => call.name === name);

test('refresh reads machine runs and local drafts and never author profiles', async t => {
  const f = await setup(t);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' })], nextBefore: null });
  await f.controller.refresh();
  assert.deepEqual(named(f.calls, 'listRuns').map(call => call.input), [{ scope: { kind: 'machine' }, limit: 100 }]);
  assert.deepEqual(named(f.calls, 'drafts').map(call => call.input), [{ scope: { kind: 'machine' } }]);
  assert.equal(f.controller.state.runs?.length, 1);
  assert.equal(f.controller.state.drafts?.length, 1);
  assert.equal(f.calls.some(call => call.name === 'authorProfiles'), false);
});

test('a refresh during an in-flight read joins it and reads once more afterwards', async t => {
  const f = await setup(t);
  const gate = deferred<unknown>();
  f.handlers.listRuns = () => gate.promise;
  const first = f.controller.refresh();
  const second = f.controller.refresh();
  const third = f.controller.refresh();
  await flush();
  assert.equal(named(f.calls, 'listRuns').length, 1);
  f.handlers.listRuns = () => ({ runs: [], nextBefore: null });
  gate.resolve({ runs: [], nextBefore: null });
  await Promise.all([first, second, third]);
  assert.equal(named(f.calls, 'listRuns').length, 2);
  assert.equal(f.controller.state.pending, false);
});

test('an operation-run event refreshes Home', async t => {
  const f = await setup(t);
  await f.controller.refresh();
  f.emit({ version: 3, event: 'operation-run', runId: 'setup-run' }); await flush();
  assert.equal(named(f.calls, 'listRuns').length, 2);
});

test('results read before a session change are discarded', async t => {
  const f = await setup(t);
  const gate = deferred<unknown>();
  f.handlers.listRuns = () => gate.promise;
  const reading = f.controller.refresh(); await flush();
  await f.reconnect();
  gate.resolve({ runs: [run({ state: 'interrupted' })], nextBefore: null }); await reading;
  assert.equal(f.controller.state.runs, null);
  assert.equal(f.controller.state.pending, false);
});

test('a refused read shows one sentence without its error code', async t => {
  const f = await setup(t);
  f.handlers.listRuns = () => { throw new Error('UNAUTHORIZED: refused'); };
  await f.controller.refresh();
  assert.equal(f.controller.state.error, 'Refused. Check that your GitHub account can push to it, then try again.');
  assert.equal(f.controller.state.drafts?.length, 1);
});

test('Abandon asks first, then calls abandonRun for the confirmed run', async t => {
  const f = await setup(t);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' })], nextBefore: null });
  await f.controller.refresh();
  await f.controller.abandon();
  assert.equal(named(f.calls, 'abandonRun').length, 0);
  f.controller.confirmAbandon('setup-run');
  assert.equal(f.controller.state.confirming, 'setup-run');
  assert.equal(named(f.calls, 'abandonRun').length, 0);
  await f.controller.abandon();
  assert.deepEqual(named(f.calls, 'abandonRun').map(call => call.input), [{ scope: { kind: 'machine' }, runId: 'setup-run' }]);
  assert.equal(f.controller.state.confirming, null);
  assert.equal(interruptedRuns(f.controller.state.runs).length, 0);
});

test('Keep closes the confirmation without abandoning, and only interrupted runs can be confirmed', async t => {
  const f = await setup(t);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' }), run({ runId: 'done-run', state: 'succeeded' })], nextBefore: null });
  await f.controller.refresh();
  f.controller.confirmAbandon('done-run'); assert.equal(f.controller.state.confirming, null);
  f.controller.confirmAbandon('setup-run'); f.controller.cancelAbandon();
  await f.controller.abandon();
  assert.equal(named(f.calls, 'abandonRun').length, 0);
});

test('a confirmation ends when a refresh shows its run is no longer interrupted', async t => {
  const f = await setup(t);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' })], nextBefore: null });
  await f.controller.refresh(); f.controller.confirmAbandon('setup-run');
  f.handlers.listRuns = () => ({ runs: [run({ state: 'abandoned' })], nextBefore: null });
  await f.controller.refresh();
  assert.equal(f.controller.state.confirming, null);
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' }), run({ runId: 'other', state: 'interrupted' })], nextBefore: null });
  await f.controller.refresh(); f.controller.confirmAbandon('other');
  f.handlers.listRuns = () => ({ runs: [run({ state: 'interrupted' })], nextBefore: null });
  await f.controller.refresh();
  assert.equal(f.controller.state.confirming, null);
  f.controller.confirmAbandon('setup-run'); assert.equal(f.controller.state.confirming, 'setup-run');
});

test('derived lines: interrupted runs, unannounced publication and draft count', () => {
  const published = authorRun({ kind: 'publishDraft', draftId, digest: 'b'.repeat(64) }, { state: 'succeeded',
    publication: { commit: 'c'.repeat(40), pushed: true, tagged: true, announced: [], pending: ['team'] } });
  const announced = authorRun({ kind: 'announcePublication', runId: 'author-run' }, { runId: 'announce-run', state: 'succeeded',
    publication: { commit: 'c'.repeat(40), pushed: true, tagged: true, announced: ['team'], pending: [] } });
  assert.equal(unannouncedRun([published])?.runId, 'author-run');
  assert.equal(unannouncedRun([announced, published]), null);
  assert.equal(unannouncedRun(null), null);
  assert.deepEqual(interruptedRuns([run({ state: 'interrupted' }), run({ runId: 'x', state: 'abandoned' })]).map(r => r.runId), ['setup-run']);
  assert.equal(draftCount([draft, { ...draft, id: '00000000-0000-4000-8000-000000000002' }, { id: '00000000-0000-4000-8000-000000000003', error: 'Unreadable' }]), 2);
});
