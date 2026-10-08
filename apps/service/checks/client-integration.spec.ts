import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect } from 'effect';
import { HistoryStore } from '@nortuscc/machine';
import { makeNotifier, makeSession, startAgent } from '@nortuscc/agent';
import { SetupsStore } from '@nortuscc/sync';
import { AccountExportSchema, MachinesResponseSchema, SyncResponseSchema, decodeDecisionsResponse, decodeHosted, type DecisionsRequest } from '@nortuscc/hosted-protocol';
import { makeMemoryStore, ServiceFailure } from '../src/index.ts';
import { clientFixture, EFFORT, HOOK, HOOK_TEXT, SETTING_VALUE } from './support/client-machines.ts';

test('actual HTTP service: explicit person apply, inert auto apply and notify waiting on three isolated machines', async (t) => {
  const f = await clientFixture(t);
  const publisher = (await f.login('Publisher')).body;
  const setup = await f.register(publisher.token);
  await f.publish(publisher.token, setup.setupId, 1);
  const machines = [f.machine(), f.machine(), f.machine()];
  const identities: string[] = [];
  for (const [index, machine] of machines.entries()) await machine.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(`Machine ${index}`); f.clock.now += 5000; yield* runtime.tick;
    const state = yield* runtime.state;
    assert.equal(state.error, null, JSON.stringify(machine.requests));
    assert.equal(state.auth, 'signed-in'); assert.equal(state.accountId, publisher.accountId);
    assert.equal(state.machine?.policy, 'notify'); identities.push(state.machineId!);
    assert.deepEqual(yield* (yield* SetupsStore).read, [], 'sign-in never grants repository trust');
    yield* runtime.trust(setup.setupId, 'cli');
    if (index === 0) {
      for (const itemId of [EFFORT, HOOK]) yield* runtime.decide(f.decision(setup.setupId, itemId), 'cli');
      yield* runtime.sync;
      const handle = yield* startAgent(machine.domains, { hosted: runtime, deferStart: true });
      const session = yield* makeSession(handle, { domains: machine.domains, signal: new AbortController().signal });
      yield* session.inspect('cli'); const preview = yield* session.preview([]);
      const done = Deferred.makeUnsafe<void>();
      const applied = yield* session.apply(preview.planId, 'cli', (_id, progress) => {
        if (['done', 'failed', 'cancelled'].includes(progress.type)) Deferred.doneUnsafe(done, Effect.void);
      });
      assert.equal(applied.status, 'started'); yield* Deferred.await(done);
      assert.equal(readFileSync(join(machine.paths.claude, 'hooks', 'test.mjs'), 'utf8'), HOOK_TEXT);
    } else {
      if (index === 1) { yield* runtime.machine({ policy: 'auto-apply' }, 'cli'); yield* runtime.sync; }
      const job = yield* runtime.runJobs;
      assert.equal(job.status.error, undefined, JSON.stringify(job.status));
      assert.deepEqual(job.status.probeErrors, []);
      if (index === 2) {
        const notifier = yield* makeNotifier({ platform: 'darwin' });
        const delivered: string[] = [];
        notifier.setConnected((notification) => ({ timeoutMs: 1000, deliver: Effect.sync(() => { delivered.push(notification.id); return true; }) }));
        yield* notifier.notify(job.status);
        assert.equal(delivered.length, 1);
        assert.equal((yield* notifier.get(delivered[0]!))!.title, 'Review & apply');
      }
    }
    const response = yield* Effect.promise(() => f.call('GET', '/v1/machines', undefined, publisher.token));
    assert.equal(response.status, 200);
    const records = decodeHosted(MachinesResponseSchema, yield* Effect.promise(() => response.json()));
    const reported = records.machines.find((record) => record.machineId === state.machineId)!;
    assert.ok(reported.status);
    const status = reported.status.setups.find((entry) => entry.setupId === setup.setupId)!;
    assert.ok(status.waitingForPerson.includes(HOOK), 'hook registration does not prove byte adoption');
    if (index < 2) {
      assert.ok(existsSync(join(machine.paths.claude, 'settings.json')), JSON.stringify({ index, status, document: machine.document() }));
      assert.equal(JSON.parse(readFileSync(join(machine.paths.claude, 'settings.json'), 'utf8')).effortLevel, SETTING_VALUE);
      assert.deepEqual(status.adopted, [EFFORT]);
      if (index === 1) assert.equal(existsSync(join(machine.paths.claude, 'hooks', 'test.mjs')), false);
    } else {
      assert.equal(existsSync(join(machine.paths.claude, 'settings.json')), false);
      assert.deepEqual(status.adopted, []); assert.ok(status.waitingForPerson.includes(EFFORT));
    }
    const history = yield* (yield* HistoryStore).read;
    const decisions = history.filter((event) => event.kind === 'decided');
    assert.equal(decisions.length, 2);
    assert.ok(decisions.every((event) => event.actor === (index === 0 ? 'cli' : 'sync')));
    if (index < 2) assert.ok(history.some((event) => event.kind === 'apply-finished'));
    if (index === 2) {
      assert.ok(history.some((event) => event.kind === 'ready' && event.items.some((item) => item.itemId === EFFORT)));
      assert.ok(history.some((event) => event.kind === 'held' && event.items.some((item) => item.itemId === HOOK)));
    }
  }));
  assert.equal(new Set(identities).size, 3);
  const response = await f.call('GET', '/v1/account/export', undefined, publisher.token);
  assert.equal(response.status, 200);
  const exported = decodeHosted(AccountExportSchema, await response.json());
  assert.equal(exported.decisions.length, 2);
  f.assertPrivateMetadata(exported, machines);
});

