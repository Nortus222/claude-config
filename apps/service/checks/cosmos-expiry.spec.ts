import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { Effect } from 'effect';
import { cosmosDocumentId, makeCosmosStore } from '../src/cosmos-store.ts';
import type { DeviceSessionDocument } from '../src/documents.ts';
import { ServiceFailure } from '../src/errors.ts';
import { account, upsert } from './support/store-contract.ts';
import { createCosmosFixture, emulatorConfigured, requireEmulatorConfiguration } from './support/cosmos.ts';
import { registerExpiryContract } from './support/expiry-contract.ts';
import { fixture } from './support/service.ts';

if (process.env.NORTUSCC_COSMOS_REQUIRED === '1') requireEmulatorConfiguration();

const session = (id: string, now: number, seconds: number): DeviceSessionDocument => ({
  type: 'deviceSession', version: 1, id: `device:${id}`, pendingId: id, deviceCode: 'temporary-upstream-credential',
  description: { name: 'Machine', os: 'linux', agents: ['codex'] }, createdAt: now, expiresAt: now + seconds * 1000,
  interval: 5, nextPollAt: now + 5000, state: 'pending', claim: null,
});

if (!emulatorConfigured()) {
  test('Cosmos emulator device expiry requires explicit local configuration', { skip: true }, () => {});
} else {
  registerExpiryContract('Cosmos emulator', ({ now }) => createCosmosFixture({ now, pageSize: 1 }));

  test('actual Cosmos TTL removes unbound credentials from query and point APIs without polling', { timeout: 400000 }, async (t) => {
    const { database, store, restart, dispose } = await createCosmosFixture({ now: Date.now }); t.after(dispose);
    const pending = session('wall-clock', Date.now(), 2);
    await Effect.runPromise(store.closePartition('accounts', 'closed-account', null));
    await Effect.runPromise(store.closePartition('setups', 'closed-setup', null));
    await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account()), upsert({
      type: 'issuanceFence', version: 1, id: 'issuance:paused', accountId: 'account-a', machineId: 'paused',
    })]));
    const bound: DeviceSessionDocument = { ...session('wall-bound', Date.now(), 2), state: 'claimed',
      claim: { claimId: 'bound', accountId: 'account-a', machineId: 'bound', tokenHash: 'hash', claimedAt: Date.now() } };
    await Effect.runPromise(store.commitPartition('identities', bound.id, null, [upsert(bound)]));
    await Effect.runPromise(store.commitPartition('identities', 'github:123', null, [upsert({
      type: 'identity', version: 1, id: 'github:123', githubId: 123, accountId: 'account-a', state: 'active',
    })]));
    await Effect.runPromise(store.commitPartition('identities', pending.id, null, [{ type: 'upsert', document: pending }]));
    const identities = database.container('identities');
    const before = await identities.item(pending.id, pending.id).read();
    assert.ok(before.resource?.ttl > 0 && before.resource?.ttl <= 2);
    assert.equal(before.resource?.payload.deviceCode, pending.deviceCode);
    // EN20260907 purges every five minutes. This budget is not a service retention guarantee.
    const deadline = Date.now() + 360000;
    let pointMissing = false; let queryMissing = false;
    do {
      await setTimeout(2000);
      const point = await identities.item(pending.id, pending.id).read();
      pointMissing = point.statusCode === 404 && point.resource === undefined;
      const query = await identities.items.query({ query: 'SELECT c.id FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: pending.id }] }).fetchAll();
      queryMissing = query.resources.length === 0;
    } while ((!pointMissing || !queryMissing) && Date.now() < deadline);
    assert.equal(queryMissing, true, 'expired credential is absent from query API');
    assert.equal(pointMissing, true, 'expired credential is absent from point API');
    assert.ok(Date.now() >= pending.expiresAt);
    const retained = await identities.item(bound.id, bound.id).read();
    assert.equal(retained.statusCode, 200); assert.equal(retained.resource?.ttl, -1);
    assert.equal(retained.resource?.payload.claim.claimId, 'bound');
    assert.equal((await identities.item('github:123', 'github:123').read()).resource?.ttl, undefined);
    const restarted = restart();
    await Effect.runPromise(restarted.sweepExpiredDevices());
    assert.equal((await identities.item(bound.id, bound.id).read()).statusCode, 404);
    for (const [name, key, id] of [['accounts', 'closed-account', '__partition'], ['setups', 'closed-setup', '__partition'],
      ['accounts', 'account-a', cosmosDocumentId('issuance:paused')]] as const) {
      const raw = await database.container(name).item(id, key).read();
      assert.equal(raw.statusCode, 200); assert.equal(raw.resource?.ttl, undefined);
      if (id === '__partition') assert.equal(raw.resource?.closed, true);
    }
  });

  test('actual Cosmos refresh retains the validity deadline and sets only remaining TTL', async (t) => {
    const clock = { now: Date.now() };
    const { database, store, dispose } = await createCosmosFixture({ now: () => clock.now }); t.after(dispose);
    const f = await fixture({ store, clock }); t.after(f.close);
    f.github.state.expiresIn = 1800;
    const start = await f.start(); assert.equal(start.body.expiresIn, 900);
    const key = `device:${start.body.pendingId}`;
    const before = await Effect.runPromise(store.readPartition('identities', key));
    const original = before.documents[0] as DeviceSessionDocument;
    assert.equal(original.expiresAt - original.createdAt, 900000);
    clock.now += 895500;
    f.github.state.exchange = { type: 'pending' };
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId })).status, 202);
    const raw = await database.container('identities').item(key, key).read();
    assert.equal(raw.resource?.payload.expiresAt, original.expiresAt);
    assert.equal(raw.resource?.ttl, 5);
    // The injected clock establishes validity and the written TTL, not server-side deletion time.
    clock.now = original.expiresAt;
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId })).status, 410);
  });

  test('actual Cosmos sweep resumes retained bound claims after fresh SDK and service restart', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createCosmosFixture({ now: () => clock.now, pageSize: 1 }); t.after(backend.dispose);
    let failAfterWrite = false; let failCleanup = false;
    const store = { ...backend.store, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
      if (failCleanup && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) {
        failCleanup = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
      }
      const result = yield* backend.store.commitPartition(container, key, version, mutations);
      if (failAfterWrite && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) {
        failAfterWrite = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
      }
      return result;
    }) } satisfies typeof backend.store;
    const f = await fixture({ store, clock }); t.after(f.close);
    const owner = (await f.login()).body;
    failAfterWrite = true; failCleanup = true;
    const start = await f.start('Orphan'); clock.now += 5000;
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId })).status, 503);
    const key = `device:${start.body.pendingId}`;
    const raw = await backend.database.container('identities').item(key, key).read();
    assert.equal(raw.resource?.ttl, -1); assert.ok(raw.resource?.payload.claim);
    const claim = raw.resource!.payload.claim;
    clock.now += 900000;
    const restarted = backend.restart(); await f.restart(restarted);
    await Effect.runPromise(restarted.sweepExpiredDevices());
    await Effect.runPromise(restarted.sweepExpiredDevices());
    assert.equal((await backend.database.container('identities').item(key, key).read()).statusCode, 404);
    const account = await Effect.runPromise(restarted.readPartition('accounts', owner.accountId));
    assert.ok(!account.documents.some((d) => d.type === 'machine' && d.machineId === claim.machineId));
    assert.ok(account.documents.some((d) => d.type === 'issuanceFence' && d.machineId === claim.machineId));
    assert.ok(!account.documents.some((d) => d.type === 'deviceReservation' && d.sessionId === key));
    const rawFence = await backend.database.container('accounts').item(cosmosDocumentId(`issuance:${claim.machineId}`), owner.accountId).read();
    assert.equal(rawFence.resource?.ttl, undefined);
  });

  test('actual Cosmos one sweep recovers every initially expired claim across forced query pages', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createCosmosFixture({ now: () => clock.now, pageSize: 1 }); t.after(backend.dispose);
    const sessions = Array.from({ length: 9 }, (_, index): DeviceSessionDocument => ({ ...session(`page-${index}`, clock.now, 1), state: 'claimed',
      claim: { claimId: `claim-${index}`, accountId: 'account-a', machineId: `machine-${index}`, tokenHash: 'hash', claimedAt: clock.now } }));
    await Effect.runPromise(backend.store.commitPartition('accounts', 'account-a', null, [upsert(account()), ...sessions.map((s) => upsert({
      type: 'deviceReservation', version: 1, id: s.id, accountId: 'account-a', sessionId: s.id,
    }))]));
    for (const s of sessions) await Effect.runPromise(backend.store.commitPartition('identities', s.id, null, [upsert(s)]));
    const future = { ...session('future', clock.now, 900), claim: { ...sessions[0].claim!, machineId: 'future' }, state: 'claimed' as const };
    await Effect.runPromise(backend.store.commitPartition('identities', future.id, null, [upsert(future)]));
    clock.now += 1000;
    const restarted = backend.restart();
    await Effect.runPromise(restarted.sweepExpiredDevices());
    const remaining = (await backend.database.container('identities').items.query('SELECT c.id FROM c').fetchAll()).resources;
    assert.deepEqual(remaining.map((d) => d.id), [future.id]);
    const snapshot = await Effect.runPromise(restarted.readPartition('accounts', 'account-a'));
    assert.equal(snapshot.documents.filter((d) => d.type === 'issuanceFence').length, sessions.length);
    assert.equal(snapshot.documents.filter((d) => d.type === 'deviceReservation').length, 0);
  });

  test('actual Cosmos a failed sweep preserves expired evidence for a restarted explicit sweep', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createCosmosFixture({ now: () => clock.now }); t.after(backend.dispose);
    const f = await fixture({ store: backend.store, clock }); t.after(f.close);
    const owner = (await f.login()).body; const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
    const before = await Effect.runPromise(backend.store.readPartition('identities', key));
    const current = before.documents[0] as DeviceSessionDocument;
    await Effect.runPromise(backend.store.commitPartition('identities', key, before.version, [upsert({ ...current, state: 'claimed',
      claim: { claimId: 'failed-sweep', accountId: owner.accountId, machineId: 'orphan', tokenHash: 'hash', claimedAt: clock.now } })]));
    const account = await Effect.runPromise(backend.store.readPartition('accounts', owner.accountId));
    await Effect.runPromise(backend.store.commitPartition('accounts', owner.accountId, account.version, [upsert({
      type: 'deviceReservation', version: 1, id: key, accountId: owner.accountId, sessionId: key,
    })]));
    const target = backend.database.container('accounts');
    const originalContainer = backend.database.container.bind(backend.database);
    const fault = Object.create(backend.database);
    fault.container = (name: string) => name !== 'accounts' ? originalContainer(name) : { item: target.item.bind(target), items: {
      query: target.items.query.bind(target.items), batch: async () => { throw new Error('PRIVATE SDK failure', { cause: { code: 503 } }); },
    } };
    clock.now += 900000;
    const interrupted = await Effect.runPromise(Effect.result(makeCosmosStore({ database: fault, now: () => clock.now }).sweepExpiredDevices()));
    assert.equal(interrupted._tag, 'Failure'); assert.doesNotMatch(JSON.stringify(interrupted), /PRIVATE/);
    const raw = await backend.database.container('identities').item(key, key).read();
    assert.equal(raw.resource?.payload.state, 'expired'); assert.equal(raw.resource?.payload.claim.claimId, 'failed-sweep');
    assert.equal(raw.resource?.ttl, -1);
    assert.ok((await Effect.runPromise(backend.store.readPartition('accounts', owner.accountId))).documents.some((d) => d.id === key));
    const restarted = backend.restart(); await f.restart(restarted);
    await Effect.runPromise(restarted.sweepExpiredDevices());
    await Effect.runPromise(restarted.sweepExpiredDevices());
    assert.equal((await backend.database.container('identities').item(key, key).read()).statusCode, 404);
    const after = await Effect.runPromise(restarted.readPartition('accounts', owner.accountId));
    assert.ok(!after.documents.some((d) => d.id === key));
    assert.ok(after.documents.some((d) => d.type === 'issuanceFence' && d.machineId === 'orphan'));
  });

  for (const paused of ['claim attachment', 'pending reset', 'machine issuance'] as const) {
    test(`actual Cosmos sweep fences a paused ${paused} after a fresh service starts`, async (t) => {
      const clock = { now: Date.now() };
      const backend = await createCosmosFixture({ now: () => clock.now }); t.after(backend.dispose);
      let enabled = false; let writes = 0;
      let entered!: () => void; const reached = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
      const store = { ...backend.store, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
        const target = mutations.some((m) => m.type === 'upsert' && (paused === 'machine issuance' ? m.document.type === 'machine'
          : m.document.type === 'deviceSession' && (paused === 'claim attachment' ? m.document.claim !== null : m.document.state === 'pending')));
        let held = false;
        if (enabled && target) { enabled = false; held = true; entered(); yield* Effect.promise(() => barrier); }
        const result = yield* backend.store.commitPartition(container, key, version, mutations);
        if (held && result) writes++;
        return result;
      }) } satisfies typeof backend.store;
      const f = await fixture({ store, clock }); t.after(f.close);
      const owner = (await f.login()).body;
      const pending = await f.start('Paused'); clock.now += 5000;
      if (paused === 'pending reset') f.github.state.exchange = { type: 'pending' };
      enabled = true;
      const issuance = f.call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId });
      try {
        await reached; clock.now += 900000;
        const restarted = backend.restart();
        const fresh = await fixture({ store: restarted, clock }); t.after(fresh.close);
        await Effect.runPromise(restarted.sweepExpiredDevices());
        assert.equal((await fresh.call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId })).status, 410);
        if (paused === 'machine issuance') {
          assert.equal((await Effect.runPromise(restarted.readPartition('accounts', owner.accountId))).documents.filter((d) => d.type === 'issuanceFence').length, 1);
        }
        release(); const response = await issuance;
        assert.equal(response.status, 410); assert.equal(writes, 0); assert.ok(!('token' in await response.json()));
        const snapshot = await Effect.runPromise(restarted.readPartition('accounts', owner.accountId));
        assert.equal(snapshot.documents.filter((d) => d.type === 'machine').length, 1);
        assert.equal((await Effect.runPromise(restarted.readPartition('identities', `device:${pending.body.pendingId}`))).version, null);
      } finally { release(); await issuance; }
    });
  }
}
