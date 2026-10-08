import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeHosted, AccountExportSchema, RevisionsResponseSchema, MAX_REVISION_BYTES, jsonByteLength } from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { setup, publish, publication } from './support/metadata.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';

test('publication atomically advances sequential head and paged lists keep every revision', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    const both = await Promise.all([1,1].map((number) => f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(number),owner.token))); assert.deepEqual(both.map((r) => r.status).sort(),[201,409]);
    for (let n = 2; n <= 51; n++) await publish(f,owner.token,s.setupId,n);
    const first = decodeHosted(RevisionsResponseSchema,await (await f.call('GET',`/v1/setups/${s.setupId}/revisions?after=0`,undefined,owner.token)).json()); assert.equal(first.revisions.length,50); assert.equal(first.nextAfter,50);
    const last = decodeHosted(RevisionsResponseSchema,await (await f.call('GET',`/v1/setups/${s.setupId}/revisions?after=50`,undefined,owner.token)).json()); assert.equal(last.revisions[0].number,51); assert.equal(last.nextAfter,null);
    const exported = decodeHosted(AccountExportSchema,await (await f.call('GET','/v1/account/export',undefined,owner.token)).json()); assert.equal(exported.revisions.length,51);
    for (const query of ['after=01','after=-1','after=1&after=2','after=0&secret=PRIVATE','after=52']) assert.equal((await f.call('GET',`/v1/setups/${s.setupId}/revisions?${query}`,undefined,owner.token)).status,400);
    f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(52),other.token)).status,404);
  } finally { await f.close(); }
});
test('publication cap resets at UTC day and rejects full-record overhead before mutation', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    const body = { ...publication(1),changelog:'x'.repeat(16384),requiredEnv:[] as string[] };
    while (jsonByteLength(body) < MAX_REVISION_BYTES - 50) body.requiredEnv.push(`ENV_${body.requiredEnv.length}_${'X'.repeat(180)}`);
    while (jsonByteLength(body) > MAX_REVISION_BYTES - 50) body.requiredEnv[body.requiredEnv.length-1] = body.requiredEnv.at(-1)!.slice(0,-1);
    assert.ok(jsonByteLength(body) <= MAX_REVISION_BYTES);
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,body,owner.token)).status,413);
    for (const invalid of [{ ...publication(1),changelog:'x'.repeat(16385) },{ ...publication(1),items:Array.from({ length:501 },(_,i) => ({ id:`file:claude:file${i}`,kind:'file',change:'added' })) },{ ...publication(1),items:[{ ...publication(1).items[0],digest:'PRIVATE' }] }]) assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,invalid,owner.token)).status,400);
    for (let n = 1; n <= 100; n++) await publish(f,owner.token,s.setupId,n);
    const cap = await f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(101),owner.token); assert.equal(cap.status,429); assert.ok(Number(cap.headers.get('retry-after')) > 0);
    f.clock.now = Date.UTC(2026,9,8); await publish(f,owner.token,s.setupId,101);
  } finally { await f.close(); }
});
test('failed account checkpoint cannot roll back a committed revision or hide it from sync', async () => {
  const memory = makeMemoryStore(); let fail = false;
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => fail && c === 'accounts' && m.some((x) => x.type === 'upsert' && x.document.type === 'account') ? Effect.fail(new ServiceFailure({ code:'unavailable' })) : memory.commitPartition(c,k,v,m) } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    const old = await f.call('GET','/v1/sync',undefined,owner.token); assert.equal(old.status,200); const etag = old.headers.get('etag'); const before = await old.json();
    fail = true; assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(1),owner.token)).status,503);
    const current = await f.raw(Buffer.alloc(0),'/v1/sync','GET',{ authorization:`Bearer ${owner.token}`,'if-none-match':etag! }); assert.equal(current.status,200); const body = JSON.parse(current.body); assert.equal(body.revisions.length,1); assert.equal(body.setups[0].latestRevision,1);
    fail = false; assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(1),owner.token)).status,409);
    const repaired = await (await f.call('GET','/v1/sync',undefined,owner.token)).json(); assert.equal(repaired.seq,before.seq + 1);
  } finally { await f.close(); }
});
test('an older paused checkpoint cannot regress or double count a later published head', async () => {
  const memory = makeMemoryStore(); let pause = false; let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((r) => release = r); const started = new Promise<void>((r) => entered = r);
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => pause && c === 'accounts' && m.some((x) => x.type === 'upsert' && x.document.type === 'account' && x.document.setups.some((s) => s.publishedHead === 1)) ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* memory.commitPartition(c,k,v,m); }) : memory.commitPartition(c,k,v,m) } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token); const before = await (await f.call('GET','/v1/sync',undefined,owner.token)).json(); pause = true;
    const first = f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(1),owner.token); await started;
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(2),owner.token)).status,201); release(); assert.equal((await first).status,201);
    const synced = await (await f.call('GET','/v1/sync',undefined,owner.token)).json(); assert.equal(synced.seq,before.seq + 2); assert.equal(synced.setups[0].latestRevision,2); assert.equal(synced.revisions.length,2);
  } finally { release(); await f.close(); }
});
test('a paused publication against an existing partition never recreates a swept setup', async () => {
  const memory = makeMemoryStore(); let pause = false; let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((r) => release = r); const started = new Promise<void>((r) => entered = r);
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => pause && c === 'setups' && m.some((x) => x.type === 'upsert' && x.document.type === 'revision') ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* memory.commitPartition(c,k,v,m); }) : memory.commitPartition(c,k,v,m) } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token); pause = true;
    const publishing = f.call('POST',`/v1/setups/${s.setupId}/revisions`,publication(1),owner.token); await started;
    const snapshot = await Effect.runPromise(memory.readPartition('setups',s.setupId)); assert.equal(await Effect.runPromise(memory.commitPartition('setups',s.setupId,snapshot.version,snapshot.documents.map((d) => ({ type:'delete' as const,id:d.id })))),true);
    release(); assert.equal((await publishing).status,404); assert.equal((await Effect.runPromise(memory.readPartition('setups',s.setupId))).version,null);
  } finally { release(); await f.close(); }
});
