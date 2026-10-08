import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { fixture } from './support/service.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';

test('device flow honors early polls, slowdown, expiry and denial', async () => {
  const f = await fixture();
  try { const start = await f.start(); assert.equal(start.body.expiresIn, 900);
    const poll = () => f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    assert.equal((await poll()).status, 202); assert.equal(f.github.state.calls, 0);
    f.clock.now += 5000; f.github.state.exchange = { type: 'slow-down' };
    assert.deepEqual(await (await poll()).json(), { interval: 10 });
    f.clock.now += 900000; assert.equal((await poll()).status, 410);
    const denied = await f.start(); f.clock.now += 5000; f.github.state.exchange = { type: 'denied' };
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: denied.body.pendingId })).status, 410);
  } finally { await f.close(); }
});
test('concurrent single-use redemption and numeric identity races persist only hashes', async () => {
  const f = await fixture();
  try { const a = await f.start('A'); const b = await f.start('B'); f.clock.now += 5000;
    const poll = (id: string) => f.call('POST', '/v1/auth/device/poll', { pendingId: id });
    const responses = await Promise.all([poll(a.body.pendingId), poll(a.body.pendingId), poll(b.body.pendingId)]);
    assert.equal(responses.filter((r) => r.status === 200).length, 2);
    const results = await Promise.all(responses.filter((r) => r.status === 200).map((r) => r.json()));
    assert.equal(results[0].accountId, results[1].accountId); assert.equal(results[0].defaultPolicy, 'notify');
    const snapshot = await Effect.runPromise(f.store.readPartition('accounts', results[0].accountId));
    assert.equal(snapshot.documents.filter((d) => d.type === 'machine').length, 2);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_OAUTH|PRIVATE_DEVICE/);
    for (const result of results) assert.ok(!JSON.stringify(snapshot).includes(result.token));
    assert.equal((await poll(a.body.pendingId)).status, 410);
  } finally { await f.close(); }
});
test('signup allowlist is case insensitive and existing identity bypasses later closure', async () => {
  const memory = makeMemoryStore(); const first = await fixture({ store: memory, openSignup: false, allowlistedLogins: ['IHOR'] });
  let accountId: string;
  try { const login = await first.login(); assert.equal(login.response.status, 200); accountId = login.body.accountId; } finally { await first.close(); }
  const second = await fixture({ store: memory, openSignup: false });
  try { assert.equal((await second.login()).body.accountId, accountId!); second.github.state.user = { id: 100, login: 'Other' }; assert.equal((await second.login()).response.status, 403); } finally { await second.close(); }
});
test('uncertain machine commit cleans orphan without issuing duplicate credentials', async () => {
  const memory = makeMemoryStore(); let fail = true;
  const f = await fixture({ store: { ...memory, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
    const result = yield* memory.commitPartition(container, key, version, mutations);
    if (fail && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) { fail = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' })); }
    return result;
  }) } });
  try { const start = await f.start(); f.clock.now += 5000; const poll = () => f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    assert.equal((await poll()).status, 503); assert.equal((await poll()).status, 410);
    const identity = await Effect.runPromise(memory.readPartition('identities', 'github:42'));
    const accountId = identity.documents[0].type === 'identity' ? identity.documents[0].accountId : '';
    const account = await Effect.runPromise(memory.readPartition('accounts', accountId));
    assert.equal(account.documents.filter((d) => d.type === 'machine').length, 0);
  } finally { await f.close(); }
});

