import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeHosted, SyncResponseSchema } from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { setup, publish } from './support/metadata.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import type { PartitionSnapshot } from '../src/store.ts';

test('sync is complete above fifty, cursors are independent, and conditional state is query-relative', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    for (let n = 1; n <= 51; n++) await publish(f,owner.token,s.setupId,n);
    const all = await f.call('GET','/v1/sync',undefined,owner.token); assert.equal(all.status,200); const body = decodeHosted(SyncResponseSchema,await all.json()); assert.equal(body.revisions.length,51); assert.equal(body.setups[0].latestRevision,51);
    const query = `/v1/sync?since=${body.seq}&setups=${s.setupId}%3A50`;
    const tail = decodeHosted(SyncResponseSchema,await (await f.call('GET',query,undefined,owner.token)).json()); assert.deepEqual(tail.revisions.map((r) => r.number),[51]); assert.equal(tail.decisions.length,0);
    const etag = all.headers.get('etag')!; assert.ok(etag); assert.equal((await f.raw(Buffer.alloc(0),'/v1/sync','GET',{ authorization:`Bearer ${owner.token}`,'if-none-match':etag })).status,304);
    for (const q of ['since=999','setups=unknown:0',`setups=${s.setupId}:52`,'since=01','since=1&since=2','secret=PRIVATE']) assert.equal((await f.call('GET',`/v1/sync?${q}`,undefined,owner.token)).status,q === 'setups=unknown:0' ? 404 : 400);
    await f.call('PATCH',`/v1/machines/${owner.machineId}`,{ policy:'manual' },owner.token);
    assert.equal((await f.raw(Buffer.alloc(0),'/v1/sync','GET',{ authorization:`Bearer ${owner.token}`,'if-none-match':etag })).status,200);
    assert.doesNotMatch(JSON.stringify(f.diagnostics),/PRIVATE/);
  } finally { await f.close(); }
});
test('sync returns account seq from the same snapshot as decisions during a concurrent write', async () => {
  const memory = makeMemoryStore(); let pause = false; let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve); const started = new Promise<void>((resolve) => entered = resolve);
  const f = await fixture({ store:{ ...memory,readPartition:(c,k) => pause && c === 'setups' ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* memory.readPartition(c,k); }) : memory.readPartition(c,k) } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    const before = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); pause = true;
    const syncing = f.call('GET','/v1/sync',undefined,owner.token); await started;
    const write = await f.call('PUT','/v1/decisions',{ decisions:[{ setupId:s.setupId,itemId:'file:claude:CLAUDE.md',revision:1,decision:'skip' }] },owner.token); assert.equal(write.status,200); release();
    const raced = decodeHosted(SyncResponseSchema,await (await syncing).json()); assert.equal(raced.seq,before.seq); assert.equal(raced.decisions.length,0);
    const next = decodeHosted(SyncResponseSchema,await (await f.call('GET',`/v1/sync?since=${raced.seq}`,undefined,owner.token)).json()); assert.equal(next.decisions.length,1); assert.ok(next.seq > raced.seq);
  } finally { release(); await f.close(); }
});
test('sync fails generically if an adapter supplies a head older than its account decisions', async () => {
  const memory = makeMemoryStore(); let stale = false; let old: PartitionSnapshot;
  const f = await fixture({ store:{ ...memory,readPartition:(c,k) => stale && c === 'setups' ? Effect.succeed(old) : memory.readPartition(c,k) } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); old = await Effect.runPromise(memory.readPartition('setups',s.setupId)); await publish(f,owner.token,s.setupId,2);
    assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[{ setupId:s.setupId,itemId:'file:claude:CLAUDE.md',revision:2,decision:'skip' }] },owner.token)).status,200); stale = true;
    const result = await f.call('GET','/v1/sync',undefined,owner.token); assert.equal(result.status,503); assert.deepEqual(await result.json(),{ error:'unavailable',message:'Request failed.' }); assert.ok(result.headers.get('retry-after'));
  } finally { await f.close(); }
});
test('ETag changes for decisions, setups, revisions and pollAfter while status and lastSeen are irrelevant', async () => {
  const memory = makeMemoryStore(); const f = await fixture({ store:memory }); const otherReplica = await fixture({ store:memory,pollAfter:901 });
  try { const owner = (await f.login()).body;
    const tag = async () => (await f.call('GET','/v1/sync',undefined,owner.token)).headers.get('etag')!;
    let previous = await tag(); const s = await setup(f,owner.token); let next = await tag(); assert.notEqual(next,previous); previous = next;
    await publish(f,owner.token,s.setupId,1); next = await tag(); assert.notEqual(next,previous); previous = next;
    await f.call('PUT','/v1/decisions',{ decisions:[{ setupId:s.setupId,itemId:'file:claude:CLAUDE.md',revision:1,decision:'skip' }] },owner.token); next = await tag(); assert.notEqual(next,previous); previous = next;
    assert.notEqual((await otherReplica.call('GET','/v1/sync',undefined,owner.token)).headers.get('etag'),previous);
    await f.call('PUT','/v1/machines/self/status',{ reportedAt:new Date(f.clock.now).toISOString(),policy:'notify',agents:[],setups:[],drift:{ setting:0,skill:0,integration:0,file:0 } },owner.token);
    f.clock.now += 300000; assert.equal(await tag(),previous);
    const queryTag = (await f.call('GET',`/v1/sync?since=0&setups=${s.setupId}:1`,undefined,owner.token)).headers.get('etag'); assert.notEqual(queryTag,previous);
  } finally { await f.close(); await otherReplica.close(); }
});
