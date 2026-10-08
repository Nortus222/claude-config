import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeHosted, MachinesResponseSchema } from '@nortuscc/hosted-protocol';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';
import { fixture } from './support/service.ts';

test('machine patch, isolation, optout, forget and signout have explicit lifecycle', async () => {
  const f = await fixture();
  try { const a = (await f.login()).body; const b = (await f.login('B')).body;
    const patch = await f.call('PATCH', `/v1/machines/${a.machineId}`, { policy: 'manual', name: 'Renamed', reportStatus: false }, a.token);
    assert.equal(patch.status, 200); assert.equal((await patch.json()).status, null);
    assert.equal((await f.call('PATCH', `/v1/machines/${a.machineId}`, { status: { private: 'secret' } }, a.token)).status, 400);
    assert.equal((await f.call('DELETE', '/v1/machines/other-account', undefined, a.token)).status, 404);
    assert.equal((await f.call('DELETE', `/v1/machines/${b.machineId}`, undefined, a.token)).status, 204);
    assert.equal((await f.call('GET', '/v1/machines', undefined, b.token)).status, 401);
    const out = await f.call('POST', '/v1/auth/sign-out', undefined, a.token); assert.equal(out.status, 204); assert.equal(await out.text(), '');
    assert.equal((await f.call('GET', '/v1/machines', undefined, a.token)).status, 401);
    const snapshot = await Effect.runPromise(f.store.readPartition('accounts', a.accountId)); assert.ok(snapshot.documents.filter((d) => d.type === 'machine').every((d) => d.type !== 'machine' || d.tokenHash === null));
  } finally { await f.close(); }
});
test('machine token rate refill and lastSeen only updates each 300 seconds', async () => {
  const f = await fixture();
  try { const login = (await f.login()).body;
    for (let i = 0; i < 60; i++) assert.equal((await f.call('GET', '/v1/machines', undefined, login.token)).status, 200);
    const limited = await f.call('GET', '/v1/machines', undefined, login.token); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
    f.clock.now += 1000; assert.equal((await f.call('GET', '/v1/machines', undefined, login.token)).status, 200);
    f.clock.now += 300000; const machines = await (await f.call('GET', '/v1/machines', undefined, login.token)).json(); assert.equal(machines.machines[0].lastSeenAt, new Date(f.clock.now).toISOString());
    const bad = login.token.slice(0, -1) + (login.token.endsWith('A') ? 'B' : 'A'); assert.equal((await f.call('GET', '/v1/machines', undefined, bad)).status, 401);
  } finally { await f.close(); }
});
test('device starts bucket caps ten per IP and refills', async () => {
  const f = await fixture(); try { for (let i = 0; i < 10; i++) assert.equal((await f.start()).response.status, 200);
    const denied = (await f.start()).response; assert.equal(denied.status, 429); assert.ok(Number(denied.headers.get('retry-after')) > 0);
    f.clock.now += 360000; assert.equal((await f.start()).response.status, 200);
  } finally { await f.close(); }
});
test('25-machine account limit holds under concurrent registration and deleting accounts reject tokens', async () => {
  const f = await fixture(); try { const first = (await f.login()).body;
    for (let i = 0; i < 23; i++) { f.clock.now += 360000; assert.equal((await f.login()).response.status, 200); }
    f.clock.now += 360000; const a = await f.start('A'); const b = await f.start('B'); f.clock.now += 5000;
    const responses = await Promise.all([a,b].map((x) => f.call('POST', '/v1/auth/device/poll', { pendingId: x.body.pendingId })));
    assert.deepEqual(responses.map((r) => r.status).sort(), [200,409]);
    const snapshot = await Effect.runPromise(f.store.readPartition('accounts', first.accountId)); const account = snapshot.documents.find((d) => d.type === 'account')!;
    assert.ok(account.type === 'account'); await Effect.runPromise(f.store.commitPartition('accounts', first.accountId, snapshot.version, [{ type: 'upsert', document: { ...account, state: 'deleting' } }]));
    assert.equal((await f.call('GET', '/v1/machines', undefined, first.token)).status, 401); assert.equal((await f.login()).response.status, 401);
  } finally { await f.close(); }
});

