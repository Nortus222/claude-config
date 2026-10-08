import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { recoverExpiredDeviceSession } from '../../src/auth.ts';
import type { DeviceSessionDocument } from '../../src/documents.ts';
import { ServiceFailure } from '../../src/errors.ts';
import { serviceContract, type ServiceStoreFactory } from './service-contract.ts';

export function registerExpiryContract(name: string, factory: ServiceStoreFactory) {
  const test = serviceContract(name, factory);
  test('expiry recovery checks the fresh persisted deadline and is idempotent', async ({ fixture, store }) => {
    const f = await fixture();
    try {
      f.github.state.expiresIn = 12;
      const start = await f.start(); const key = `device:${start.body.pendingId}`;
      const before = await Effect.runPromise(store.readPartition('identities', key));
      await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now + 11999));
      assert.deepEqual(await Effect.runPromise(store.readPartition('identities', key)), before);
      await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now + 12000));
      assert.equal((await Effect.runPromise(store.readPartition('identities', key))).version, null);
      await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now + 12000));
      assert.equal((await Effect.runPromise(store.readPartition('identities', 'github:42'))).version, null);
    } finally { await f.close(); }
  });

  test('expiry CAS retries a competing claim and retains its cleanup evidence', async ({ fixture, store: base }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      const start = await f.start(); const key = `device:${start.body.pendingId}`;
      let raced = false; let fenced: DeviceSessionDocument | undefined;
      const store = { ...base, commitPartition: (container, id, version, mutations) => Effect.gen(function* () {
        const expired = mutations.find((m) => m.type === 'upsert' && m.document.type === 'deviceSession' && m.document.state === 'expired');
        if (expired?.type === 'upsert' && expired.document.type === 'deviceSession') {
          fenced = expired.document;
          if (!raced) {
            raced = true;
            const current = yield* base.readPartition('identities', key);
            const session = current.documents[0] as DeviceSessionDocument;
            yield* base.commitPartition('identities', key, current.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
              claim: { claimId: 'raced', accountId: owner.accountId, machineId: 'delayed', tokenHash: 'hash', claimedAt: f.clock.now } } }]);
          }
        }
        return yield* base.commitPartition(container, id, version, mutations);
      }) } satisfies typeof base;
      f.clock.now += 900000;
      await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now));
      assert.equal(fenced?.claim?.claimId, 'raced');
      const account = await Effect.runPromise(base.readPartition('accounts', owner.accountId));
      assert.ok(account.documents.some((d) => d.type === 'issuanceFence' && d.machineId === 'delayed'));
      assert.equal((await Effect.runPromise(base.readPartition('identities', key))).version, null);
    } finally { await f.close(); }
  });

  test('expired state survives cleanup failure and a fresh backend resumes it', async ({ fixture, store: base, restartStore }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      const start = await f.start(); const key = `device:${start.body.pendingId}`;
      const before = await Effect.runPromise(base.readPartition('identities', key));
      const session = before.documents[0] as DeviceSessionDocument;
      await Effect.runPromise(base.commitPartition('identities', key, before.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
        claim: { claimId: 'interrupted', accountId: owner.accountId, machineId: 'orphan', tokenHash: 'hash', claimedAt: f.clock.now } } }]));
      f.clock.now += 900000;
      const fail = { ...base, commitPartition: (container, id, version, mutations) => container === 'accounts'
        ? Effect.fail(new ServiceFailure({ code: 'unavailable' })) : base.commitPartition(container, id, version, mutations) } satisfies typeof base;
      const result = await Effect.runPromise(Effect.result(recoverExpiredDeviceSession(fail, key, f.clock.now)));
      assert.equal(result._tag, 'Failure');
      const interrupted = await Effect.runPromise(base.readPartition('identities', key));
      assert.equal((interrupted.documents[0] as DeviceSessionDocument).state, 'expired');
      assert.equal((interrupted.documents[0] as DeviceSessionDocument).claim?.claimId, 'interrupted');
      await Effect.runPromise(recoverExpiredDeviceSession(await restartStore(), key, f.clock.now));
      assert.equal((await Effect.runPromise(base.readPartition('identities', key))).version, null);
      const account = await Effect.runPromise(base.readPartition('accounts', owner.accountId));
      assert.ok(account.documents.some((d) => d.type === 'issuanceFence' && d.machineId === 'orphan'));
    } finally { await f.close(); }
  });

  test('expiry fencing rejects delayed claim attachment and pending reset using old versions', async ({ fixture, store }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      for (const state of ['pending', 'claimed'] as const) {
        const start = await f.start(); const key = `device:${start.body.pendingId}`;
        const before = await Effect.runPromise(store.readPartition('identities', key));
        const session = before.documents[0] as DeviceSessionDocument;
        f.clock.now += 900000;
        await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now));
        assert.equal(await Effect.runPromise(store.commitPartition('identities', key, before.version, [{ type: 'upsert', document: {
          ...session, state, claim: state === 'claimed' ? { claimId: 'delayed', accountId: owner.accountId, machineId: 'delayed', tokenHash: 'hash', claimedAt: session.createdAt } : null,
        } }])), false);
        assert.equal((await Effect.runPromise(store.readPartition('identities', key))).version, null);
      }
    } finally { await f.close(); }
  });

  test('expiry CAS conflicts have a bounded retry budget', async ({ fixture, store: base }) => {
    const f = await fixture();
    try {
      const start = await f.start(); const key = `device:${start.body.pendingId}`; f.clock.now += 900000;
      let attempts = 0;
      const store = { ...base, commitPartition: () => { attempts++; return Effect.succeed(false); } };
      const result = await Effect.runPromise(Effect.result(recoverExpiredDeviceSession(store, key, f.clock.now)));
      assert.equal(result._tag, 'Failure');
      if (result._tag === 'Failure') assert.equal(result.failure.code, 'unavailable');
      assert.equal(attempts, 32);
    } finally { await f.close(); }
  });

  test('expiry keeps the account reservation until session deletion succeeds', async ({ fixture, store: base, restartStore }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body; const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
      const snapshot = await Effect.runPromise(base.readPartition('identities', key));
      const session = snapshot.documents[0] as DeviceSessionDocument;
      await Effect.runPromise(base.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
        claim: { claimId: 'interrupted', accountId: owner.accountId, machineId: 'orphan', tokenHash: 'hash', claimedAt: f.clock.now } } }]));
      const account = await Effect.runPromise(base.readPartition('accounts', owner.accountId));
      await Effect.runPromise(base.commitPartition('accounts', owner.accountId, account.version, [{ type: 'upsert', document: {
        type: 'deviceReservation', version: 1, id: key, accountId: owner.accountId, sessionId: key,
      } }]));
      f.clock.now += 900000;
      const failing = { ...base, commitPartition: (container, id, version, mutations) => container === 'identities' && mutations.some((m) => m.type === 'delete')
        ? Effect.fail(new ServiceFailure({ code: 'unavailable' })) : base.commitPartition(container, id, version, mutations) } satisfies typeof base;
      const result = await Effect.runPromise(Effect.result(recoverExpiredDeviceSession(failing, key, f.clock.now)));
      assert.equal(result._tag, 'Failure');
      assert.ok((await Effect.runPromise(base.readPartition('accounts', owner.accountId))).documents.some((d) => d.id === key));
      assert.equal((await Effect.runPromise(base.readPartition('identities', key))).documents.length, 1);
      await Effect.runPromise(recoverExpiredDeviceSession(await restartStore(), key, f.clock.now));
      assert.equal((await Effect.runPromise(base.readPartition('identities', key))).version, null);
      assert.ok(!(await Effect.runPromise(base.readPartition('accounts', owner.accountId))).documents.some((d) => d.id === key));
    } finally { await f.close(); }
  });

  for (const closed of [false, true]) {
    test(`expiry removes machine credentials from a ${closed ? 'closed' : 'deleting'} account without adding a fence`, async ({ fixture, store }) => {
      const f = await fixture();
      try {
        const owner = (await f.login()).body; const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
        const sessionSnapshot = await Effect.runPromise(store.readPartition('identities', key));
        const session = sessionSnapshot.documents[0] as DeviceSessionDocument;
        const accountSnapshot = await Effect.runPromise(store.readPartition('accounts', owner.accountId));
        const account = accountSnapshot.documents.find((d) => d.type === 'account')!;
        const machine = accountSnapshot.documents.find((d) => d.type === 'machine')!;
        assert.ok(machine.type === 'machine');
        await Effect.runPromise(store.commitPartition('identities', key, sessionSnapshot.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
          claim: { claimId: 'deleting', accountId: owner.accountId, machineId: machine.machineId, tokenHash: machine.tokenHash!, claimedAt: f.clock.now } } }]));
        await Effect.runPromise(store.commitPartition('accounts', owner.accountId, accountSnapshot.version, [{ type: 'upsert', document: {
          ...account, state: 'deleting', deletion: { startedAt: new Date(f.clock.now).toISOString(), remainingSetupIds: [] },
        } }, { type: 'upsert', document: { type: 'deviceReservation', version: 1, id: key, accountId: owner.accountId, sessionId: key } }]));
        if (closed) {
          const current = await Effect.runPromise(store.readPartition('accounts', owner.accountId));
          await Effect.runPromise(store.closePartition('accounts', owner.accountId, current.version));
        }
        f.clock.now += 900000;
        await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now));
        const after = await Effect.runPromise(store.readPartition('accounts', owner.accountId));
        assert.equal(after.closed, closed);
        assert.ok(after.documents.every((d) => d.type !== 'machine' && d.type !== 'issuanceFence'));
        assert.ok(after.documents.some((d) => d.type === 'deviceReservation' && d.sessionId === key), 'deletion retains its frozen index');
        assert.equal((await Effect.runPromise(store.readPartition('identities', key))).version, null);
      } finally { await f.close(); }
    });
  }

  test('expiry recovery never recreates an absent closed account', async ({ fixture, store }) => {
    const f = await fixture();
    try {
      const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
      const before = await Effect.runPromise(store.readPartition('identities', key));
      const session = before.documents[0] as DeviceSessionDocument;
      await Effect.runPromise(store.closePartition('accounts', 'deleted-account', null));
      const closed = await Effect.runPromise(store.readPartition('accounts', 'deleted-account'));
      await Effect.runPromise(store.commitPartition('identities', key, before.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
        claim: { claimId: 'late', accountId: 'deleted-account', machineId: 'late', tokenHash: 'hash', claimedAt: f.clock.now } } }]));
      f.clock.now += 900000;
      await Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now));
      assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'deleted-account')), closed);
      assert.equal((await Effect.runPromise(store.readPartition('identities', key))).version, null);
    } finally { await f.close(); }
  });

  test('concurrent expiry workers converge without recreating a session or machine', async ({ fixture, store }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body; const pending = await f.start(); const key = `device:${pending.body.pendingId}`;
      const snapshot = await Effect.runPromise(store.readPartition('identities', key));
      const session = snapshot.documents[0] as DeviceSessionDocument;
      await Effect.runPromise(store.commitPartition('identities', key, snapshot.version, [{ type: 'upsert', document: { ...session, state: 'claimed',
        claim: { claimId: 'concurrent', accountId: owner.accountId, machineId: 'orphan', tokenHash: 'hash', claimedAt: f.clock.now } } }]));
      f.clock.now += 900000;
      await Promise.all(Array.from({ length: 3 }, () => Effect.runPromise(recoverExpiredDeviceSession(store, key, f.clock.now))));
      const account = await Effect.runPromise(store.readPartition('accounts', owner.accountId));
      assert.equal(account.documents.filter((d) => d.type === 'machine').length, 1);
      assert.equal(account.documents.filter((d) => d.type === 'issuanceFence' && d.machineId === 'orphan').length, 1);
      assert.equal((await Effect.runPromise(store.readPartition('identities', key))).version, null);
    } finally { await f.close(); }
  });

  test('an issuer with an earlier clock observes the expired CAS before delivering a token', async ({ fixture, store: base, restartStore }) => {
    let pause = false;
    let issuerEntered!: () => void; const issued = new Promise<void>((resolve) => { issuerEntered = resolve; });
    let releaseIssuer!: () => void; const issuerBarrier = new Promise<void>((resolve) => { releaseIssuer = resolve; });
    const issuer = { ...base, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
      const result = yield* base.commitPartition(container, key, version, mutations);
      if (pause && result && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) {
        pause = false; issuerEntered(); yield* Effect.promise(() => issuerBarrier);
      }
      return result;
    }) } satisfies typeof base;
    const f = await fixture({ store: issuer });
    let releaseCleanup!: () => void; const cleanupBarrier = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupEntered!: () => void; const expired = new Promise<void>((resolve) => { cleanupEntered = resolve; });
    let issuance: Promise<Response> | undefined; let recovery: Promise<void> | undefined;
    try {
      const owner = (await f.login()).body; const pending = await f.start(); f.clock.now += 5000;
      pause = true;
      issuance = f.call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId });
      await issued;
      const restarted = await restartStore(); let hold = true;
      const sweeper = { ...restarted, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
        if (hold && container === 'accounts' && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) {
          hold = false; cleanupEntered(); yield* Effect.promise(() => cleanupBarrier);
        }
        return yield* restarted.commitPartition(container, key, version, mutations);
      }) } satisfies typeof base;
      recovery = Effect.runPromise(recoverExpiredDeviceSession(sweeper, `device:${pending.body.pendingId}`, f.clock.now + 900000));
      await expired; releaseIssuer();
      const response = await issuance;
      assert.equal(response.status, 410); assert.ok(!('token' in await response.json()));
      releaseCleanup(); await recovery;
      const account = await Effect.runPromise(base.readPartition('accounts', owner.accountId));
      assert.equal(account.documents.filter((d) => d.type === 'machine').length, 1);
      assert.equal((await Effect.runPromise(base.readPartition('identities', `device:${pending.body.pendingId}`))).version, null);
    } finally { releaseIssuer(); releaseCleanup(); await issuance; await recovery; await f.close(); }
  });
}
