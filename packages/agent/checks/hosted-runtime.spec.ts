import { execFileSync } from 'node:child_process';
import { followedSetupSourceLayer } from '@nortuscc/sync';
import { tempRepo } from '../../sync/checks/support/repo.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Layer, Deferred, Queue } from 'effect';
import { acquireApplyLock, nodeProcesses, Processes } from '@nortuscc/machine';
import { HostedFailure, HostedTransport, type HostedClient, type HostedState } from '@nortuscc/hosted-client';
import { AgentClock, configuredHostedRuntime, hostedCadence, hostedWait, makeHostedRuntime, makeSession, SetupSource, SetupsStore, startAgent } from '../src/index.ts';
import { agentMachine } from './support/agent-machine.ts';
import { setupFixture } from './support/setup-fixture.ts';

const empty: HostedState = { accountId: null, login: null, machineId: null, auth: 'signed-out', setups: [], machine: null, lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
const fakeClient = (calls: string[], failRecovery = false): HostedClient => ({
  registerSetup: () => Effect.die('Unexpected setup registration'),
  publishRevision: () => Effect.die('Unexpected publication'),
  listRevisions: () => Effect.succeed([]),
  publicSetup: () => Effect.die('Unexpected public setup read'),
  subscribe: () => Effect.void,
  unsubscribe: () => Effect.void,
  signInFlow: Effect.succeed(null),
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

for (const cancel of [false, true]) test(`device long retry wakes for expiry without early HTTP, cancellation ${cancel}`, async (t) => {
  const m = agentMachine(realpathSync(tmpdir())); const f = setupFixture(m.root);
  t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const startedAt = Date.parse('2026-10-07T00:00:00Z'); let now = startedAt; let polls = 0;
  const transport = Layer.succeed(HostedTransport, { request: (req) => {
    if (req.path === '/auth/device/start') return Effect.succeed({ status: 200, body: { pendingId: 'private', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 } });
    assert.equal(req.path, '/auth/device/poll'); polls++;
    return Effect.fail(new HostedFailure({ code: 'rate_limited', status: 429, retryAfter: Number.MAX_SAFE_INTEGER }));
  } });
  const clock = { now: Effect.sync(() => new Date(now)), random: Effect.succeed(0.5), sleep: () => Effect.never };
  await m.run(Effect.gen(function* () {
    const runtime = yield* configuredHostedRuntime(m.paths, { url: 'https://fake.example/v1', platform: 'darwin', transport, now: () => new Date(now),
      keychain: { read: () => Effect.succeed(undefined), write: () => Effect.die('unexpected credential write'), remove: () => Effect.void } }, { domains: () => m.domains, os: 'macos' }).pipe(Effect.provideService(AgentClock, clock));
    yield* runtime.signIn();
    now += 4999; assert.equal(yield* runtime.due, false); yield* runtime.tick; assert.equal(polls, 0);
    now++; yield* runtime.tick; assert.equal(polls, 1);
    assert.equal((yield* runtime.state).error, 'rate_limited');
    assert.equal(yield* runtime.wait, 60_000, 'long retry uses bounded timer chunks');
    if (cancel) yield* runtime.signOut();
    now += 5000; assert.equal(yield* runtime.due, false); yield* runtime.tick; assert.equal(polls, 1);
    now = startedAt + 119000;
    assert.equal(yield* runtime.wait, cancel ? 60_000 : 1000, 'active flow wakes at expiry before retry');
    now += 1000; assert.equal(yield* runtime.due, !cancel); yield* runtime.tick;
    assert.equal((yield* runtime.state).signingIn, false, 'expiry or cancellation always ends the flow');
    assert.equal((yield* runtime.state).error, cancel ? null : 'sign_in_expired');
    now += 2_147_484_000; assert.equal(yield* runtime.due, false); yield* runtime.tick;
    assert.equal(polls, 1, 'no transport poll after retry, expiry or cancellation');
  }), f.source);
});

test('runtime passes reporting intent only as local sign-in preference', async () => {
  const m = agentMachine(); const f = setupFixture(m.root); const calls: string[] = [];
  await m.run(Effect.scoped(Effect.gen(function* () {
    const client = { ...fakeClient(calls), startSignIn: (input: unknown, reporting?: boolean) => Effect.sync(() => {
      assert.deepEqual(input, { os: 'macos', agents: ['claude', 'codex'], name: 'My Mac' });
      assert.equal(reporting, false);
      return { userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 };
    }) };
    const runtime = yield* makeHostedRuntime(client, { domains: () => m.domains, os: 'macos' });
    const handle = yield* startAgent(() => m.domains, { hosted: runtime, deferStart: true });
    yield* handle.hosted!.signIn('My Mac', false);
  })), f.source);
});

test('a followed Git profile takes precedence over the CLI primary even if hosted recovery fails', async t => {
  const m = agentMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const f = setupFixture(m.root); await m.trust();
  m.write(join(m.paths.stateRoot, 'agent/followed.json'), JSON.stringify({ version: 1, followed: { repoUrl: 'https://github.com/example/followed.git', profile: 'default', setupId: null } }));
  await m.run(Effect.gen(function* () {
    const runtime = yield* makeHostedRuntime(fakeClient([], true), { domains: () => m.domains, os: 'macos' });
    const result = yield* runtime.runJobs;
    assert.equal(result.status.error, 'REVISION_UNAVAILABLE');
    assert.equal(result.inspection, undefined, 'the old CLI source must never apply');
  }).pipe(Effect.provide(Layer.succeed(Processes, { run: () => Effect.succeed({ code: 128, stdout: '', stderr: 'offline' }) }))), f.source);
});


test('a hosted follower inspects the last verified private snapshot during a service outage', async t => {
  const m = agentMachine(); t.after(() => rmSync(m.root, { recursive: true, force: true }));
  const repository = tempRepo({ 'claude/CLAUDE.md': '# announced\n' });
  t.after(() => rmSync(repository.root, { recursive: true, force: true }));
  const origin = join(repository.root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  repository.git('remote', 'add', 'origin', origin);
  repository.git('tag', 'v1'); repository.git('push', '-q', 'origin', 'main', 'v1');
  const repoUrl = 'https://github.com/example/followed.git';
  const followed = { repoUrl, profile: 'default', setupId: 'setup-1' };
  m.write(join(m.paths.stateRoot, 'agent/followed.json'), JSON.stringify({ version: 1, followed }));
  const revision = { setupId: 'setup-1', number: 1, commitSha: repository.first, tag: 'v1', changelog: '', requiredEnv: [], items: [{ id: 'file:claude:CLAUDE.md', kind: 'file' as const, change: 'added' as const }] };
  let offline = false;
  const processes = Layer.effect(Processes, Effect.gen(function* () {
    const real = yield* Processes;
    return { run: (command: Parameters<Processes['Service']['run']>[0]) => {
      assert.equal(command.cmd, 'git'); assert.notEqual(command.cwd, m.paths.repo);
      if (offline && command.args.includes('fetch')) return Effect.succeed({ code: 128, stdout: '', stderr: 'offline' });
      return real.run({ ...command, args: command.args.map(arg => arg === repoUrl && (command.args.includes('fetch') || command.args.includes('ls-remote')) ? origin : arg), stderr: 'capture' });
    } };
  })).pipe(Layer.provide(nodeProcesses()));
  await Effect.runPromise(SetupSource.use(source => source.load(revision)).pipe(Effect.provide(followedSetupSourceLayer(m.paths, followed, { processes, records: Effect.succeed([revision]) }))));
  repository.commit({ 'claude/CLAUDE.md': '# unannounced\n' }); repository.git('push', '-q', 'origin', 'main');
  offline = true;
  const fallback = setupFixture(m.root);
  const client: HostedClient = { ...fakeClient([], true),
    publicSetup: () => Effect.fail(new HostedFailure({ code: 'network' })),
    listRevisions: () => Effect.fail(new HostedFailure({ code: 'network' })),
  };
  await m.run(Effect.gen(function* () {
    const runtime = yield* makeHostedRuntime(client, { domains: () => m.domains, os: 'macos' });
    const result = yield* runtime.inspectPrimary;
    assert.equal(result.status.error, undefined);
    assert.deepEqual(result.inspection?.revision, revision);
    // Cached content remains usable while recovery is unavailable.
    const source = yield* SetupSource.pipe(Effect.provide(followedSetupSourceLayer(m.paths, followed, { processes })));
    const snapshot = yield* source.load(revision);
    assert.equal(readFileSync(join(snapshot.repo, 'claude/CLAUDE.md'), 'utf8'), '# announced\n');
  }).pipe(Effect.provide(processes)), fallback.source);
});
