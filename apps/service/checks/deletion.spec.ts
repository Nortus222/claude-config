import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';
import type { Store } from '../src/store.ts';
import { fixture } from './support/service.ts';
import { setup, publish, publication } from './support/metadata.ts';

const run = Effect.runPromise;
const unavailable = () => Effect.fail(new ServiceFailure({ code:'unavailable' }));
async function assertClosed(store: Store['Service'], container: 'accounts' | 'setups', key: string) {
  const snapshot = await run(store.readPartition(container,key));
  assert.equal(snapshot.closed,true); assert.notEqual(snapshot.version,null); assert.deepEqual(snapshot.documents,[]);
}
async function seedMany(store: Store['Service'], accountId: string) {
  for (let start = 0; start < 205; start += 99) {
    const snapshot = await run(store.readPartition('accounts',accountId));
    await run(store.commitPartition('accounts',accountId,snapshot.version,Array.from({ length:Math.min(99,205-start) },(_,i) => ({ type:'upsert' as const,document:{ type:'issuanceFence' as const,version:1 as const,id:`issuance:${start+i}`,accountId,machineId:`old-${start+i}` } }))));
  }
}

test('account deletion erases indexed metadata, revokes every token and permits a fresh identity', async () => {
  const f = await fixture(); try {
    const owner = (await f.login()).body; const second = (await f.login()).body;
    const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    await seedMany(f.store,owner.accountId);
    const result = await f.call('DELETE','/v1/account',undefined,owner.token);
    assert.equal(result.status,204); assert.equal(await result.text(),'');
    await assertClosed(f.store,'accounts',owner.accountId); await assertClosed(f.store,'setups',s.setupId);
    assert.deepEqual((await run(f.store.readPartition('identities','github:42'))).documents,[]);
    for (const token of [owner.token,second.token]) for (const path of ['/v1/sync','/v1/account/export','/v1/machines']) assert.equal((await f.call('GET',path,undefined,token)).status,401);
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,401);
    const fresh = await f.login(); assert.equal(fresh.response.status,200); assert.notEqual(fresh.body.accountId,owner.accountId);
    assert.deepEqual((await (await f.call('GET','/v1/account/export',undefined,fresh.body.token)).json()).setups,[]);
    assert.doesNotMatch(JSON.stringify(f.diagnostics),new RegExp(`${owner.token}|${owner.accountId}|${s.setupId}|closed|tokenHash|repoUrl`));
  } finally { await f.close(); }
});

for (const stage of ['setup-close','setup-sweep','identity','account-sweep','account-close'] as const) test(`deletion retries after ${stage} commit and restart beyond the lastSeen threshold`, async () => {
  const memory = makeMemoryStore(); let armed = false; let failed = false;
  const store: Store['Service'] = { ...memory,
    closePartition:(c,k,v) => memory.closePartition(c,k,v).pipe(Effect.flatMap((ok) => {
      if (ok && armed && !failed && ((stage === 'setup-close' && c === 'setups') || (stage === 'account-close' && c === 'accounts'))) { failed = true; return unavailable(); }
      return Effect.succeed(ok);
    })),
    commitPartition:(c,k,v,m) => memory.commitPartition(c,k,v,m).pipe(Effect.flatMap((ok) => {
      if (ok && armed && !failed && ((stage === 'setup-sweep' && c === 'setups' && m.every((x) => x.type === 'delete')) || (stage === 'identity' && c === 'identities' && k.startsWith('github:') && m.some((x) => x.type === 'upsert' && x.document.type === 'identity' && x.document.state === 'deleting')) || (stage === 'account-sweep' && c === 'accounts' && m.length === 99 && m.every((x) => x.type === 'delete')))) { failed = true; return unavailable(); }
      return Effect.succeed(ok);
    })),
  };
  const f = await fixture({ store }); const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); await seedMany(store,owner.accountId);
  try {
    armed = true; assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,503); assert.equal(failed,true);
    const snapshot = await run(memory.readPartition('accounts',owner.accountId));
    const account = snapshot.documents.find((d) => d.type === 'account'); assert.equal(account?.state,'deleting'); assert.ok(account?.deletion?.remainingSetupIds.includes(s.setupId));
    assert.ok(snapshot.documents.some((d) => d.type === 'machine' && d.tokenHash));
    assert.equal((await f.call('GET','/v1/account/export',undefined,owner.token)).status,401);
    assert.equal((await f.login()).response.status,401,'fresh signup stays blocked while any old account metadata remains');
  } finally { await f.close(); }
  const restarted = await fixture({ store:memory }); try {
    restarted.clock.now += 1000000;
    assert.equal((await restarted.call('DELETE','/v1/account?accountId=other',undefined,owner.token)).status,400);
    assert.equal((await restarted.call('DELETE','/v1/account',{ accountId:owner.accountId },owner.token)).status,400);
    assert.equal((await restarted.call('DELETE','/v1/account',undefined,owner.token.slice(0,-1)+(owner.token.endsWith('A')?'B':'A'))).status,401);
    assert.equal((await restarted.call('PATCH',`/v1/machines/${owner.machineId}`,{ name:'Changed' },owner.token)).status,401);
    assert.equal((await restarted.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    await assertClosed(memory,'accounts',owner.accountId); await assertClosed(memory,'setups',s.setupId);
  } finally { await restarted.close(); }
});

