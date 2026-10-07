import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { DecisionsStore, decisionsStore, Fs, FsFailed, HistoryStore, historyStore, machinePaths, nodeFs, type Decision } from '@nortuscc/machine';
import { jsonByteLength, MAX_REQUEST_BODY_BYTES, type SyncResponse, type SyncedDecision } from '@nortuscc/hosted-protocol';
import { HostedFailure, HostedStore, HostedTransport, MachineTokenStore, hostedStore, makeHostedClient, type HostedRequest, type HostedResponse } from '../src/index.ts';

const revision = (number: number, setupId = 'setup1') => ({ setupId, number, commitSha: number.toString(16).padStart(40, '0'),
  tag: `r${number}`, changelog: '', items: [{ id: 'file:claude/CLAUDE.md', kind: 'file' as const, change: 'changed' as const }], requiredEnv: [] });
const delta = (over: Partial<SyncResponse> = {}): SyncResponse => ({ seq: 1, decisions: [], revisions: [revision(1)],
  machine: { policy: 'notify', reportStatus: true }, setups: [{ setupId: 'setup1', name: 'Setup', repoUrl: 'https://github.com/a/b', latestRevision: 1 }], pollAfter: 900, ...over });
const local = (over: Partial<Decision> = {}): Decision => ({ setupId: 'setup1', itemId: 'file:claude/CLAUDE.md', revision: 1, commit: null,
  decision: 'accept', decidedAt: '2026-10-07T01:00:00Z', machineId: 'machine1', source: 'local', ...over });
const synced = (over: Partial<SyncedDecision> = {}): SyncedDecision => ({ setupId: 'setup1', itemId: 'file:claude/CLAUDE.md', revision: 1,
  decision: 'skip', decidedAt: '2020-01-01T00:00:00Z', machineId: 'other', ...over });

const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot: join(root, 'state'), backups: join(root, 'backups') };
  let clock = Date.parse('2026-10-07T00:00:00Z');
  let token: string | undefined;
  let removeFailure = false;
  let account = 'account1';
  let policy: 'auto-apply' | 'notify' | 'manual' = 'notify';
  let policySource: 'person' | 'default' = 'default';
  let response = delta();
  const requests: HostedRequest[] = [];
  const actions: Array<(req: HostedRequest) => Effect.Effect<HostedResponse, HostedFailure>> = [];
  const baseFs = await Effect.runPromise(Fs.pipe(Effect.provide(nodeFs)));
  let crash = false;
  let failSuffix: string | undefined;
  const fs = Layer.succeed(Fs, { ...baseFs, writeTextAtomic: (path, text) => ((crash && path.endsWith('/agent/sync.json')) || (failSuffix !== undefined && path.endsWith(failSuffix)))
    ? Effect.fail(new FsFailed({ op: 'write', path, reason: 'injected crash' })) : baseFs.writeTextAtomic(path, text) });
  const stores = Layer.mergeAll(hostedStore, decisionsStore, historyStore(() => new Date(clock))).pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), fs)));
  const transport = Layer.succeed(HostedTransport, { request: (req) => {
    requests.push(req);
    if (actions.length) return actions.shift()!(req);
    if (req.path === '/auth/device/start') return Effect.succeed({ status: 200, body: { pendingId: 'pending', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 120 } });
    if (req.path === '/auth/device/poll') return Effect.succeed({ status: 200, body: { accountId: account, login: 'ihor', machineId: 'machine1', token: `nmt_${account}_machine1_${'s'.repeat(43)}`, defaultPolicy: 'auto-apply' } });
    if (req.path.startsWith('/sync?')) return Effect.succeed({ status: 200, body: response, etag: 'etag1' });
    if (req.path === '/decisions') return Effect.succeed({ status: 200, body: { seq: 100, results: (req.body as { decisions: Decision[] }).decisions.map((d) => ({ setupId: d.setupId, itemId: d.itemId, outcome: 'stored' })) } });
    if (req.method === 'PATCH') return Effect.succeed({ status: 200, body: { machineId: 'machine1', name: 'Mac', os: 'macos', agents: ['claude'], policy: (req.body as any).policy ?? policy, reportStatus: (req.body as any).reportStatus ?? true, createdAt: '2026-10-07T00:00:00Z', lastSeenAt: '2026-10-07T00:00:00Z', status: null } });
    return Effect.succeed({ status: 204 });
  } });
  const credentials = Layer.succeed(MachineTokenStore, { read: () => Effect.succeed(token), write: (value) => Effect.sync(() => { token = value; }), remove: () => removeFailure ? Effect.fail(new HostedFailure({ code: 'credential_storage' })) : Effect.sync(() => { token = undefined; }) });
  const layer = Layer.mergeAll(stores, transport, credentials);
  // Capture actual services once; restarts recreate only the client, retaining files and credential fake.
  const services = await Effect.runPromise(Effect.gen(function* () { return { store: yield* HostedStore, decisions: yield* DecisionsStore, history: yield* HistoryStore, transport: yield* HostedTransport, credentials: yield* MachineTokenStore }; }).pipe(Effect.provide(layer)));
  const captured = Layer.mergeAll(Layer.succeed(HostedStore, services.store), Layer.succeed(DecisionsStore, services.decisions), Layer.succeed(HistoryStore, services.history), transport, credentials);
  const create = () => Effect.runPromise(makeHostedClient({ now: () => new Date(clock),
    readPolicy: Effect.sync(() => ({ policy, policySource })), onPolicy: (next, origin) => Effect.sync(() => { policy = next; if (origin === 'local') policySource = 'person'; }) }).pipe(Effect.provide(captured)));
  let client = await create();
  const signIn = async () => { await Effect.runPromise(client.startSignIn({ os: 'macos', agents: ['claude'] })); clock += 5000; return Effect.runPromise(client.pollSignIn()); };
  return { root, paths, services, requests, actions, signIn, get client() { return client; }, restart: async () => { client = await create(); },
    advance: (ms: number) => { clock += ms; }, setResponse: (next: SyncResponse) => { response = next; }, setAccount: (next: string) => { account = next; },
    person: () => { policy = 'manual'; policySource = 'person'; }, get policy() { return policy; }, setCrash: (next: boolean) => { crash = next; }, get token() { return token; }, setToken: (next: string) => { token = next; }, failWrite: (suffix?: string) => { failSuffix = suffix; }, failRemove: (next: boolean) => { removeFailure = next; } };
};
const run = Effect.runPromise;

