import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AgentClock } from '../src/clock.ts';
import { SessionError } from '../src/ipc/session.ts';
import type { PreparedParityChange } from '../src/operations/parity.ts';
import { join } from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
import { acquireApplyLock, canonical, configDomain, DecisionsStore, FsFailed, HistoryStore, liveLockHolder } from '@nortuscc/machine';
import { makeSession, startAgent, type AgentDomain } from '../src/index.ts';
import { RunStore, RunStoreError, type RunReceipt } from '../src/run-store.ts';
import { makeAgentRuns, operationDigest } from '../src/runs.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, setupFixture } from './support/setup-fixture.ts';

// Captures agent.log diagnostics: each failed or interrupted run writes one line naming its cause.
const observeStderr = (t: import('node:test').TestContext) => {
  const diagnostics: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (...args: Parameters<typeof process.stderr.write>) => {
    const text = String(args[0]); diagnostics.push(text);
    return original(...args);
  });
  return diagnostics;
};

const request = (planId: string) => ({ planId, requestId: 'parity', inputDigest: operationDigest(planId), actor: 'mcp' as const });
const fixture = async (fail?: (receipt: RunReceipt) => boolean, historyFailure: boolean | ((event: import('@nortuscc/machine').HistoryInput) => boolean) = false) => {
  const m = agentMachine(); const source = setupFixture(join(m.root, 'setup'));
  m.write(join(m.paths.claude, 'settings.json'), '{"theme":"light"}');
  await m.trust(); await m.run(DecisionsStore.use(d => d.record(accept(EFFORT))));
  let effects = 0;
  const domain: AgentDomain = { ...configDomain, run: (step, report) => Effect.gen(function* () { effects++; return yield* configDomain.run(step, report); }) };
  const domains = () => [domain];
  const run = <A, E>(body: (session: import('../src/ipc/session.ts').AgentSession) => Effect.Effect<A, E>) => m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(domains, { deferStart: true });
    const store = yield* RunStore; const history = yield* HistoryStore;
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains }).pipe(
      Effect.provideService(RunStore, { ...store, write: r => fail?.(r) ? Effect.fail(new RunStoreError('receipt unavailable')) : store.write(r) }),
      Effect.provideService(HistoryStore, { ...history, append: e => (typeof historyFailure === 'function' ? historyFailure(e) : historyFailure && e.kind === 'apply-finished') ? Effect.fail(new FsFailed({ op: 'write', path: 'history', reason: 'unavailable' })) : history.append(e) }),
    );
    return yield* body(session);
  })), source.source);
  return { m, run, effects: () => effects };
};
const finish = (session: import('../src/ipc/session.ts').AgentSession, id: string) => Effect.callback<void>(resume => {
  const off = session.runs.subscribe(id, run => { if (run.result) resume(Effect.void); }); return Effect.sync(off);
});
const preview = (session: import('../src/ipc/session.ts').AgentSession) => Effect.gen(function* () {
  const inspected = yield* session.inspect('mcp');
  return yield* session.previewChange({ kind: 'reconcile', only: [inspected.items.find(i => i.domain === 'config' && i.disposition === 'apply')!.key] });
});

test('reconnect returns the accepted run', async () => {
  const f = await fixture();
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const accepted = yield* session.runs.submit(request(p.planId));
    assert.equal(accepted.intent.parity?.kind, 'reconcile');
    yield* finish(session, accepted.runId);
    const done = yield* session.runs.submit(request(p.planId));
    assert.equal(done.runId, accepted.runId); assert.equal(f.effects(), 1);
    assert.equal(done.parity?.state, 'committed'); assert.deepEqual(done.parity?.committedKeys, p.plan.steps.map(s => s.key));
    assert.deepEqual(done.parity?.remainingKeys, []); assert.equal(done.parity?.backupIds.length, 1);
    assert.equal((yield* Effect.flip(session.runs.submit(request('different')))).code, 'REQUEST_CONFLICT');
  }));
});