function barrier() {
  let enter!: () => void; let release!: () => void;
  return { entered:new Promise<void>((resolve) => { enter = resolve; }), gate:new Promise<void>((resolve) => { release = resolve; }), enter:() => enter(), release:() => release() };
}

for (const phase of ['setup-initializer','publisher','reservation','account-initializer','issuance'] as const) test(`paused ${phase} cannot resurrect deleted metadata or interfere with a fresh sign-in`, async () => {
  const memory = makeMemoryStore(); const held = barrier(); let armed = false; let paused = false; let oldSetupId: string | undefined;
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => {
    const match = phase === 'setup-initializer' ? c === 'setups' && v === null : phase === 'publisher' ? m.some((x) => x.type === 'upsert' && x.document.type === 'revision') : phase === 'reservation' ? m.some((x) => x.type === 'upsert' && x.document.type === 'account' && x.document.setups.some((s) => s.state === 'reserved')) : phase === 'account-initializer' ? c === 'accounts' && v === null : m.some((x) => x.type === 'upsert' && x.document.type === 'machine');
    if (armed && !paused && match) {
      paused = true; if (c === 'setups') oldSetupId = k;
      const reservation = m.find((x) => x.type === 'upsert' && x.document.type === 'account');
      if (phase === 'reservation' && reservation?.type === 'upsert' && reservation.document.type === 'account') oldSetupId = reservation.document.setups[0]!.setupId;
      held.enter();
      return Effect.gen(function* () { yield* Effect.promise(() => held.gate); const result = yield* memory.commitPartition(c,k,v,m);
        // Simulate a crash after the delayed commit, before any post-write compensation.
        if (phase === 'setup-initializer') return yield* unavailable();
        return result;
      });
    }
    return memory.commitPartition(c,k,v,m);
  } };
  const f = await fixture({ store }); let pending: Promise<Response> | undefined;
  try {
    let owner: { accountId:string; token:string };
    if (phase === 'account-initializer') {
      const start = await f.start(); f.clock.now += 5000; armed = true;
      pending = f.call('POST','/v1/auth/device/poll',{ pendingId:start.body.pendingId });
      await Promise.race([held.entered,pending.then(() => assert.fail('initializer must pause'))]);
      owner = (await f.login()).body;
    } else {
      owner = (await f.login()).body;
      if (phase === 'publisher') { const s = await setup(f,owner.token); oldSetupId = s.setupId; }
      let pendingId: string | undefined;
      if (phase === 'issuance') { pendingId = (await f.start()).body.pendingId; f.clock.now += 5000; }
      armed = true;
      pending = phase === 'publisher' ? f.call('POST',`/v1/setups/${oldSetupId}/revisions`,publication(1),owner.token) : phase === 'issuance' ? f.call('POST','/v1/auth/device/poll',{ pendingId }) : f.call('POST','/v1/setups',{ name:'Paused',repoUrl:'https://github.com/a/b' },owner.token);
      await Promise.race([held.entered,pending.then(() => assert.fail('writer must pause'))]);
    }
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    const fresh = await f.login(); assert.equal(fresh.response.status,200); assert.notEqual(fresh.body.accountId,owner.accountId);
    held.release(); const response = await pending; assert.ok([401,404,503].includes(response.status),String(response.status));
    await assertClosed(memory,'accounts',owner.accountId);
    if (oldSetupId) {
      if (phase === 'reservation') assert.deepEqual(await run(memory.readPartition('setups',oldSetupId)),{ version:null,closed:false,documents:[] });
      else await assertClosed(memory,'setups',oldSetupId);
    }
    const identity = (await run(memory.readPartition('identities','github:42'))).documents[0];
    assert.ok(identity?.type === 'identity'); assert.equal(identity.accountId,fresh.body.accountId);
    assert.equal((await f.call('GET','/v1/machines',undefined,fresh.body.token)).status,200);
  } finally { held.release(); await pending; await f.close(); }
});

