import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect, Layer, Deferred, Queue } from 'effect';
import { acquireApplyLock } from '@nortuscc/machine';
import { HostedFailure, type HostedClient, type HostedState } from '@nortuscc/hosted-client';
import { AgentClock, configuredHostedRuntime, hostedCadence, hostedWait, makeHostedRuntime, makeSession, SetupSource, SetupsStore, startAgent } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

const empty: HostedState = { accountId: null, login: null, machineId: null, auth: 'signed-out', setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
const fakeClient = (calls: string[], failRecovery = false): HostedClient => ({
  state: Effect.succeed(empty), revisions: () => Effect.succeed([]),
  recover: () => Effect.suspend(() => { calls.push('recover'); return failRecovery ? Effect.fail(new HostedFailure({ code: 'storage' })) : Effect.succeed(empty); }),
  sync: () => Effect.sync(() => { calls.push('sync'); return empty; }),
  startSignIn: () => Effect.sync(() => { calls.push('signIn'); return { userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 }; }),
  pollSignIn: () => Effect.sync(() => { calls.push('poll'); return { status: 'pending', pollAfter: 5 }; }),
  signOut: () => Effect.sync(() => { calls.push('signOut'); }),
  enqueueDecision: () => Effect.void, enqueueMachine: () => Effect.void, reportStatus: () => Effect.void,
});

test('runtime recovers without network before jobs and retains local inspection after recovery failure', async () => {
  for (const fail of [false, true]) {
    const m = agentMachine(); const f = setupFixture(m.root); const calls: string[] = [];
    await m.trust();
    const source = Layer.succeed(SetupSource, { ...f.service, current: Effect.sync(() => { calls.push('inspect'); }).pipe(Effect.andThen(f.service.current)),
      effective: (d) => Effect.sync(() => { calls.push('inspect'); }).pipe(Effect.andThen(f.service.effective(d))) });
    await m.run(Effect.gen(function* () {
      const runtime = yield* makeHostedRuntime(fakeClient(calls, fail), { domains: () => m.domains, os: 'macos' });
      const result = yield* runtime.runJobs;
      assert.equal(calls[0], 'recover'); assert.ok(calls.includes('inspect')); assert.ok(result.inspection);
      assert.equal((yield* runtime.state).recovered, !fail);
      assert.equal(calls.includes('sync'), false);
    }), source);
  }
});

test('hosted mutation refuses a held shared apply lock and invalidates a same-plan preview', async () => {
  const m = agentMachine(); const f = setupFixture(m.root); const calls: string[] = [];
  await m.trust();
  await m.run(Effect.scoped(Effect.gen(function* () {
    const runtime = yield* makeHostedRuntime(fakeClient(calls), { domains: () => m.domains, os: 'macos' });
    const handle = yield* startAgent(() => m.domains, { hosted: runtime, deferStart: true });
    const session = yield* makeSession(handle, { domains: () => m.domains, signal: new AbortController().signal });
    yield* session.inspect('app');
    const preview = yield* session.preview([]);
    yield* Effect.scoped(Effect.gen(function* () {
      yield* acquireApplyLock;
      const refused = yield* handle.hosted!.signOut().pipe(Effect.result);
      assert.equal(refused._tag, 'Failure'); assert.equal(calls.includes('signOut'), false);
    }));
    yield* handle.hosted!.signOut();
    const stale = yield* session.apply(preview.planId, 'app', () => {}).pipe(Effect.result);
    assert.equal(stale._tag, 'Failure');
    if (stale._tag === 'Failure') assert.equal(stale.failure.code, 'UNKNOWN_PLAN');
  })), f.source);
});

test('disabled signed-out construction does no HTTP or keychain and invalid configuration is visible', async () => {
  const m = agentMachine(); const f = setupFixture(m.root); let native = 0;
  await m.run(Effect.gen(function* () {
    const runtime = yield* configuredHostedRuntime(m.paths, { url: 'http://invalid/v1', platform: 'darwin', keychain: {
      read: () => Effect.sync(() => { native++; return undefined; }), write: () => Effect.sync(() => { native++; }), remove: () => Effect.sync(() => { native++; }),
    } }, { domains: () => m.domains, os: 'macos' });
    yield* runtime.runJobs;
    assert.equal(native, 0);
    assert.equal((yield* runtime.state).error, 'invalid_url');
  }), f.source);
});

test('far-future retry waits stay bounded and cadence honors plus/minus twenty percent', () => {
  assert.equal(hostedWait(Date.parse('9999-12-31T23:59:59Z'), Date.now()), 60_000);
  assert.equal(hostedCadence(900, 0), 720_000);
  assert.equal(hostedCadence(900, 1), 1_080_000);
});


test('an unavailable linked primary cannot become a local-source person apply', async () => {
  const m = agentMachine(); const f = setupFixture(m.root);
  await m.run(SetupsStore.use((s) => s.write([{ setupId: 'missing', accountId: 'account1', repoUrl: 'https://github.com/example/setup', checkout: m.paths.repo, trustedAt: '2026-10-07T00:00:00Z' }])));
  await m.run(Effect.gen(function* () {
    const client = { ...fakeClient([]), state: Effect.succeed({ ...empty, accountId: 'account1' }) };
    const runtime = yield* makeHostedRuntime(client, { domains: () => m.domains, os: 'macos' });
    assert.ok((yield* runtime.runJobs).inspection, 'local inspection remains available');
    const prepared = yield* runtime.inspectPrimary.pipe(Effect.result);
    assert.equal(prepared._tag, 'Failure', 'hosted preparation refuses missing offered identity');
  }), f.source);
});


test('device completion defers behind person apply and scheduler honors durable far-future backoff', async () => {
  const m = agentMachine(); const f = setupFixture(m.root); const calls: string[] = [];
  let now = Date.parse('2026-10-07T00:00:00Z');
  await m.run(Effect.scoped(Effect.gen(function* () {
    const wakes = yield* Queue.unbounded<void>();
    const slept = yield* Queue.unbounded<void>();
    const clock = { now: Effect.sync(() => new Date(now)), random: Effect.succeed(0.5), sleep: () => Queue.offer(slept, undefined).pipe(Effect.andThen(Queue.take(wakes)), Effect.asVoid) };
    const client = { ...fakeClient(calls), state: Effect.succeed({ ...empty, accountId: 'account1', auth: 'signed-in' as const, retryAt: '9999-12-31T23:59:59.999Z' }) };
    const runtime = yield* makeHostedRuntime(client, { domains: () => m.domains, os: 'macos' }).pipe(Effect.provideService(AgentClock, clock));
    const handle = yield* startAgent(() => m.domains, { hosted: runtime, deferStart: true }).pipe(Effect.provideService(AgentClock, clock));
    // Both the existing local timer and hosted loop are now asleep.
    yield* Queue.take(slept); yield* Queue.take(slept);
    yield* handle.hosted!.signIn();
    now += 5000;
    yield* Effect.scoped(Effect.gen(function* () {
      yield* acquireApplyLock;
      yield* Queue.offer(wakes, undefined); yield* Queue.offer(wakes, undefined);
      yield* Queue.take(slept); yield* Queue.take(slept);
      assert.equal(calls.includes('poll'), false, 'device completion does not mutate account during person apply');
    }));
    yield* Queue.offer(wakes, undefined); yield* Queue.offer(wakes, undefined);
    yield* Queue.take(slept); yield* Queue.take(slept);
    assert.equal(calls.filter((s) => s === 'poll').length, 1);
    assert.equal(calls.includes('sync'), false, 'far-future durable retry does not issue HTTP sync');
  })), f.source);
});