test('report optout deletes an existing summary atomically and another account cannot patch a known machine', async () => {
  const f = await fixture();
  try { const owner = (await f.login()).body;
    const snapshot = await Effect.runPromise(f.store.readPartition('accounts',owner.accountId));
    await Effect.runPromise(f.store.commitPartition('accounts',owner.accountId,snapshot.version,[{ type:'upsert', document: {
      type:'status', version:1, id:`status:${owner.machineId}`, accountId:owner.accountId, machineId:owner.machineId,
      summary:{ reportedAt:new Date(f.clock.now).toISOString(), policy:'notify', agents:['codex'], setups:[], drift:{ setting:0,skill:0,integration:0,file:0 } },
    } }]));
    assert.notEqual((await (await f.call('GET','/v1/machines',undefined,owner.token)).json()).machines[0].status,null);
    assert.equal((await f.call('PATCH',`/v1/machines/${owner.machineId}`,{ reportStatus:false },owner.token)).status,200);
    const after = await Effect.runPromise(f.store.readPartition('accounts',owner.accountId)); assert.ok(after.documents.every((d) => d.type !== 'status'));
    f.github.state.user = { id:99, login:'Other' }; const stranger = (await f.login()).body;
    assert.equal((await f.call('PATCH',`/v1/machines/${owner.machineId}`,{ policy:'auto-apply' },stranger.token)).status,404);
    assert.equal((await f.call('DELETE',`/v1/machines/${owner.machineId}`,undefined,stranger.token)).status,404);
    const final = await (await f.call('GET','/v1/machines',undefined,owner.token)).json(); assert.equal(final.machines[0].policy,'notify');
  } finally { await f.close(); }
});
test('lastSeen does not write before its five-minute boundary', async () => {
  const f = await fixture();
  try { const login = (await f.login()).body; const before = await Effect.runPromise(f.store.readPartition('accounts',login.accountId));
    f.clock.now += 299999; await f.call('GET','/v1/machines',undefined,login.token);
    const after = await Effect.runPromise(f.store.readPartition('accounts',login.accountId)); assert.equal(after.version,before.version);
    f.clock.now++; await f.call('GET','/v1/machines',undefined,login.token);
    assert.notEqual((await Effect.runPromise(f.store.readPartition('accounts',login.accountId))).version,before.version);
  } finally { await f.close(); }
});

test('expired absent-machine recovery at the cap preserves a valid 25-machine public list', async () => {
  const memory = makeMemoryStore(); let failRegistration = false; let failCleanup = false;
  const f = await fixture({ store: { ...memory, commitPartition: (container,key,version,mutations) => {
    if (failRegistration && mutations.some((m) => m.type === 'upsert' && m.document.type === 'machine')) {
      failRegistration = false; return Effect.fail(new ServiceFailure({ code:'unavailable' }));
    }
    if (failCleanup && mutations.some((m) => m.type === 'delete' && m.id.startsWith('machine:'))) {
      failCleanup = false; return Effect.fail(new ServiceFailure({ code:'unavailable' }));
    }
    return memory.commitPartition(container,key,version,mutations);
  } } });
  try { const owner = (await f.login()).body; failRegistration = true; failCleanup = true;
    const pending = await f.start('Interrupted'); f.clock.now += 5000;
    const poll = () => f.call('POST','/v1/auth/device/poll',{ pendingId:pending.body.pendingId });
    assert.equal((await poll()).status,503);
    for (let i = 0; i < 24; i++) { f.clock.now += 360000; assert.equal((await f.login(`Machine ${i}`)).response.status,200); }
    assert.equal((await (await f.call('GET','/v1/machines',undefined,owner.token)).json()).machines.length,25);
    assert.equal((await poll()).status,410);
    const response = await f.call('GET','/v1/machines',undefined,owner.token); assert.equal(response.status,200);
    const result = decodeHosted(MachinesResponseSchema,await response.json()); assert.equal(result.machines.length,25);
    assert.ok(result.machines.every((machine) => machine.name !== 'Interrupted'));
  } finally { await f.close(); }
});