test('stale conditional identity cleanup cannot delete the mapping from a fresh login', async () => {
  const memory = makeMemoryStore(); const held = barrier(); let armed = false; let paused = false;
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => {
    if (armed && !paused && c === 'identities' && k === 'github:42' && m.every((x) => x.type === 'delete')) { paused = true; held.enter(); return Effect.promise(() => held.gate).pipe(Effect.andThen(memory.commitPartition(c,k,v,m))); }
    return memory.commitPartition(c,k,v,m);
  } };
  const f = await fixture({ store }); let pending: Promise<Response> | undefined;
  try {
    const owner = (await f.login()).body; armed = true;
    pending = f.call('DELETE','/v1/account',undefined,owner.token);
    await Promise.race([held.entered,pending.then(() => assert.fail('cleanup must pause'))]);
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,401);
    const fresh = await f.login(); assert.equal(fresh.response.status,200);
    held.release(); assert.equal((await pending).status,204);
    const identity = (await run(memory.readPartition('identities','github:42'))).documents[0];
    assert.ok(identity?.type === 'identity'); assert.equal(identity.accountId,fresh.body.accountId);
    await assertClosed(memory,'accounts',owner.accountId);
  } finally { held.release(); await pending; await f.close(); }
});

for (const stage of ['final-account-sweep','identity-removal'] as const) test(`a crash after ${stage} leaves no hashes and verified GitHub sign-in recovers after restart`, async () => {
  const memory = makeMemoryStore(); let armed = false; let failed = false;
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => memory.commitPartition(c,k,v,m).pipe(Effect.flatMap((ok) => {
    const match = stage === 'final-account-sweep' ? c === 'accounts' && m.some((x) => x.type === 'delete' && x.id === 'account') : c === 'identities' && k === 'github:42' && m.every((x) => x.type === 'delete');
    if (armed && !failed && ok && match) { failed = true; return unavailable(); } return Effect.succeed(ok);
  })) };
  const f = await fixture({ store }); const owner = (await f.login()).body; const s = await setup(f,owner.token);
  try { armed = true; assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,503); assert.equal(failed,true); }
  finally { await f.close(); }
  const restarted = await fixture({ store:memory }); try {
    restarted.clock.now += 1000000;
    await assertClosed(memory,'accounts',owner.accountId); await assertClosed(memory,'setups',s.setupId);
    assert.equal((await restarted.call('DELETE','/v1/account',undefined,owner.token)).status,401);
    const fresh = await restarted.login(); assert.equal(fresh.response.status,200); assert.notEqual(fresh.body.accountId,owner.accountId);
    const exported = await (await restarted.call('GET','/v1/account/export',undefined,fresh.body.token)).json();
    assert.deepEqual(exported.setups,[]); assert.deepEqual(exported.decisions,[]); assert.equal(exported.machines.length,1);
  } finally { await restarted.close(); }
});