test('device flow uses safe default name, interval and expiry, and never returns token', async (t) => {
  const f = await fixture(t);
  const start = await run(f.client.startSignIn({ os: 'macos', agents: ['claude'] }));
  assert.equal((f.requests[0]!.body as any).name, 'macOS machine');
  assert.equal('pendingId' in start, false);
  assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 5 });
  assert.equal(f.requests.length, 1);
  f.advance(120000);
  await assert.rejects(run(f.client.pollSignIn()), /sign_in_expired/);
  assert.equal(f.requests.length, 1);
  const success = await f.signIn();
  assert.equal(success.status, 'success');
  assert.equal(JSON.stringify(success).includes('nmt_'), false);
  assert.equal(JSON.stringify(await run(f.client.state)).includes('nmt_'), false);
});

test('default policy adopts service default while person policy queues before sync', async (t) => {
  const f = await fixture(t);
  await f.signIn();
  assert.equal(f.policy, 'auto-apply');
  await run(f.client.signOut());
  f.person();
  await f.signIn();
  assert.equal(f.policy, 'manual');
  const doc = await run(f.services.store.read);
  assert.deepEqual(doc.accounts[0]!.outbox.map((e) => e.kind), ['machine']);
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.equal(f.policy, 'manual');
});

test('sync stores all 75 revisions and rejects missing query-relative records without checkpoint advance', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.setResponse(delta({ revisions: Array.from({ length: 75 }, (_, i) => revision(i + 1)), setups: [{ ...delta().setups[0]!, latestRevision: 75 }] }));
  await run(f.client.sync());
  assert.equal((await run(f.client.revisions('setup1'))).length, 75);
  assert.equal((await run(f.services.store.read)).accounts[0]!.cursors[0]!.revision, 75);
  f.setResponse(delta({ seq: 2, revisions: [revision(77)], setups: [{ ...delta().setups[0]!, latestRevision: 77 }] }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 1);
  assert.equal((await run(f.client.revisions('setup1'))).length, 75);
});

