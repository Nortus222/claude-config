import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect } from 'effect';
import { makeCosmosStore, type CosmosStore } from '../src/cosmos-store.ts';
import type { DeviceSessionDocument } from '../src/documents.ts';
import { ServiceFailure } from '../src/errors.ts';
import { registerClientIntegrationContract } from './support/client-integration-contract.ts';
import { emulatorConfigured, requireEmulatorConfiguration } from './support/cosmos.ts';
import { createRuntimeCosmosFixture } from './support/runtime.ts';
import { fixture } from './support/service.ts';

if (process.env.NORTUSCC_COSMOS_REQUIRED === '1') requireEmulatorConfiguration();
if (!emulatorConfigured()) {
  test('Cosmos production runtime requires explicit local configuration', { skip: true }, () => {});
} else {
  registerClientIntegrationContract('Cosmos production runtime', createRuntimeCosmosFixture);
  test('production runtime owns fresh SDK restarts on the same port and exercises no-scope GitHub transport', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createRuntimeCosmosFixture({ now: () => clock.now }); t.after(backend.dispose);
    const f = await fixture({ store: backend.store, clock, hosting: backend.hosting }); t.after(f.close);
    const owner = await f.login(); assert.equal(owner.response.status, 200);
    const origin = new URL((await f.call('GET', '/v1/health')).url).origin;
    assert.deepEqual(await (await f.call('GET', '/readyz')).json(), { status: 'ok' });
    await f.restart(await backend.restart());
    assert.equal(new URL((await f.call('GET', '/readyz')).url).origin, origin);
    assert.equal((await f.call('GET', '/v1/account/export', undefined, owner.body.token)).status, 200);
    assert.equal(backend.clientsCreated(), 2); assert.equal(backend.clientsDisposed(), 1);
    await f.close(); await f.close(); assert.equal(backend.clientsDisposed(), 2);
    assert.deepEqual(backend.githubRequests.map((request) => request.url), [
      'https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user',
    ]);
  });
  test('startup recovery removes a retained bound claim after a committed issuance failure and fresh SDK restart', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createRuntimeCosmosFixture({ now: () => clock.now }); t.after(backend.dispose);
    let failWrite = false; let failCleanup = false;
    const base = backend.store;
    const fault: CosmosStore = { ...base, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
      if (failCleanup && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) {
        failCleanup = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
      }
      const result = yield* base.commitPartition(container, key, version, mutations);
      if (failWrite && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) {
        failWrite = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
      }
      return result;
    }) };
    const f = await fixture({ store: fault, clock, hosting: backend.hosting }); t.after(f.close);
    const owner = (await f.login()).body;
    failWrite = true; failCleanup = true;
    const pending = await f.start('Orphan'); clock.now += 5000;
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId })).status, 503);
    const key = `device:${pending.body.pendingId}`;
    const before = await backend.database.container('identities').item(key, key).read();
    assert.equal(before.resource?.ttl, -1); assert.ok(before.resource?.payload.claim);
    const claim = before.resource!.payload.claim;
    clock.now += 900000;
    const restarted = await backend.restart(); await f.restart(restarted);
    assert.equal((await f.call('GET', '/readyz')).status, 200);
    assert.equal((await backend.database.container('identities').item(key, key).read()).statusCode, 404);
    const account = await Effect.runPromise(restarted.readPartition('accounts', owner.accountId));
    assert.ok(!account.documents.some((d) => d.type === 'machine' && d.machineId === claim.machineId));
    assert.ok(account.documents.some((d) => d.type === 'issuanceFence' && d.machineId === claim.machineId));
    assert.ok(!account.documents.some((d) => d.type === 'deviceReservation' && d.sessionId === key));
    assert.equal(backend.clientsCreated(), 2); assert.equal(backend.clientsDisposed(), 1);
  });

  test('periodic actual Cosmos recovery retains failed claim evidence, changes readiness and retries while liveness stays strict', async (t) => {
    const clock = { now: Date.now() };
    const backend = await createRuntimeCosmosFixture({ now: () => clock.now }); t.after(backend.dispose);
    let failed = false;
    const target = backend.database.container('accounts');
    const database = Object.create(backend.database);
    database.container = (name: string) => name !== 'accounts' ? backend.database.container(name) : { item: target.item.bind(target), items: {
      query: target.items.query.bind(target.items), batch: (...args: Parameters<typeof target.items.batch>) => {
        if (failed) return Promise.reject(new Error('PRIVATE SDK recovery failure'));
        return target.items.batch(...args);
      },
    } };
    const recovery = makeCosmosStore({ database, now: () => clock.now, pageSize: 1 });
    const fault: CosmosStore = { ...backend.store, sweepExpiredDevices: recovery.sweepExpiredDevices };
    const f = await fixture({ store: fault, clock, hosting: backend.hosting }); t.after(f.close);
    const owner = (await f.login()).body; const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
    const snapshot = await Effect.runPromise(backend.store.readPartition('identities', key));
    const session = snapshot.documents[0] as DeviceSessionDocument;
    await Effect.runPromise(backend.store.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: {
      ...session, state: 'claimed', claim: { claimId: 'periodic', accountId: owner.accountId, machineId: 'orphan', tokenHash: 'hash', claimedAt: clock.now },
    } }]));
    const account = await Effect.runPromise(backend.store.readPartition('accounts', owner.accountId));
    await Effect.runPromise(backend.store.commitPartition('accounts', owner.accountId, account.version, [{ type: 'upsert', document: {
      type: 'deviceReservation', version: 1, id: key, accountId: owner.accountId, sessionId: key,
    } }]));
    failed = true; clock.now += 900000;
    await waitFor(async () => (await f.call('GET', '/readyz')).status === 503);
    assert.ok(backend.events.includes('recovery_failed'));
    const retained = await backend.database.container('identities').item(key, key).read();
    assert.equal(retained.resource?.payload.state, 'expired'); assert.equal(retained.resource?.ttl, -1);
    assert.equal(retained.resource?.payload.claim.claimId, 'periodic');
    assert.deepEqual(await (await f.call('GET', '/v1/health')).json(), { status: 'ok' });
    for (const [method, path, body] of [['GET', '/readyz?extra=1', undefined], ['POST', '/readyz', undefined], ['GET', '/readyz', {}]] as const) {
      assert.equal((await f.raw(Buffer.from(body === undefined ? '' : JSON.stringify(body)), path, method, body === undefined ? {} : { 'content-type': 'application/json' })).status, 400);
    }
    assert.doesNotMatch(JSON.stringify([backend.events, f.diagnostics]), /PRIVATE|periodic|tokenHash|PRIVATE_DEVICE_CODE/);
    failed = false;
    await waitFor(async () => (await f.call('GET', '/readyz')).status === 200);
    assert.ok(backend.events.includes('recovery_succeeded'));
    assert.equal((await backend.database.container('identities').item(key, key).read()).statusCode, 404);
    assert.ok(!(await Effect.runPromise(backend.store.readPartition('accounts', owner.accountId))).documents.some((d) => d.id === key));
    await f.close(); assert.equal(backend.clientsDisposed(), 1);
  });

}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10000;
  do { if (await check()) return; await delay(25); } while (Date.now() < deadline);
  assert.fail('runtime condition did not become true before the deadline');
}