test('deletion-only retries keep ordinary rate limits while setup cleanup is unavailable', async () => {
  const memory = makeMemoryStore(); let armed = false;
  const store: Store['Service'] = { ...memory,closePartition:(c,k,v) => armed && c === 'setups' ? unavailable() : memory.closePartition(c,k,v) };
  const f = await fixture({ store }); try {
    const owner = (await f.login()).body; await setup(f,owner.token); f.clock.now += 60000; armed = true;
    for (let i = 0; i < 60; i++) assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,503);
    const limited = await f.call('DELETE','/v1/account',undefined,owner.token); assert.equal(limited.status,429); assert.ok(limited.headers.get('retry-after'));
    f.clock.now += 1000000; armed = false;
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
  } finally { await f.close(); }
});

test('unassociated device sessions have a 900-second validity bound and are physically removed on expiry polling', async () => {
  const f = await fixture(); try {
    const owner = (await f.login()).body; const pending = await f.start();
    assert.equal(pending.body.expiresIn,900);
    const key = `device:${pending.body.pendingId}`;
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    assert.equal((await run(f.store.readPartition('identities',key))).documents.length,1,'no account-wide device enumeration exists');
    f.clock.now += 900000;
    assert.equal((await f.call('POST','/v1/auth/device/poll',{ pendingId:pending.body.pendingId })).status,410);
    assert.deepEqual(await run(f.store.readPartition('identities',key)),{ version:null,closed:false,documents:[] });
  } finally { await f.close(); }
});

for (const phase of ['claim','claimed-machine'] as const) test(`deletion erases the indexed ${phase} session before acknowledging, including delayed claim writes`, async () => {
  const memory = makeMemoryStore(); const held = barrier(); let armed = false; let paused = false;
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => {
    const match = phase === 'claim' ? m.some((x) => x.type === 'upsert' && x.document.type === 'deviceSession' && x.document.claim !== null) : m.some((x) => x.type === 'upsert' && x.document.type === 'machine');
    if (armed && !paused && match) { paused = true; held.enter(); return Effect.gen(function* () {
      yield* Effect.promise(() => held.gate);
      yield* memory.commitPartition(c,k,v,m);
      // Crash before cleanup, so the delete response itself must have erased the session.
      return yield* unavailable();
    }); }
    return memory.commitPartition(c,k,v,m);
  } };
  const f = await fixture({ store }); let pending: Promise<Response> | undefined;
  try {
    const owner = (await f.login()).body; const started = await f.start(); f.clock.now += 5000; armed = true;
    const key = `device:${started.body.pendingId}`;
    pending = f.call('POST','/v1/auth/device/poll',{ pendingId:started.body.pendingId });
    await Promise.race([held.entered,pending.then(() => assert.fail('claim must pause'))]);
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    assert.deepEqual((await run(memory.readPartition('identities',key))).documents,[],'known sessions must already be physically absent before a delayed worker resumes');
    const fresh = await f.login(); assert.equal(fresh.response.status,200);
    held.release(); assert.notEqual((await pending).status,200);
    assert.deepEqual((await run(memory.readPartition('identities',key))).documents,[]);
    await assertClosed(memory,'accounts',owner.accountId);
  } finally { held.release(); await pending; await f.close(); }
});