test('cache-before-checkpoint crash replays identical records after restart', async (t) => {
  const f = await fixture(t); await f.signIn(); f.setCrash(true);
  await assert.rejects(run(f.client.sync()), /storage/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 0);
  assert.equal((await run(f.client.revisions('setup1'))).length, 1);
  f.setCrash(false); await f.restart(); await run(f.client.sync());
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 1);
  assert.equal((await run(f.client.revisions('setup1'))).length, 1);
});

test('cache-ahead replay refuses immutable divergence and decreasing sequence or head', async (t) => {
  const f = await fixture(t); await f.signIn(); f.setCrash(true);
  await assert.rejects(run(f.client.sync())); f.setCrash(false);
  f.setResponse(delta({ revisions: [{ ...revision(1), changelog: 'retargeted' }] }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  f.setResponse(delta()); await run(f.client.sync());
  f.setResponse(delta({ seq: 0, revisions: [] })); await assert.rejects(run(f.client.sync()), /invalid_response/);
  f.setResponse(delta({ seq: 2, revisions: [], setups: [{ ...delta().setups[0]!, latestRevision: 0 }] }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
});

test('304 retains metadata, passes ETag and preserves choices; retry deadlines survive restart', async (t) => {
  const f = await fixture(t); await f.signIn(); f.setResponse(delta({ decisions: [synced()] })); await run(f.client.sync());
  f.actions.push((req) => { assert.equal(req.etag, 'etag1'); return Effect.succeed({ status: 304 }); });
  await run(f.client.sync()); assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'rate_limited', status: 429, retryAfter: 60 })));
  await assert.rejects(run(f.client.sync()), /rate_limited/);
  const count = f.requests.length; await f.restart(); await run(f.client.sync()); assert.equal(f.requests.length, count);
  f.advance(60000); f.setResponse(delta({ revisions: [], decisions: [] })); await run(f.client.sync()); assert.equal(f.requests.length, count + 1);
});

test('authentication failure stops hosted requests across restart and preserves local data', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local()));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'unauthenticated', status: 401 })));
  await assert.rejects(run(f.client.sync()), /unauthenticated/);
  const count = f.requests.length; await f.restart(); await run(f.client.sync());
  assert.equal(f.requests.length, count); assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
});

test('offline repeated reversals follow queue order despite skewed local clocks and PUT seq never advances GET', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.sync());
  await run(f.client.enqueueDecision(local()));
  await run(f.client.enqueueDecision(local({ decision: 'skip', decidedAt: '2020-01-01T00:00:00Z' })));
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
  f.setResponse(delta({ seq: 100, revisions: [], decisions: [synced({ decision: 'skip', decidedAt: '2020-01-01T00:00:00Z' })] }));
  await run(f.client.sync());
  const sent = [...f.requests].reverse().find((r) => r.path === '/decisions')!;
  assert.deepEqual((sent.body as any).decisions.map((d: any) => d.decision), ['accept', 'skip']);
  assert.match(f.requests.at(-1)!.path, /^\/sync\?since=1&/);
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
});

test('stale outcome restores known server choice when server choice predates queued intent and delta is empty', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.setResponse(delta({ seq: 9, revisions: [revision(1), revision(2)], setups: [{ ...delta().setups[0]!, latestRevision: 2 }], decisions: [synced({ revision: 2 })] }));
  await run(f.client.sync()); await run(f.client.enqueueDecision(local()));
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
  f.actions.push(() => Effect.succeed({ status: 200, body: { seq: 9, results: [{ setupId: 'setup1', itemId: local().itemId, outcome: 'stale' }] } }));
  f.setResponse(delta({ seq: 9, revisions: [], decisions: [], setups: [{ ...delta().setups[0]!, latestRevision: 2 }] }));
  await run(f.client.sync()); await f.restart();
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
  assert.equal((await run(f.services.decisions.read))[0]!.revision, 2);
});

