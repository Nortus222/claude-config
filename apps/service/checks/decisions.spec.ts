import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeDecisionsResponse, decodeHosted, SyncResponseSchema } from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { setup, publish, publication } from './support/metadata.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';

const decision = (setupId: string, revision = 1, choice: 'accept' | 'skip' = 'accept',itemId = 'file:claude:CLAUDE.md') => ({ setupId,itemId,revision,decision:choice });
test('decisions prevalidate every reference and reject foreign resources before any writes', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    for (const bad of [decision(s.setupId,2),decision(s.setupId,1,'skip','file:claude:unknown')]) assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[decision(s.setupId),bad] },owner.token)).status,400);
    assert.equal((await f.call('PUT','/v1/decisions',{ decisions:Array.from({ length:501 },() => decision(s.setupId)) },owner.token)).status,400);
    const empty = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(empty.decisions.length,0);
    f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
    assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[decision(s.setupId)] },other.token)).status,404);
  } finally { await f.close(); }
});
test('equal revision reversals and stale outcomes retain duplicate positions across 99-entry chunks', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); await publish(f,owner.token,s.setupId,2);
    const sent = { decisions:[...Array.from({ length:99 },() => decision(s.setupId,2,'accept')),decision(s.setupId,2,'skip'),decision(s.setupId,1,'accept')] };
    const response = await f.call('PUT','/v1/decisions',sent,owner.token); assert.equal(response.status,200);
    const body = decodeDecisionsResponse(sent,await response.json()); assert.equal(body.results.length,101); assert.ok(body.results.slice(0,100).every((r) => r.outcome === 'stored')); assert.equal(body.results[100].outcome,'stale');
    const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.length,1); assert.equal(sync.decisions[0].decision,'skip'); assert.equal(sync.seq,body.seq);
  } finally { await f.close(); }
});
test('98 distinct decision targets plus account fit the partition batch and faults leave exact suffix', async () => {
  const memory = makeMemoryStore(); let fault = false; let chunks = 0; const counts: number[] = [];
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => {
    if (m.some((x) => x.type === 'upsert' && x.document.type === 'decision')) {
      counts.push(m.length); if (fault && ++chunks === 2) return Effect.fail(new ServiceFailure({ code:'rate_limited',retryAfter:2 }));
    }
    return memory.commitPartition(c,k,v,m);
  } } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    const items = Array.from({ length:200 },(_,i) => ({ id:`file:claude:file${i}`,kind:'file',change:'added' }));
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,{ ...publication(1),items },owner.token)).status,201);
    const sent = { decisions:items.map((item) => decision(s.setupId,1,'accept',item.id)) }; fault = true;
    const body = decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json());
    assert.ok(body.results.slice(0,98).every((r) => r.outcome === 'stored')); assert.ok(body.results.slice(98).every((r) => r.outcome === 'unprocessed')); assert.deepEqual(counts,[99,99]);
    const snapshot = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(snapshot.decisions.length,98); assert.equal(snapshot.seq,body.seq);
    fault = false; const suffix = { decisions:sent.decisions.slice(98) }; assert.ok(decodeDecisionsResponse(suffix,await (await f.call('PUT','/v1/decisions',suffix,owner.token)).json()).results.every((r) => r.outcome === 'stored'));
  } finally { await f.close(); }
});
test('decision CAS conflicts recompute against the winning writer and first failure is wholly unprocessed', async () => {
  const memory = makeMemoryStore(); let conflict = false; let fail = false;
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => {
    if (m.some((x) => x.type === 'upsert' && x.document.type === 'decision')) {
      if (fail) return Effect.fail(new ServiceFailure({ code:'unavailable' }));
      if (conflict) { conflict = false; return Effect.succeed(false); }
    }
    return memory.commitPartition(c,k,v,m);
  } } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); await publish(f,owner.token,s.setupId,2); conflict = true;
    const writes = [{ decisions:[decision(s.setupId,2,'skip')] },{ decisions:[decision(s.setupId,1)] }];
    const results = await Promise.all(writes.map(async (sent) => decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()))); assert.equal(results[0].results[0].outcome,'stored');
    const authoritative = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(authoritative.decisions[0].revision,2); assert.equal(authoritative.decisions[0].decision,'skip');
    fail = true; const sent = { decisions:[decision(s.setupId,2)] }; const failed = decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()); assert.equal(failed.results[0].outcome,'unprocessed'); assert.equal(failed.seq,authoritative.seq);
  } finally { await f.close(); }
});
test('duplicate boundary positions coalesce without moving a reversal into an unprocessed chunk', async () => {
  const memory = makeMemoryStore(); let fault = false; let chunks = 0;
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => {
    if (fault && m.some((x) => x.type === 'upsert' && x.document.type === 'decision') && ++chunks === 2) return Effect.fail(new ServiceFailure({ code:'unavailable' }));
    return memory.commitPartition(c,k,v,m);
  } } });
  try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
    const items = Array.from({ length:100 },(_,i) => ({ id:`file:claude:file${i}`,kind:'file',change:'added' }));
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,{ ...publication(1),items },owner.token)).status,201);
    const sent = { decisions:[...items.slice(0,98).map((i) => decision(s.setupId,1,'accept',i.id)),decision(s.setupId,1,'skip',items[0].id),decision(s.setupId,1,'accept',items[0].id),decision(s.setupId,1,'skip',items[98].id)] }; fault = true;
    const body = decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()); assert.equal(body.results[98].outcome,'stored'); assert.equal(body.results[99].outcome,'unprocessed'); assert.equal(body.results[100].outcome,'unprocessed');
    const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.find((d) => d.itemId === items[0].id)!.decision,'skip');
  } finally { await f.close(); }
});