test('actual client caches more than 50 revisions and uses independent setup cursors and conditional HTTP polls', async (t) => {
  const f = await clientFixture(t); const publisher = (await f.login()).body;
  const setup = await f.register(publisher.token);
  for (let number = 1; number <= 51; number++) await f.publish(publisher.token, setup.setupId, number);
  const machine = f.machine();
  await machine.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(); f.clock.now += 5000; yield* runtime.tick;
    assert.equal((yield* runtime.state).error, null);
    const account = machine.document().accounts[0]!;
    assert.deepEqual(account.cursors, [{ setupId: setup.setupId, revision: 51 }]);
    const path = join(machine.paths.stateRoot, 'agent', 'revisions', publisher.accountId, `${setup.setupId}.json`);
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(cache.revisions.map((record: { number: number }) => record.number), Array.from({ length: 51 }, (_, i) => i + 1));
    yield* runtime.sync; yield* runtime.sync;
    const polls = machine.requests.filter((request) => request.path.startsWith('/v1/sync?'));
    assert.deepEqual(polls.map((request) => request.status), [200, 200, 304]);
    assert.equal(new URL(polls[1]!.path, 'https://fixture.invalid').searchParams.get('since'), String(account.seq));
    assert.equal(new URL(polls[1]!.path, 'https://fixture.invalid').searchParams.get('setups'), `${setup.setupId}:51`);
    assert.equal(polls[2]!.conditional, polls[1]!.etag);
    const page = yield* Effect.promise(() => f.call('GET', `/v1/setups/${setup.setupId}/revisions?after=0`, undefined, publisher.token));
    const listed = yield* Effect.promise(() => page.json());
    assert.equal(listed.revisions.length, 50); assert.equal(listed.nextAfter, 50);
    yield* Effect.promise(() => f.publish(publisher.token, setup.setupId, 52));
    yield* runtime.sync;
    assert.equal(machine.requests.at(-1)!.status, 200);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).revisions.length, 52);
    assert.deepEqual(machine.document().accounts[0]!.cursors, [{ setupId: setup.setupId, revision: 52 }]);
  }));
});