test('mixed machine entries retain order and an unprocessed suffix blocks later entries', async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.client.enqueueDecision(local())); await run(f.client.enqueueDecision(local({ decision: 'skip' })));
  await run(f.client.enqueueMachine({ policy: 'manual' })); await run(f.client.enqueueDecision(local({ decision: 'accept' })));
  f.actions.push(() => Effect.succeed({ status: 200, body: { seq: 5, results: [
    { setupId: 'setup1', itemId: local().itemId, outcome: 'stored' }, { setupId: 'setup1', itemId: local().itemId, outcome: 'unprocessed' }] } }));
  await run(f.client.sync());
  assert.deepEqual((await run(f.services.store.read)).accounts[0]!.outbox.map((e) => e.kind), ['decision', 'machine', 'decision']);
  assert.equal(f.requests.filter((r) => r.method === 'PATCH').length, 0);
  f.setResponse(delta({ seq: 10, revisions: [] })); await run(f.client.sync());
  assert.deepEqual(f.requests.slice(-4).map((r) => r.method), ['PUT', 'PATCH', 'PUT', 'GET']);
});

test('malformed or miscorrelated outcomes preserve all entries and optimistic choices', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local()));
  f.actions.push(() => Effect.succeed({ status: 200, body: { seq: 1, results: [{ setupId: 'wrong', itemId: local().itemId, outcome: 'stored' }] } }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
});

test('invalid request drops only sent entries, writes History, and preserves unsent suffix', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local()));
  await run(f.client.enqueueMachine({ policy: 'manual' })); await run(f.client.enqueueDecision(local({ decision: 'skip' })));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'invalid', status: 400 })));
  // Later suffix still exists if its following request fails.
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.deepEqual((await run(f.services.store.read)).accounts[0]!.outbox.map((e) => e.kind), ['machine', 'decision']);
  assert.equal((await run(f.services.history.read)).some((e) => e.kind === 'outbox-dropped'), true);
});

test('full JSON byte limit splits consecutive decisions without dropping or reordering', async (t) => {
  const f = await fixture(t); await f.signIn();
  // Long allowed IDs cross 128 KiB before the 500-decision bound.
  for (let i = 0; i < 500; i++) await run(f.client.enqueueDecision(local({ setupId: 'x'.repeat(100), itemId: `file:${'x'.repeat(196)}${String(i).padStart(3, '0')}` })));
  f.setResponse(delta({ revisions: [revision(1)] })); await run(f.client.sync());
  const batches = f.requests.filter((r) => r.path === '/decisions').map((r) => r.body as { decisions: Decision[] });
  assert.equal(batches.length, 2); assert.ok(batches.every((b) => jsonByteLength(b) <= MAX_REQUEST_BODY_BYTES));
  assert.equal(batches.flatMap((b) => b.decisions).length, 500);
  assert.equal(batches.at(-1)!.decisions.at(-1)!.itemId.endsWith('499'), true);
});

test('account changes isolate queues and revision caches while same account sign-in reuses unsent intent', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.sync()); await run(f.client.enqueueDecision(local()));
  await run(f.client.signOut()); assert.equal(f.token, undefined);
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
  assert.equal((await run(f.client.revisions('setup1'))).length, 1);
  f.setAccount('account2'); await f.signIn(); assert.deepEqual(await run(f.client.revisions('setup1')), []);
  await run(f.client.enqueueDecision(local({ decision: 'skip' }))); await run(f.client.sync());
  const doc = await run(f.services.store.read); assert.equal(doc.accounts.find((a) => a.accountId === 'account1')!.outbox.length, 1);
  assert.deepEqual(([...f.requests].reverse().find((r) => r.path === '/decisions')!.body as any).decisions.map((d: any) => d.decision), ['skip']);
  await run(f.client.signOut()); f.setAccount('account1'); await f.signIn();
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
  assert.equal((await run(f.client.revisions('setup1'))).length, 1);
  assert.equal((await readFile(join(f.paths.stateRoot, 'agent', 'sync.json'), 'utf8')).includes('nmt_'), false);
});

test('device pending and Retry-After enforce next poll without leaking credential', async (t) => {
  const f = await fixture(t); await run(f.client.startSignIn({ os: 'linux', agents: [] })); f.advance(5000);
  f.actions.push(() => Effect.succeed({ status: 202, body: { interval: 10 } }));
  assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 10 });
  f.advance(10000); f.actions.push(() => Effect.fail(new HostedFailure({ code: 'unavailable', retryAfter: 30 })));
  await assert.rejects(run(f.client.pollSignIn()), /unavailable/); const count = f.requests.length;
  assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 30 }); assert.equal(f.requests.length, count);
  f.advance(30000); assert.equal((await run(f.client.pollSignIn())).status, 'success');
});

