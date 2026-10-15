import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Deferred, Effect, Fiber } from 'effect';
import { configDomain, DecisionsStore } from '@nortuscc/machine';
import { makeSession, startAgent, type AgentDomain, type AgentServices, type AgentSession } from '../src/index.ts';
import { decodeRunView } from '../src/operations/index.ts';
import { operationDigest, RunError } from '../src/runs.ts';
import { RunStore, RunStoreError, type RunReceipt } from '../src/run-store.ts';
import { agentMachine } from './support/agent-machine.ts';
import { accept, EFFORT, setupFixture } from './support/setup-fixture.ts';

const fixture = async (options: { readonly failWrite?: (receipt: RunReceipt) => boolean; readonly note?: string; readonly summary?: () => string } = {}) => {
  const m = agentMachine();
  const source = setupFixture(join(m.root, 'setup'));
  await m.trust();
  await m.run(DecisionsStore.use(d => d.record(accept(EFFORT))));
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let calls = 0;
  const domain: AgentDomain = { ...configDomain,
    steps: (...args) => {
      const planned = configDomain.steps(...args);
      return options.summary ? { ...planned, steps: planned.steps.map(step => ({ ...step, summary: options.summary!() })) } : planned;
    },
    run: (step, report) => Effect.gen(function* () {
      calls++;
      if (calls === 1) { yield* Deferred.succeed(started, undefined); yield* Deferred.await(release); }
      const result = yield* configDomain.run(step, report);
      return options.note === undefined ? result : { ...result, note: options.note };
    }),
  };
  const domains = () => [domain];
  const within = <A, E>(body: (session: AgentSession) => Effect.Effect<A, E, AgentServices>) => m.run(Effect.scoped(Effect.gen(function* () {
    const agent = yield* startAgent(domains);
    const store = yield* RunStore;
    const session = yield* makeSession(agent, { signal: new AbortController().signal, domains }).pipe(Effect.provideService(RunStore, {
      ...store, write: receipt => options.failWrite?.(receipt) ? Effect.fail(new RunStoreError('receipt disk unavailable')) : store.write(receipt),
    }));
    return yield* body(session);
  })), source.source);
  return { m, within, started, release, calls: () => calls };
};
const inputFor = (planId: string) => ({ requestId: 'lost-reply', planId, inputDigest: operationDigest(planId), actor: 'mcp' as const });
const preview = (session: AgentSession) => Effect.gen(function* () {
  yield* session.inspect('app');
  return yield* session.preview([]);
});
const terminal = (session: AgentSession, runId: string) => Effect.callback<void>(resume => {
  const unsubscribe = session.runs.subscribe(runId, run => { if (run.result !== null) resume(Effect.void); });
  return Effect.sync(unsubscribe);
});

test('disconnect and a lost acceptance reply retain one run and one invocation per step', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const request = inputFor(planned.planId);
    // The client scope closes after acceptance, while the enclosing agent scope stays alive.
    const accepted = yield* Effect.scoped(session.runs.submit(request));
    assert.equal(accepted.intentSaved, false); assert.equal(accepted.actor, 'mcp');
    const unsubscribe = session.runs.subscribe(accepted.runId, () => { throw new Error('socket closed'); });
    unsubscribe();
    yield* Deferred.await(f.started);
    const retries = yield* Effect.all([session.runs.submit(request), session.runs.submit(request)], { concurrency: 'unbounded' });
    assert.ok(retries.every(retry => retry.runId === accepted.runId));
    assert.equal(f.calls(), 1);
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, accepted.runId);
    const done = yield* session.runs.get(accepted.runId);
    assert.equal(done.state, 'succeeded'); assert.equal(done.actor, 'mcp');
    assert.equal(f.calls(), planned.plan.steps.length);
    assert.equal(done.steps.length, planned.plan.steps.length);
    assert.equal((yield* session.runs.submit(request)).runId, accepted.runId);
    assert.equal((yield* session.runs.list({ limit: 10 })).runs[0]?.actor, 'mcp');
  }));
  const events = await f.m.events();
  assert.equal(events.find(e => e.kind === 'apply-started')?.actor, 'mcp');
});

test('request IDs are immutable and reject changed input or a forged digest', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const request = inputFor(planned.planId);
    const run = yield* session.runs.submit(request);
    const changed = yield* Effect.flip(session.runs.submit({ ...request, planId: 'different', inputDigest: operationDigest('different') }));
    assert.ok(changed instanceof RunError);
    assert.equal(changed.code, 'REQUEST_CONFLICT');
    const forged = yield* Effect.flip(session.runs.submit({ ...request, requestId: 'forged', inputDigest: 'a'.repeat(64) }));
    assert.equal(forged.code, 'INVALID_INPUT');
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, run.runId);
  }));
});