test('in-flight GitHub exchange is claimed before a concurrent poll can exchange', async () => {
  const f = await fixture();
  try { const start = await f.start(); f.clock.now += 5000; f.github.hold();
    const first = f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    while (f.github.state.calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const second = await f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    assert.equal(second.status, 410); assert.equal(f.github.state.calls, 1);
    f.github.release(); assert.equal((await first).status, 200);
  } finally { f.github.release(); await f.close(); }
});
test('pending outcome honors upstream deadline and interval without repeated exchange', async () => {
  const f = await fixture();
  try { f.github.state.expiresIn = 12; const start = await f.start(); assert.equal(start.body.expiresIn, 12);
    f.github.state.exchange = { type: 'pending' }; f.clock.now += 5000;
    const poll = () => f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    assert.equal((await poll()).status, 202); assert.equal((await poll()).status, 202); assert.equal(f.github.state.calls, 1);
    f.clock.now += 7000; assert.equal((await poll()).status, 410);
    assert.equal((await Effect.runPromise(f.store.readPartition('identities', `device:${start.body.pendingId}`))).documents.length, 0);
  } finally { await f.close(); }
});
test('expired in-flight exchange cannot register a machine or expose a token', async () => {
  const f = await fixture();
  try { const start = await f.start(); f.clock.now += 5000; f.github.hold();
    const poll = f.call('POST', '/v1/auth/device/poll', { pendingId: start.body.pendingId });
    while (f.github.state.calls === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    f.clock.now += 900000; f.github.release(); assert.equal((await poll).status, 410);
    assert.equal((await Effect.runPromise(f.store.readPartition('identities', 'github:42'))).documents.length, 0);
  } finally { f.github.release(); await f.close(); }
});
test('durable reserved identity recovers a failed account initialization', async () => {
  const memory = makeMemoryStore(); let fail = true;
  const f = await fixture({ store: { ...memory, commitPartition: (container, key, version, mutations) => {
    if (fail && mutations.some((m) => m.type === 'upsert' && m.document.type === 'account')) { fail = false; return Effect.fail(new ServiceFailure({ code: 'unavailable' })); }
    return memory.commitPartition(container,key,version,mutations);
  } } });
  try { assert.equal((await f.login()).response.status, 503);
    const before = await Effect.runPromise(memory.readPartition('identities','github:42'));
    assert.equal(before.documents[0].type === 'identity' && before.documents[0].state, 'reserved');
    const login = await f.login(); assert.equal(login.response.status, 200);
    assert.equal(before.documents[0].type === 'identity' && before.documents[0].accountId, login.body.accountId);
  } finally { await f.close(); }
});
test('later poll recovers expired claimed issuance after cleanup failure', async () => {
  const memory = makeMemoryStore(); let failMachine = true; let failCleanup = true;
  const f = await fixture({ store: { ...memory, commitPartition: (container, key, version, mutations) => Effect.gen(function* () {
    if (failCleanup && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) { failCleanup = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' })); }
    const result = yield* memory.commitPartition(container,key,version,mutations);
    if (failMachine && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) { failMachine = false; return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' })); }
    return result;
  }) } });
  try { const pending = await f.start(); f.clock.now += 5000; const poll = () => f.call('POST','/v1/auth/device/poll',{ pendingId: pending.body.pendingId });
    assert.equal((await poll()).status,503); f.clock.now += 900000; assert.equal((await poll()).status,410);
    const identity = await Effect.runPromise(memory.readPartition('identities','github:42'));
    const accountId = identity.documents[0].type === 'identity' ? identity.documents[0].accountId : '';
    const account = await Effect.runPromise(memory.readPartition('accounts', accountId));
    assert.ok(account.documents.filter((d) => d.type === 'machine').every((m) => m.type === 'machine' && m.tokenHash === null));
    assert.equal((await poll()).status,410);
  } finally { await f.close(); }
});

test('invalid upstream identity never creates an account or stores unsafe login data', async () => {
  const f = await fixture();
  try { f.github.state.user = { id: 42, login: 'bad\nPRIVATE' }; assert.equal((await f.login()).response.status,503);
    assert.equal((await Effect.runPromise(f.store.readPartition('identities','github:42'))).documents.length,0);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE/);
  } finally { await f.close(); }
});

test('interrupted claim recovery never inserts machine metadata into a deleting account', async () => {
  const memory = makeMemoryStore(); let failMachine = true; let failCleanup = true;
  const f = await fixture({ store: { ...memory, commitPartition: (container,key,version,mutations) => Effect.gen(function* () {
    if (failCleanup && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) { failCleanup = false; return yield* Effect.fail(new ServiceFailure({ code:'unavailable' })); }
    const result = yield* memory.commitPartition(container,key,version,mutations);
    if (failMachine && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) { failMachine = false; return yield* Effect.fail(new ServiceFailure({ code:'unavailable' })); }
    return result;
  }) } });
  try { const start = await f.start(); f.clock.now += 5000; const poll = () => f.call('POST','/v1/auth/device/poll',{ pendingId:start.body.pendingId });
    assert.equal((await poll()).status,503);
    const identity = await Effect.runPromise(memory.readPartition('identities','github:42'));
    assert.ok(identity.documents[0].type === 'identity'); const accountId = identity.documents[0].accountId;
    const snapshot = await Effect.runPromise(memory.readPartition('accounts',accountId)); const account = snapshot.documents.find((d) => d.type === 'account')!;
    await Effect.runPromise(memory.commitPartition('accounts',accountId,snapshot.version,[{ type:'upsert', document:{ ...account,state:'deleting' } },...snapshot.documents.filter((d) => d.type === 'machine').map((d) => ({ type:'delete' as const,id:d.id }))]));
    f.clock.now += 900000; assert.equal((await poll()).status,410);
    const after = await Effect.runPromise(memory.readPartition('accounts',accountId)); assert.ok(after.documents.every((d) => d.type !== 'machine'));
  } finally { await f.close(); }
});