test('queued reporting setting is immediately visible and survives incoming old server settings', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueMachine({ reportStatus: false }));
  assert.equal((await run(f.client.state)).machine!.reportStatus, false);
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync())); await f.restart();
  assert.equal((await run(f.client.state)).machine!.reportStatus, false);
});

test('authoritative decisions cannot regress revision even under a higher sequence', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.setResponse(delta({ seq: 3, revisions: [revision(1), revision(2)], setups: [{ ...delta().setups[0]!, latestRevision: 2 }], decisions: [synced({ revision: 2 })] }));
  await run(f.client.sync());
  f.setResponse(delta({ seq: 4, revisions: [], setups: [{ ...delta().setups[0]!, latestRevision: 2 }], decisions: [synced({ revision: 1, decision: 'accept' })] }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.decisions.read))[0]!.revision, 2);
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 3);
});

test('re-registration uses the new default policy and clears an old machine ETag', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.sync());
  await run(f.client.signOut()); await f.signIn();
  assert.equal(f.policy, 'auto-apply');
  f.setResponse(delta({ revisions: [] })); await run(f.client.sync());
  assert.equal(f.requests.at(-1)!.etag, undefined);
});

test('queue write failure prevents optimistic mutation; projection failure retains durable intent for restart', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.failWrite('/agent/sync.json'); await assert.rejects(run(f.client.enqueueDecision(local())), /storage/);
  assert.deepEqual(await run(f.services.decisions.read), []);
  f.failWrite('/decisions.json'); await assert.rejects(run(f.client.enqueueDecision(local({ decision: 'skip' }))), /storage/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
  f.failWrite(); await f.restart(); f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
});

test('wrong-account credential cannot send another account metadata and marks authentication failure', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local()));
  f.setToken(`nmt_account2_machine1_${'s'.repeat(43)}`); const count = f.requests.length;
  await assert.rejects(run(f.client.sync()), /unauthenticated/);
  assert.equal(f.requests.length, count); assert.equal((await run(f.client.state)).auth, 'unauthenticated');
});

test('sign-out deletes local credential and retains local metadata and queue even when revoke is offline', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.sync()); await run(f.client.enqueueDecision(local()));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.signOut()), /network/);
  assert.equal(f.token, undefined); assert.equal((await run(f.client.state)).auth, 'signed-out');
  assert.equal((await run(f.client.revisions('setup1'))).length, 1);
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'accept');
});

test('corrupt stored error or unknown nested fields never reach state and are never rewritten', async (t) => {
  const f = await fixture(t); await f.signIn();
  const file = join(f.paths.stateRoot, 'agent', 'sync.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  before.accounts[0].error = 'nmt_private_do_not_project';
  const text = JSON.stringify(before); await writeFile(file, text);
  await assert.rejects(run(f.client.state), /storage/);
  await assert.rejects(run(f.client.enqueueMachine({ policy: 'manual' })), /storage/);
  assert.equal(await readFile(file, 'utf8'), text);
});

test('choice History preserves initiating actors and remote decisions use sync actor', async (t) => {
  const f = await fixture(t); await f.signIn(); f.setResponse(delta({ decisions: [synced()] })); await run(f.client.sync());
  await run(f.client.enqueueDecision(local(), 'app'));
  await run(f.client.enqueueMachine({ policy: 'manual' }, 'cli'));
  const events = await run(f.services.history.read);
  assert.equal(events.some((e) => e.kind === 'decided' && e.actor === 'app'), true);
  assert.equal(events.some((e) => e.kind === 'decided' && e.actor === 'sync' && e.machineId === 'other'), true);
  assert.equal(events.some((e) => e.kind === 'policy-changed' && e.actor === 'cli' && e.origin === 'local'), true);
  assert.equal(JSON.stringify(events).includes('nmt_'), false);
});

test('decision batches also stop at 500 and preserve duplicate positions', async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.services.store.update((doc) => ({ ...doc, accounts: doc.accounts.map((a) => ({ ...a, outbox: Array.from({ length: 501 }, (_, i) => ({
    kind: 'decision' as const, decision: { setupId: 'setup1', itemId: local().itemId, revision: 1, decision: i % 2 ? 'skip' as const : 'accept' as const }, decidedAt: local().decidedAt,
  })) })) })));
  await run(f.client.sync());
  const batches = f.requests.filter((r) => r.path === '/decisions').map((r) => (r.body as { decisions: Decision[] }).decisions);
  assert.deepEqual(batches.map((b) => b.length), [500, 1]); assert.equal(batches[0]![499]!.decision, 'skip'); assert.equal(batches[1]![0]!.decision, 'accept');
});