test('cancel waits for a noninterruptible step and records its commit before stopping', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    assert.ok(planned.plan.steps.length > 1);
    const run = yield* session.runs.submit(inputFor(planned.planId));
    yield* Deferred.await(f.started);
    const cancellation = yield* Effect.forkChild(session.runs.cancel(run.runId));
    yield* Effect.yieldNow;
    assert.equal(f.calls(), 1);
    yield* Deferred.succeed(f.release, undefined);
    const stopped = yield* Fiber.join(cancellation);
    assert.equal(stopped.state, 'cancelled');
    assert.equal(stopped.steps[0]?.outcome, 'ok');
    assert.equal(f.calls(), 1);
  }));
});

test('restart recovers an incomplete receipt without replaying an installer', async () => {
  const f = await fixture();
  let id = '';
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const run = yield* session.runs.submit(inputFor(planned.planId));
    id = run.runId;
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, id);
  }));
  const before = f.calls();
  // Model a process loss after a committed step but before its terminal receipt.
  await f.m.run(RunStore.use(store => Effect.gen(function* () {
    const receipt = (yield* store.read).find(r => r.view.runId === id)!;
    yield* store.write({ ...receipt, inFlight: receipt.view.steps[1]!.key,
      view: { ...receipt.view, state: 'running', steps: receipt.view.steps.slice(0, 1), result: null } });
  })));
  await f.within(session => Effect.gen(function* () {
    const recovered = yield* session.runs.get(id);
    assert.equal(recovered.state, 'interrupted');
    assert.equal(recovered.steps.length, 1);
    assert.ok(recovered.result?.status === 'interrupted' && recovered.result.message.includes('while applying'));
    assert.equal((yield* session.runs.submit(inputFor(recovered.intent.planId))).runId, id);
    assert.equal(f.calls(), before);
  }));
});

test('a failed commit checkpoint stops before the next installer and retains committed evidence', async () => {
  let failures = 0;
  const f = await fixture({ failWrite: receipt => receipt.view.steps.length === 1 && failures++ === 0 });
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const run = yield* session.runs.submit(inputFor(planned.planId));
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, run.runId);
    const stopped = yield* session.runs.get(run.runId);
    assert.equal(stopped.state, 'interrupted');
    assert.equal(stopped.steps[0]?.outcome, 'ok');
    assert.equal(f.calls(), 1);
    assert.equal((yield* session.runs.submit(inputFor(planned.planId))).runId, run.runId);
    assert.equal(f.calls(), 1);
  }));
});

test('failure to persist acceptance starts no installer and leaves no accepted receipt', async () => {
  const f = await fixture({ failWrite: () => true });
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const failed = yield* Effect.flip(session.runs.submit(inputFor(planned.planId)));
    assert.equal(failed.code, 'RUN_FAILED');
    assert.equal(f.calls(), 0);
    assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
    assert.equal(yield* session.running, false);
  }));
});

test('returned snapshots cannot mutate durable request ownership and receipt bindings reject replacement', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const request = inputFor(planned.planId);
    const run = yield* session.runs.submit(request);
    (run.intent as { planId: string }).planId = 'tampered';
    assert.equal((yield* session.runs.get(run.runId)).intent.planId, planned.planId);
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, run.runId);
    const store = yield* RunStore;
    const receipt = (yield* store.read)[0]!;
    const refused = yield* Effect.flip(store.write({ ...receipt, actor: 'cli' }));
    assert.ok(refused instanceof RunStoreError);
  }));
});

test('long step notes are bounded and every run snapshot satisfies the operation schema', async () => {
  const f = await fixture({ note: '😀'.repeat(900) });
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const run = yield* session.runs.submit(inputFor(planned.planId));
    decodeRunView(run);
    const seen: string[] = [];
    const invalid: unknown[] = [];
    const unsubscribe = session.runs.subscribe(run.runId, snapshot => {
      try { decodeRunView(snapshot); } catch (error) { invalid.push(error); }
      seen.push(snapshot.state);
    });
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, run.runId);
    unsubscribe();
    const done = decodeRunView(yield* session.runs.get(run.runId));
    assert.equal(done.steps[0]?.note, '😀'.repeat(500));
    assert.ok(seen.includes('running'));
    assert.ok(seen.includes('succeeded'));
    assert.deepEqual(invalid, []);
  }));
});