test('actual client retains ordered decision and machine-patch suffix after 98 targets commit and the next chunk fails', async (t) => {
  const memory = makeMemoryStore(); let armed = false; let chunks = 0; const budgets: number[] = [];
  const f = await clientFixture(t, { store: { ...memory, commitPartition: (container, key, version, mutations) => {
    if (mutations.some((mutation) => mutation.type === 'upsert' && mutation.document.type === 'decision')) {
      budgets.push(mutations.length);
      if (armed && ++chunks === 2) return Effect.fail(new ServiceFailure({ code: 'rate_limited', retryAfter: 2 }));
    }
    return memory.commitPartition(container, key, version, mutations);
  } } });
  const publisher = (await f.login()).body; const setup = await f.register(publisher.token);
  const items = Array.from({ length: 100 }, (_, index) => ({ id: `file:claude:fixture${index}`, kind: 'file' as const, change: 'added' as const }));
  await f.publish(publisher.token, setup.setupId, 1, { items });
  const machine = f.machine();
  await machine.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(); f.clock.now += 5000; yield* runtime.tick;
    const checkpoint = machine.document().accounts[0]!.seq;
    for (const item of items.slice(0, 98)) yield* runtime.decide(f.decision(setup.setupId, item.id), 'cli');
    yield* runtime.decide(f.decision(setup.setupId, items[0]!.id, 'skip'), 'cli');
    yield* runtime.decide(f.decision(setup.setupId, items[0]!.id, 'accept'), 'cli');
    yield* runtime.decide(f.decision(setup.setupId, items[98]!.id, 'skip'), 'cli');
    yield* runtime.machine({ policy: 'manual', name: 'Suffix machine' }, 'cli');
    const original = machine.document().accounts[0]!.outbox;
    armed = true; yield* runtime.sync;
    const account = machine.document().accounts[0]!;
    assert.deepEqual(account.outbox, original.slice(99));
    assert.deepEqual(account.outbox.map((entry) => entry.kind), ['decision', 'decision', 'machine']);
    assert.deepEqual(budgets, [99, 3]);
    const put = machine.requests.find((request) => request.method === 'PUT' && request.path === '/v1/decisions')!;
    const reply = decodeDecisionsResponse(put.body as DecisionsRequest, put.reply);
    assert.ok(reply.results.slice(0, 99).every((result) => result.outcome === 'stored'));
    assert.ok(reply.results.slice(99).every((result) => result.outcome === 'unprocessed'));
    const get = machine.requests.filter((request) => request.path.startsWith('/v1/sync?')).at(-1)!;
    assert.equal(new URL(get.path, 'https://fixture.invalid').searchParams.get('since'), String(checkpoint), 'PUT seq does not become the GET checkpoint');
    const authoritative = decodeHosted(SyncResponseSchema, get.reply);
    assert.equal(authoritative.decisions.length, 98);
    assert.equal(authoritative.decisions.find((decision) => decision.itemId === items[0]!.id)!.decision, 'skip');
    assert.equal(account.seq, authoritative.seq);
    assert.equal(account.authoritative.find((decision) => decision.itemId === items[0]!.id)!.decision, 'skip');
    armed = false; yield* runtime.sync;
    const recovered = machine.document().accounts[0]!;
    assert.deepEqual(recovered.outbox, []);
    assert.equal(recovered.authoritative.find((decision) => decision.itemId === items[0]!.id)!.decision, 'accept');
    assert.equal(recovered.authoritative.find((decision) => decision.itemId === items[98]!.id)!.decision, 'skip');
    const retry = machine.requests.filter((request) => request.path === '/v1/decisions').at(-1)!;
    assert.deepEqual((retry.body as DecisionsRequest).decisions, original.slice(99, 101).map((entry) => entry.kind === 'decision' ? entry.decision : assert.fail('expected decision')));
    const patch = machine.requests.find((request) => request.method === 'PATCH')!;
    assert.deepEqual(patch.body, { policy: 'manual', name: 'Suffix machine' });
    assert.ok(machine.requests.indexOf(patch) > machine.requests.indexOf(retry));
    assert.equal(recovered.machine.policy, 'manual');
    const response = yield* Effect.promise(() => f.call('GET', '/v1/machines', undefined, publisher.token));
    const records = decodeHosted(MachinesResponseSchema, yield* Effect.promise(() => response.json()));
    assert.equal(records.machines.find((record) => record.machineId === recovered.machineId)!.name, 'Suffix machine');
  }));
});