test('invalid local timestamp is an invalid request before touching the durable queue', async (t) => {
  const f = await fixture(t); await f.signIn();
  await assert.rejects(run(f.client.enqueueDecision(local({ decidedAt: 'January 1, 2020' }))), /invalid_request/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 0);
});

test('stored acknowledgment cannot regress a previously synced newer authoritative revision', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.setResponse(delta({ seq: 2, decisions: [synced({ revision: 2 })], revisions: [revision(1), revision(2)], setups: [{ ...delta().setups[0]!, latestRevision: 2 }] }));
  await run(f.client.sync()); await run(f.client.enqueueDecision(local()));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
  assert.equal((await run(f.services.store.read)).accounts[0]!.authoritative[0]!.revision, 2);
});

test('unsafe device interval and sync cadence are rejected before deadlines or checkpoint advance', async (t) => {
  const f = await fixture(t);
  f.actions.push(() => Effect.succeed({ status: 200, body: { pendingId: 'pending', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: Number.MAX_SAFE_INTEGER, expiresIn: 120 } }));
  await assert.rejects(run(f.client.startSignIn({ os: 'macos', agents: [] })), /invalid_response/);
  await assert.rejects(run(f.client.pollSignIn()), /sign_in_expired/);
  await f.signIn(); f.setResponse(delta({ pollAfter: Number.MAX_SAFE_INTEGER }));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 0);
});

test('failed device polling still obeys its current interval without Retry-After', async (t) => {
  const f = await fixture(t); await run(f.client.startSignIn({ os: 'macos', agents: [] })); f.advance(5000);
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.pollSignIn()), /network/); const count = f.requests.length;
  assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 5 });
  assert.equal(f.requests.length, count);
});

test('invalid sent intent restores previously synced authority with an empty delta', async (t) => {
  const f = await fixture(t); await f.signIn(); f.setResponse(delta({ decisions: [synced()] })); await run(f.client.sync());
  await run(f.client.enqueueDecision(local()));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'invalid', status: 400 })));
  f.setResponse(delta({ revisions: [], decisions: [] })); await run(f.client.sync());
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 0);
});

test('invalid machine policy removes its optimism before a later request fails', async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.client.enqueueMachine({ policy: 'manual' }, 'cli')); await run(f.client.enqueueDecision(local()));
  assert.equal(f.policy, 'manual');
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'invalid', status: 400 })));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.equal(f.policy, 'auto-apply');
});

for (const auth of ['signed-out', 'unauthenticated', 'retry', 'signed-in'] as const) test(`review recovery repairs durable choices and policy before ${auth} guards and HTTP`, async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.services.store.update((doc) => ({ ...doc, accounts: doc.accounts.map((a) => ({ ...a,
    auth: auth === 'retry' ? 'signed-in' : auth,
    retryAt: auth === 'retry' ? '2026-10-08T00:00:00Z' : null,
    outbox: [
      { kind: 'machine' as const, patch: { policy: 'manual' as const } },
      { kind: 'decision' as const, decision: { setupId: 'setup1', itemId: local().itemId, revision: 1, decision: 'skip' as const }, decidedAt: local().decidedAt },
    ],
  })) })));
  await f.restart(); const count = f.requests.length;
  if (auth === 'signed-in') {
    f.actions.push(() => { assert.equal(f.policy, 'manual'); return Effect.fail(new HostedFailure({ code: 'network' })); });
    await assert.rejects(run(f.client.sync()), /network/);
  } else {
    await run(f.client.sync()); assert.equal(f.requests.length, count);
  }
  assert.equal(f.policy, 'manual');
  assert.equal((await run(f.services.decisions.read))[0]!.decision, 'skip');
});