test('receipt failure prevents effects', async t => {
  const diagnostics = observeStderr(t);
  const f = await fixture(r => r.view.parity?.state === 'needsInspection');
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const accepted = yield* session.runs.submit(request(p.planId));
    yield* finish(session, accepted.runId);
    assert.equal(f.effects(), 0); assert.equal((yield* session.runs.get(accepted.runId)).state, 'interrupted');
  }));
  assert.equal(diagnostics.length, 1); assert.match(diagnostics[0]!, /^apply run [0-9a-f-]+ \(reconcile\) interrupted: Couldn't save the .*receipt unavailable.*\n$/);
});

test('observed committed evidence survives History failure', async () => {
  const f = await fixture(undefined, true);
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId)); yield* finish(session, run.runId);
    const done = yield* session.runs.get(run.runId);
    assert.equal(done.state, 'failed'); assert.equal(done.parity?.state, 'needsInspection');
    assert.equal(done.parity?.committedKeys.length, 1); assert.equal(done.parity?.backupIds.length, 1);
    assert.equal((yield* session.runs.submit(request(p.planId))).runId, run.runId); assert.equal(f.effects(), 1);
  }));
});

test('restart marks interrupted without replay', async () => {
  const f = await fixture(); let id = '';
  await f.run(session => Effect.gen(function* () { const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId)); id = run.runId; yield* finish(session, id); }));
  await f.m.run(RunStore.use(store => Effect.gen(function* () { const r = (yield* store.read)[0]!; yield* store.write({ ...r, view: { ...r.view, state: 'running', result: null } }); })));
  await f.run(session => Effect.gen(function* () {
    const run = yield* session.runs.get(id); assert.equal(run.state, 'interrupted'); assert.equal(run.parity?.state, 'needsInspection');
    assert.equal(run.parity?.committedKeys.length, 1); assert.equal(run.parity?.backupIds.length, 1);
    assert.equal((yield* session.runs.submit(request(run.intent.planId))).runId, id); assert.equal(f.effects(), 1);
  }));
});

test('public and durable mutations share one lock order', async () => {
  const m = agentMachine(); const source = setupFixture(join(m.root, 'setup'));
  await m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => [], { deferStart: true });
    assert.equal(typeof handle.withJobMutation, 'function');
    const held = Deferred.makeUnsafe<void>(); const release = Deferred.makeUnsafe<void>();
    const blocker = yield* Effect.forkChild(handle.exclusive(Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))));
    yield* Deferred.await(held);
    const publicMutation = yield* Effect.forkChild(handle.setPolicy('notify', 'mcp'));
    while (!liveLockHolder(join(m.paths.stateRoot, 'apply.lock'))) yield* Effect.yieldNow;
    // The public path holds apply.lock while waiting for the occupied job permit.
    const refused = yield* Effect.flip(Effect.scoped(acquireApplyLock)); assert.equal(refused._tag, 'LockHeld');
    yield* Deferred.succeed(release, undefined); yield* Fiber.join(blocker); yield* Fiber.join(publicMutation);
    const generation = yield* handle.generation!;
    yield* Effect.scoped(Effect.andThen(acquireApplyLock, handle.withJobMutation(handle.mutationBodies.setPolicy('manual', 'mcp'))));
    assert.equal(yield* handle.generation!, generation + 1);
    assert.equal(m.agentJson().policy, 'manual'); assert.equal(liveLockHolder(join(m.paths.stateRoot, 'apply.lock')), undefined);
  })), source.source);
});