test('actual HTTP optout deletes status, signout revokes the token and other accounts cannot access local metadata', async (t) => {
  const f = await clientFixture(t); const publisher = (await f.login()).body; const setup = await f.register(publisher.token);
  await f.publish(publisher.token, setup.setupId, 1);
  const machine = f.machine(); let oldToken = ''; let localTrust = '';
  await machine.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(); f.clock.now += 5000; yield* runtime.tick;
    yield* runtime.trust(setup.setupId, 'cli'); yield* runtime.runJobs;
    oldToken = machine.token()!;
    const report = machine.requests.find((request) => request.path === '/v1/machines/self/status')!;
    assert.equal(report.status, 204);
    yield* runtime.machine({ reportStatus: false }, 'cli'); yield* runtime.sync;
    const response = yield* Effect.promise(() => f.call('GET', '/v1/machines', undefined, publisher.token));
    const records = decodeHosted(MachinesResponseSchema, yield* Effect.promise(() => response.json()));
    const record = records.machines.find((entry) => entry.machineId === machine.document().accounts[0]!.machineId)!;
    assert.equal(record.status, null); assert.equal(record.reportStatus, false);
    const disabled = yield* Effect.promise(() => f.call('PUT', '/v1/machines/self/status', report.body, oldToken));
    assert.equal(disabled.status, 409);
    yield* runtime.decide(f.decision(setup.setupId, EFFORT, 'skip'), 'cli'); yield* runtime.sync;
    assert.equal(machine.document().accounts[0]!.authoritative[0]!.decision, 'skip');
    const uploads = machine.requests.filter((request) => request.path === '/v1/machines/self/status').length;
    yield* runtime.runJobs;
    assert.equal(machine.requests.filter((request) => request.path === '/v1/machines/self/status').length, uploads);
    localTrust = JSON.stringify(yield* (yield* SetupsStore).read);
    const before = machine.document().accounts[0]!;
    yield* runtime.signOut();
    assert.equal(machine.token(), undefined); assert.equal((yield* runtime.state).auth, 'signed-out');
    assert.equal(JSON.stringify(yield* (yield* SetupsStore).read), localTrust);
    assert.deepEqual(machine.document().accounts[0]!.cursors, before.cursors);
    assert.deepEqual(machine.document().accounts[0]!.authoritative, before.authoritative);
    assert.equal(existsSync(join(machine.paths.stateRoot, 'agent', 'revisions', publisher.accountId, `${setup.setupId}.json`)), true);
  }));
  assert.equal((await f.call('GET', '/v1/sync', undefined, oldToken)).status, 401);
  f.github.state.user = { id: 99, login: 'Other' };
  const other = f.machine();
  await other.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(); f.clock.now += 5000; yield* runtime.tick;
    assert.notEqual((yield* runtime.state).accountId, publisher.accountId);
    assert.deepEqual((yield* runtime.state).setups, []);
    const trust = yield* Effect.result(runtime.trust(setup.setupId, 'cli'));
    assert.equal(trust._tag, 'Failure');
    assert.deepEqual(yield* (yield* SetupsStore).read, []);
    const response = yield* Effect.promise(() => f.call('GET', `/v1/setups/${setup.setupId}/revisions?after=0`, undefined, other.token()));
    assert.equal(response.status, 404);
    const exportedResponse = yield* Effect.promise(() => f.call('GET', '/v1/account/export', undefined, other.token()));
    const exported = decodeHosted(AccountExportSchema, yield* Effect.promise(() => exportedResponse.json()));
    assert.deepEqual(exported.setups, []); assert.deepEqual(exported.decisions, []);
    f.assertPrivateMetadata(exported, [machine, other]);
  }));
  assert.equal(machine.document().accounts[0]!.auth, 'signed-out');
});

test('actual clients honor later server arrival when an earlier equal-revision request pauses before its commit', async (t) => {
  const memory = makeMemoryStore(); let armed = false; let held = false;
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const f = await clientFixture(t, { store: { ...memory, commitPartition: (container, key, version, mutations) => {
    if (armed && !held && mutations.some((mutation) => mutation.type === 'upsert' && mutation.document.type === 'decision')) {
      held = true; enter();
      return Effect.promise(() => resumed).pipe(Effect.andThen(memory.commitPartition(container, key, version, mutations)));
    }
    return memory.commitPartition(container, key, version, mutations);
  } } });
  const publisher = (await f.login()).body; const setup = await f.register(publisher.token);
  await f.publish(publisher.token, setup.setupId, 1);
  const earlier = f.machine(); const later = f.machine();
  for (const machine of [earlier, later]) await machine.run((runtime) => Effect.gen(function* () {
    yield* runtime.signIn(); f.clock.now += 5000; yield* runtime.tick;
    assert.equal((yield* runtime.state).error, null);
  }));
  armed = true;
  const first = earlier.run((runtime) => Effect.gen(function* () {
    yield* runtime.decide({ ...f.decision(setup.setupId, EFFORT), decidedAt: '2099-01-01T00:00:00Z' }, 'cli');
    yield* runtime.sync;
  }));
  await Promise.race([entered, first.then(() => assert.fail('earlier request must reach the held decision commit'))]);
  try {
    await later.run((runtime) => Effect.gen(function* () {
      yield* runtime.decide({ ...f.decision(setup.setupId, EFFORT, 'skip'), decidedAt: '2000-01-01T00:00:00Z' }, 'cli');
      yield* runtime.sync;
      assert.equal(later.document().accounts[0]!.authoritative[0]!.decision, 'skip');
    }));
  } finally { release(); }
  await first;
  assert.deepEqual(earlier.document().accounts[0]!.outbox, []);
  assert.equal(earlier.document().accounts[0]!.authoritative[0]!.decision, 'skip');
  const firstPut = earlier.requests.find((request) => request.path === '/v1/decisions')!;
  assert.equal(decodeDecisionsResponse(firstPut.body as DecisionsRequest, firstPut.reply).results[0]!.outcome, 'stale');
  await earlier.run((runtime) => Effect.gen(function* () {
    yield* runtime.decide({ ...f.decision(setup.setupId, EFFORT), decidedAt: '1999-01-01T00:00:00Z' }, 'cli');
    yield* runtime.sync;
    assert.equal(earlier.document().accounts[0]!.authoritative[0]!.decision, 'accept');
  }));
  await later.run((runtime) => Effect.gen(function* () {
    yield* runtime.sync; assert.equal(later.document().accounts[0]!.authoritative[0]!.decision, 'accept');
  }));
});