test('review recovery removes inactive account projection after account checkpoint interruption', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local({ setupId: 'setupA' })));
  await run(f.client.signOut()); f.setAccount('account2'); f.failWrite('/decisions.json');
  await assert.rejects(f.signIn(), /storage/);
  assert.equal((await run(f.services.store.read)).activeAccountId, 'account2');
  assert.equal((await run(f.services.decisions.read))[0]!.setupId, 'setupA');
  f.failWrite(); await f.restart();
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.deepEqual(await run(f.services.decisions.read), []);
  assert.equal((await run(f.services.store.read)).accounts.find((a) => a.accountId === 'account1')!.outbox.length, 1);
});

test('review sign-out removes credentials despite corrupt metadata and preserves corrupt bytes', async (t) => {
  const f = await fixture(t); await f.signIn(); const file = join(f.paths.stateRoot, 'agent', 'sync.json');
  await writeFile(file, '{corrupt'); const count = f.requests.length;
  await assert.rejects(run(f.client.signOut()), /storage/);
  assert.equal(f.token, undefined); assert.equal(f.requests.length, count);
  assert.equal(await readFile(file, 'utf8'), '{corrupt');
});

test('review stored duplicate results reject within-batch revision regression before removing any intent', async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.client.enqueueDecision(local({ revision: 2 }))); await run(f.client.enqueueDecision(local({ decision: 'skip' })));
  f.actions.push(() => Effect.succeed({ status: 200, body: { seq: 2, results: [
    { setupId: 'setup1', itemId: local().itemId, outcome: 'stored' }, { setupId: 'setup1', itemId: local().itemId, outcome: 'stored' },
  ] } }));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /invalid_response/);
  const a = (await run(f.services.store.read)).accounts[0]!;
  assert.equal(a.outbox.length, 2); assert.deepEqual(a.authoritative, []);
  assert.equal(f.requests.filter((r) => r.path.startsWith('/sync?')).length, 0);
});

for (const [code, retryAfter] of [['unauthenticated', 2147484], ['unavailable', 2147484], ['rate_limited', Number.MAX_SAFE_INTEGER]] as const) test(`review oversized Retry-After preserves original ${code} and durable backoff`, async (t) => {
  const f = await fixture(t); await f.signIn();
  f.actions.push(() => Effect.fail(new HostedFailure({ code, retryAfter })));
  await assert.rejects(run(f.client.sync()), new RegExp(code));
  const a = (await run(f.services.store.read)).accounts[0]!;
  assert.equal(a.error, code); assert.equal(a.auth, code === 'unauthenticated' ? 'unauthenticated' : 'signed-in');
  assert.ok(Date.parse(a.retryAt!) > Date.parse('2026-10-07T00:00:05Z'));
  const count = f.requests.length; await f.restart(); await run(f.client.sync()); assert.equal(f.requests.length, count);
});

test('review cache-ahead publications reject an older advertised head before checkpointing', async (t) => {
  const f = await fixture(t); await f.signIn();
  f.setResponse(delta({ revisions: [revision(1), revision(2)], setups: [{ ...delta().setups[0]!, latestRevision: 2 }] }));
  f.setCrash(true); await assert.rejects(run(f.client.sync()), /storage/); f.setCrash(false); await f.restart();
  f.setResponse(delta()); await assert.rejects(run(f.client.sync()), /invalid_response/);
  assert.equal((await run(f.services.store.read)).accounts[0]!.seq, 0);
  assert.equal((await run(f.services.store.read)).accounts[0]!.setups.length, 0);
  assert.equal((await run(f.client.revisions('setup1'))).length, 2);
});

test('review device Retry-After cannot shorten the current polling interval', async (t) => {
  const f = await fixture(t); await run(f.client.startSignIn({ os: 'macos', agents: [] })); f.advance(5000);
  f.actions.push(() => Effect.succeed({ status: 202, body: { interval: 10 } })); await run(f.client.pollSignIn()); f.advance(10000);
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'unavailable', retryAfter: 1 })));
  await assert.rejects(run(f.client.pollSignIn()), /unavailable/); const count = f.requests.length;
  assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 10 });
  f.advance(1000); assert.deepEqual(await run(f.client.pollSignIn()), { status: 'pending', pollAfter: 9 });
  assert.equal(f.requests.length, count);
});