test('prepared mutations checkpoint effects and schedule follow-up after release', async () => {
  const m = agentMachine(); const source = setupFixture(join(m.root, 'setup')); let effects = 0;
  await m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => [], { deferStart: true });
    const scheduled = Deferred.makeUnsafe<void>();
    const session = yield* makeSession({ ...handle, request: trigger => Effect.gen(function* () {
      assert.equal(liveLockHolder(join(m.paths.stateRoot, 'apply.lock')), undefined);
      yield* handle.exclusive(Effect.void); yield* Deferred.succeed(scheduled, undefined); return yield* handle.request(trigger);
    }) }, { signal: new AbortController().signal, domains: () => [] });
    const prepared = preparedChange('semantic', '0', lifecycle => Effect.gen(function* () {
      assert.ok(liveLockHolder(join(m.paths.stateRoot, 'apply.lock')));
      const run = yield* session.runs.get(lifecycle.runId); assert.equal(run.parity?.state, 'needsInspection');
      effects++;
      yield* lifecycle.progress({ type: 'started', index: 0, total: 1, step: { key: 'k', domain: 'intent', action: 'save-intent', summary: 'Save intent', touches: [], interruptible: false } });
      yield* lifecycle.parity({ kind: 'reconcile', state: 'committed', committedKeys: ['k'], remainingKeys: [], backupIds: ['backup'] });
      yield* lifecycle.progress({ type: 'finished', index: 0, total: 1, key: 'k', outcome: 'ok', note: 'Saved' });
    }).pipe(Effect.mapError(() => new SessionError('INTERNAL', 'Checkpoint failed'))));
    const p = yield* session.retainParityChange(prepared); const run = yield* session.runs.submit(request(p.planId));
    yield* finish(session, run.runId); yield* Deferred.await(scheduled);
    const done = yield* session.runs.get(run.runId); assert.equal(done.state, 'succeeded'); assert.equal(done.parity?.state, 'committed');
    assert.equal((yield* session.runs.submit(request(p.planId))).runId, run.runId); assert.equal(effects, 1);
  })), source.source);
  const events = await m.events(); assert.ok(events.some(e => e.kind === 'operation-checkpoint' && e.actor === 'mcp' && e.requestId === 'parity'));
});

const preparedChange = (planId: string, generation: string, execute: PreparedParityChange['execute'] = () => Effect.void): PreparedParityChange => {
  const plan = { kind: 'operation' as const, steps: [{ key: 'k', domain: 'intent' as const, action: 'save-intent' as const, summary: 'Save intent', touches: [], interruptible: false }], skipped: [] };
  return { preview: { planId, generation, plan, change: { kind: 'reconcile', only: ['k'] }, scope: { kind: 'machine' }, nextActions: [] },
    acceptance: { kind: 'reconcile', generation, baselineDigest: 'a'.repeat(64), planDigest: createHash('sha256').update(canonical(plan)).digest('hex'), plannedKeys: ['k'] }, revalidate: Effect.void, execute, afterRelease: 'inspect' };
};

test('prepared plans expire, evict, invalidate and refuse maintenance before acceptance', async () => {
  const m = agentMachine(); let time = 0; let effects = 0;
  await m.run(Effect.scoped(Effect.gen(function* () {
    const clock = yield* AgentClock;
    const handle = yield* startAgent(() => [], { deferStart: true });
    const session = yield* makeSession(handle, { signal: new AbortController().signal, domains: () => [] }).pipe(Effect.provideService(AgentClock, { ...clock, now: Effect.sync(() => new Date(time)) }));
    for (let n = 0; n < 33; n++) yield* session.retainParityChange(preparedChange(String(n), '0'));
    assert.equal((yield* Effect.flip(session.runs.submit(request('0')))).code, 'UNKNOWN_PLAN');
    time = 600_000;
    assert.equal((yield* Effect.flip(session.runs.submit(request('32')))).code, 'UNKNOWN_PLAN');
    yield* session.retainParityChange(preparedChange('stale', '0'));
    yield* Effect.scoped(Effect.andThen(acquireApplyLock, handle.withJobMutation(Effect.void)));
    assert.equal((yield* Effect.flip(session.runs.submit(request('stale')))).code, 'UNKNOWN_PLAN');
    yield* session.retainParityChange(preparedChange('maintenance', '1', () => Effect.sync(() => { effects++; })));
    m.write(join(m.paths.stateRoot, 'agent', 'pending-update.json'), '{}');
    assert.equal((yield* Effect.flip(session.runs.submit(request('maintenance')))).code, 'LOCKED');
    assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []); assert.equal(effects, 0);
  })));
});