test('a crash after indexed session removal keeps its durable index and deletion credentials for restart', async () => {
  const memory = makeMemoryStore(); const held = barrier(); let paused = false; let armed = false; let failed = false;
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => {
    if (armed && !paused && m.some((x) => x.type === 'upsert' && x.document.type === 'machine')) { paused = true; held.enter(); return Effect.promise(() => held.gate).pipe(Effect.andThen(memory.commitPartition(c,k,v,m))); }
    return memory.commitPartition(c,k,v,m).pipe(Effect.flatMap((ok) => {
      if (armed && paused && !failed && ok && c === 'identities' && k.startsWith('device:') && m.every((x) => x.type === 'delete')) { failed = true; return unavailable(); }
      return Effect.succeed(ok);
    }));
  } };
  const f = await fixture({ store }); let pending: Promise<Response> | undefined;
  try {
    const owner = (await f.login()).body; const started = await f.start(); f.clock.now += 5000; armed = true;
    const key = `device:${started.body.pendingId}`;
    pending = f.call('POST','/v1/auth/device/poll',{ pendingId:started.body.pendingId });
    await Promise.race([held.entered,pending.then(() => assert.fail('issuance must pause'))]);
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,503); assert.equal(failed,true);
    assert.deepEqual((await run(memory.readPartition('identities',key))).documents,[]);
    assert.ok((await run(memory.readPartition('accounts',owner.accountId))).documents.some((d) => d.type === 'deviceReservation' && d.sessionId === key));
    const restarted = await fixture({ store:memory }); try {
      restarted.clock.now += 1000000;
      assert.equal((await restarted.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    } finally { await restarted.close(); }
    held.release(); assert.notEqual((await pending).status,200);
    await assertClosed(memory,'accounts',owner.accountId);
  } finally { held.release(); await pending; await f.close(); }
});

test('deletion reads every indexed device session and sweeps large setup/account partitions in 99-target batches', async () => {
  const memory = makeMemoryStore(); let armed = false; const batches: number[] = [];
  const store: Store['Service'] = { ...memory,commitPartition:(c,k,v,m) => {
    if (armed) { batches.push(m.length); assert.ok(m.length <= 99); }
    return memory.commitPartition(c,k,v,m);
  } };
  const f = await fixture({ store }); try {
    const owner = (await f.login()).body; const s = await setup(f,owner.token); const revision = await publish(f,owner.token,s.setupId,1);
    await seedMany(store,owner.accountId);
    for (let i = 0; i < 105; i++) {
      const key = `device:bulk-${i}`;
      await run(store.commitPartition('identities',key,null,[{ type:'upsert',document:{ type:'deviceSession',version:1,id:key,pendingId:`bulk-${i}`,deviceCode:'temporary-credential',description:{ name:'Pending',os:'linux',agents:[] },createdAt:f.clock.now,expiresAt:f.clock.now+900000,interval:5,nextPollAt:f.clock.now+5000,state:'claimed',claim:{ claimId:`claim-${i}`,accountId:owner.accountId,machineId:`pending-${i}`,tokenHash:'a'.repeat(64),claimedAt:f.clock.now } } }]));
      const account = await run(store.readPartition('accounts',owner.accountId));
      await run(store.commitPartition('accounts',owner.accountId,account.version,[{ type:'upsert',document:{ type:'deviceReservation',version:1,id:key,accountId:owner.accountId,sessionId:key } }]));
    }
    for (let start = 2; start <= 205; start += 99) {
      const snapshot = await run(store.readPartition('setups',s.setupId));
      await run(store.commitPartition('setups',s.setupId,snapshot.version,Array.from({ length:Math.min(99,206-start) },(_,i) => ({ type:'upsert' as const,document:{ ...revision,type:'revision' as const,version:1 as const,id:`revision:${start+i}`,number:start+i } }))));
    }
    armed = true;
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
    assert.ok(batches.filter((size) => size === 99).length >= 5);
    await assertClosed(memory,'accounts',owner.accountId); await assertClosed(memory,'setups',s.setupId);
    for (let i = 0; i < 105; i++) assert.deepEqual((await run(memory.readPartition('identities',`device:bulk-${i}`))).documents,[]);
  } finally { await f.close(); }
});