test('durable intent preserves an explicitly selected satisfied item even when it needs no physical step', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session);
    const first = yield* session.runs.submit(inputFor(planned.planId));
    yield* Deferred.succeed(f.release, undefined);
    yield* terminal(session, first.runId);
    yield* session.cancel;
    const inspected = yield* session.inspect('app');
    const key = inspected.items.find(item => item.domain === 'config')!.key;
    const satisfied = yield* session.previewChange({ kind: 'reconcile', only: [key, key] });
    assert.equal(satisfied.plan.steps.length, 0);
    const second = yield* session.runs.submit({ ...inputFor(satisfied.planId), requestId: 'satisfied' });
    assert.deepEqual(second.intent.change, { kind: 'reconcile', only: [key] });
    yield* terminal(session, second.runId);
    assert.equal((yield* session.runs.get(second.runId)).steps.length, 0);
  }));
});

test('stale replacements carry the session-owned normalized change and captured generation', async () => {
  let summary = 'before';
  const f = await fixture({ summary: () => summary });
  await f.within(session => Effect.gen(function* () {
    const inspected = yield* session.inspect('app');
    const only = inspected.items.map(item => item.key);
    const planned = yield* session.previewChange({ kind: 'reconcile', only: [...only, ...only] });
    assert.equal(planned.change.kind, 'reconcile');
    if (planned.change.kind === 'reconcile') assert.deepEqual(planned.change.only, only);
    assert.equal(planned.scope.kind, 'machine');
    assert.ok(planned.generation.length > 0);
    summary = 'after';
    const stale = yield* Effect.flip(session.runs.submit(inputFor(planned.planId)));
    assert.equal(stale.code, 'STALE_PLAN');
    assert.deepEqual(stale.preview?.change, planned.change);
    assert.equal(stale.preview?.generation, planned.generation);
    assert.notEqual(stale.preview?.planId, planned.planId);
    assert.equal(f.calls(), 0);
    assert.deepEqual((yield* session.runs.list({ limit: 10 })).runs, []);
  }));
});

test('an old unsubscribe cannot remove a newer subscriber set', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const planned = yield* preview(session); const run = yield* session.runs.submit(inputFor(planned.planId));
    const disposeA = session.runs.subscribe(run.runId, () => {}); disposeA();
    let terminalSeen = false;
    const disposeB = session.runs.subscribe(run.runId, view => { if (view.result) terminalSeen = true; });
    disposeA();
    yield* Deferred.succeed(f.release, undefined);
    while ((yield* session.runs.get(run.runId)).result === null) yield* Effect.sleep('1 millis');
    assert.equal(terminalSeen, true); disposeB();
  }));
});


for (const embedded of [undefined, 'app'] as const) test(`receipt owner supplies attribution after reconnect despite embedded actor ${embedded}`, async () => {
  const f = await fixture(); let id = '';
  await f.within(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(inputFor(p.planId)); id = run.runId;
    yield* Deferred.succeed(f.release, undefined); yield* terminal(session, id);
  }));
  await f.m.run(RunStore.use(store => Effect.gen(function* () {
    const receipt = (yield* store.read)[0]!;
    const { actor: _actor, ...legacy } = receipt.view;
    yield* store.write({ ...receipt, view: embedded ? { ...legacy, actor: embedded } : legacy });
  })));
  await f.within(session => Effect.gen(function* () {
    assert.equal((yield* session.runs.get(id)).actor, 'mcp');
    assert.equal((yield* session.runs.list({ limit: 1 })).runs[0]?.actor, 'mcp');
    assert.equal((yield* session.runs.cancel(id)).actor, 'mcp');
    let observed: string | undefined; const off = session.runs.subscribe(id, run => { observed = run.actor; }); off();
    assert.equal(observed, 'mcp');
    const read = yield* session.runs.get(id);
    assert.equal((yield* session.runs.submit(inputFor(read.intent.planId))).actor, 'mcp');
  }));
});

test('persisted parity acceptance cannot replace its baseline or planned keys', async () => {
  const f = await fixture();
  await f.within(session => Effect.gen(function* () {
    const p = yield* preview(session); const run = yield* session.runs.submit(inputFor(p.planId));
    yield* Deferred.succeed(f.release, undefined); yield* terminal(session, run.runId);
    const store = yield* RunStore; const receipt = (yield* store.read)[0]!;
    assert.ok(receipt.view.intent.parity);
    for (const change of [{ baselineDigest: 'f'.repeat(64) }, { plannedKeys: [] }]) {
      const changed = decodeRunView({ ...receipt.view, intent: { ...receipt.view.intent, parity: { ...receipt.view.intent.parity, ...change } } });
      assert.ok((yield* Effect.flip(store.write({ ...receipt, view: changed }))) instanceof RunStoreError);
    }
  }));
});