for (const failure of ['receipt', 'history', 'both'] as const) test(`observed committed evidence survives ${failure} checkpoint failure`, async t => {
  const diagnostics = failure === 'history' ? undefined : observeStderr(t);
  const f = await fixture(failure !== 'history' ? r => (r.view.parity?.committedKeys.length ?? 0) > 0 : undefined,
    failure !== 'receipt' ? event => event.kind === 'operation-checkpoint' && event.committedKeys.length > 0 : false);
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId)); yield* finish(session, run.runId);
    const done = yield* session.runs.get(run.runId);
    assert.equal(done.state, failure === 'history' ? 'failed' : 'interrupted');
    assert.equal(done.parity?.state, 'needsInspection'); assert.equal(done.parity?.committedKeys.length, 1); assert.equal(done.parity?.backupIds.length, 1);
    assert.equal((yield* session.runs.submit(request(p.planId))).runId, run.runId); assert.equal(f.effects(), 1);
  }));
  if (diagnostics) { assert.equal(diagnostics.length, 1); assert.match(diagnostics[0]!, /^apply run [0-9a-f-]+ \(reconcile\) interrupted: Couldn't save the .*receipt unavailable.*\n$/); }
});

test('History pending checkpoint failure prevents physical effects', async () => {
  const f = await fixture(undefined, event => event.kind === 'operation-checkpoint' && event.state === 'needsInspection');
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId)); yield* finish(session, run.runId);
    assert.equal((yield* session.runs.get(run.runId)).state, 'failed'); assert.equal(f.effects(), 0);
  }));
});

test('invalid or oversized parity evidence never replaces the accepted snapshot', async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const runs = yield* makeAgentRuns({ cancel: () => Effect.void, start: (_input, lifecycle) => Effect.gen(function* () {
      const acceptance = { kind: 'reconcile' as const, generation: '0', baselineDigest: 'a'.repeat(64), planDigest: 'b'.repeat(64), plannedKeys: ['k'] };
      yield* lifecycle.accepted({ kind: 'reconcile', only: ['k'] }, ['k'], undefined, acceptance);
      for (const evidence of [
        { kind: 'reconcile' as const, state: 'committed' as const, committedKeys: [], remainingKeys: [], backupIds: [] },
        { kind: 'reconcile' as const, state: 'pending' as const, committedKeys: [], remainingKeys: ['k'], backupIds: Array.from({ length: 6000 }, (_, i) => String(i).padEnd(100, 'x')) },
      ]) {
        const outcome = yield* Effect.result(lifecycle.parity(evidence)); assert.equal(outcome._tag, 'Failure');
      }
      return { status: 'started' as const, runId: lifecycle.runId };
    }) });
    const run = yield* runs.submit(request('bounded')); assert.equal(run.parity?.state, 'pending'); assert.deepEqual(run.parity?.backupIds, []);
  })).pipe(Effect.provideService(RunStore, { read: Effect.succeed([]), write: () => Effect.void })));
});

test('a final History checkpoint failure retains uncertainty after observed completion', async () => {
  const f = await fixture(undefined, event => event.kind === 'operation-checkpoint' && event.state === 'committed');
  await f.run(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(request(p.planId)); yield* finish(session, run.runId);
    const done = yield* session.runs.get(run.runId); assert.equal(done.state, 'failed'); assert.equal(done.parity?.state, 'needsInspection');
    assert.equal(done.parity?.committedKeys.length, 1); assert.equal(done.parity?.backupIds.length, 1); assert.equal(f.effects(), 1);
  }));
});

test('prepared acceptance rechecks generation after waiting for the job permit', { timeout: 5000 }, async () => {
  const m = agentMachine(); let generation = 0; let validations = 0;
  await m.run(Effect.scoped(Effect.gen(function* () {
    const handle = yield* startAgent(() => [], { deferStart: true });
    const session = yield* makeSession({ ...handle, generation: Effect.sync(() => generation) }, { signal: new AbortController().signal, domains: () => [] });
    yield* session.retainParityChange({ ...preparedChange('generation', '0'), revalidate: Effect.sync(() => { validations++; }) });
    const held = Deferred.makeUnsafe<void>(); const release = Deferred.makeUnsafe<void>();
    const blocker = yield* Effect.forkChild(handle.exclusive(Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release))));
    yield* Deferred.await(held);
    const applying = yield* Effect.forkChild(Effect.result(session.runs.submit(request('generation'))));
    while (!liveLockHolder(join(m.paths.stateRoot, 'apply.lock'))) yield* Effect.yieldNow;
    generation++;
    yield* Deferred.succeed(release, undefined); yield* Fiber.join(blocker);
    const result = yield* Fiber.join(applying); assert.equal(result._tag, 'Failure');
    assert.equal(validations, 0); assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
  })));
});