test('review dropping the last unknown-setup intent cannot leave an orphan hosted projection', async (t) => {
  const f = await fixture(t); await f.signIn(); await run(f.client.enqueueDecision(local({ setupId: 'unknownSetup' })));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'invalid', status: 400 })));
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'network' })));
  await assert.rejects(run(f.client.sync()), /network/);
  assert.deepEqual(await run(f.services.decisions.read), []);
  await f.restart(); await run(f.client.recover()); assert.deepEqual(await run(f.services.decisions.read), []);
});

test('review corrupt-metadata sign-out exposes credential deletion failure and permits deletion retry', async (t) => {
  const f = await fixture(t); await f.signIn(); const file = join(f.paths.stateRoot, 'agent', 'sync.json');
  await writeFile(file, '{corrupt'); f.failRemove(true);
  await assert.rejects(run(f.client.signOut()), /credential_storage/); assert.ok(f.token);
  assert.equal(await readFile(file, 'utf8'), '{corrupt'); f.failRemove(false);
  await assert.rejects(run(f.client.signOut()), /storage/); assert.equal(f.token, undefined);
});

test('review explicit recovery repairs local policy without uploading and preserves local commit decisions', async (t) => {
  const f = await fixture(t); await f.signIn();
  await run(f.services.decisions.record(local({ setupId: 'local', revision: null, commit: 'a'.repeat(40) })));
  await run(f.services.store.update((doc) => ({ ...doc, accounts: doc.accounts.map((a) => ({ ...a,
    outbox: [{ kind: 'machine' as const, patch: { policy: 'manual' as const } }],
  })) })));
  const count = f.requests.length; await f.restart(); const state = await run(f.client.recover());
  assert.equal(f.requests.length, count); assert.equal(state.machine!.policy, 'manual'); assert.equal(f.policy, 'manual');
  assert.equal((await run(f.services.decisions.read))[0]!.setupId, 'local');
  assert.equal((await run(f.services.store.read)).accounts[0]!.outbox.length, 1);
});

test('status reporting validates complete metadata, guards auth/settings/backoff and requires 204', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof f.client.reportStatus, 'function');
  const summary = { reportedAt: '2026-10-07T00:00:00Z', policy: 'notify', agents: ['claude'], setups: [], drift: { setting: 0, skill: 0, integration: 0, file: 0 } } as const;
  await run(f.client.reportStatus(summary));
  assert.equal(f.requests.length, 0);
  await f.signIn();
  await run(f.client.reportStatus(summary));
  assert.equal(f.requests.at(-1)?.path, '/machines/self/status');
  assert.deepEqual(f.requests.at(-1)?.body, summary);
  const before = f.requests.length;
  await assert.rejects(run(f.client.reportStatus({ ...summary, token: 'secret' } as any)), /invalid_request/);
  assert.equal(f.requests.length, before);
  await run(f.client.enqueueMachine({ reportStatus: false }));
  await run(f.client.reportStatus(summary));
  assert.equal(f.requests.length, before);
  await run(f.client.enqueueMachine({ reportStatus: true }));
  f.actions.push(() => Effect.succeed({ status: 200 }));
  await assert.rejects(run(f.client.reportStatus(summary)), /invalid_response/);
  f.actions.push(() => Effect.fail(new HostedFailure({ code: 'unavailable', retryAfter: 2147484 })));
  await assert.rejects(run(f.client.reportStatus(summary)), /unavailable/);
  const backedOff = f.requests.length;
  await run(f.client.reportStatus(summary));
  assert.equal(f.requests.length, backedOff);
});

test('oversized complete status is declined before HTTP, never truncated', async (t) => {
  const f = await fixture(t); await f.signIn();
  const ids = Array.from({ length: 2000 }, (_, i) => `file:claude:${i}-${'x'.repeat(150)}.md`);
  const summary = { reportedAt: '2026-10-07T00:00:00Z', policy: 'notify', agents: ['claude'], setups: [{ setupId: 'setup1', revisionApplied: 0, adopted: [], skipped: [], pending: [], waitingForPerson: ids }], drift: { setting: 0, skill: 0, integration: 0, file: 0 } } as const;
  assert.ok(jsonByteLength(summary) > MAX_REQUEST_BODY_BYTES);
  const before = f.requests.length;
  await assert.rejects(run(f.client.reportStatus(summary)), /invalid_request/);
  assert.equal(f.requests.length, before);
});
