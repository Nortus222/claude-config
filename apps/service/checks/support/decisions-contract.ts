import { serviceContract, type ServiceStoreFactory } from './service-contract.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeDecisionsResponse, decodeHosted, SyncResponseSchema } from '@nortuscc/hosted-protocol';
import { setup, publish, publication } from './metadata.ts';
import { ServiceFailure } from '../../src/errors.ts';

const decision = (setupId: string, revision = 1, choice: 'accept' | 'skip' = 'accept',itemId = 'file:claude:CLAUDE.md') => ({ setupId,itemId,revision,decision:choice });
export function registerDecisionsContract(name: string, factory: ServiceStoreFactory) {
  const test = serviceContract(name, factory);
  test('decisions prevalidate every reference and reject foreign resources before any writes', async ({ fixture }) => {
    const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
      for (const bad of [decision(s.setupId,2),decision(s.setupId,1,'skip','file:claude:unknown')]) assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[decision(s.setupId),bad] },owner.token)).status,400);
      assert.equal((await f.call('PUT','/v1/decisions',{ decisions:Array.from({ length:501 },() => decision(s.setupId)) },owner.token)).status,409);
      const empty = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(empty.decisions.length,0);
      f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
      assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[decision(s.setupId)] },other.token)).status,404);
    } finally { await f.close(); }
  });
  test('equal revision reversals and stale outcomes retain duplicate positions across 99-entry chunks', async ({ fixture }) => {
    const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); await publish(f,owner.token,s.setupId,2);
      const sent = { decisions:[...Array.from({ length:99 },() => decision(s.setupId,2,'accept')),decision(s.setupId,2,'skip'),decision(s.setupId,1,'accept')] };
      const response = await f.call('PUT','/v1/decisions',sent,owner.token); assert.equal(response.status,200);
      const body = decodeDecisionsResponse(sent,await response.json()); assert.equal(body.results.length,101); assert.ok(body.results.slice(0,100).every((r) => r.outcome === 'stored')); assert.equal(body.results[100].outcome,'stale');
      const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.length,1); assert.equal(sync.decisions[0].decision,'skip'); assert.equal(sync.seq,body.seq);
    } finally { await f.close(); }
  });
  test('98 distinct decision targets plus account fit the partition batch and faults leave exact suffix', async ({ fixture, store: base }) => {
    let fault = false; let chunks = 0; const counts: number[] = [];
    const f = await fixture({ store:{ ...base,commitPartition:(c,k,v,m) => {
      if (m.some((x) => x.type === 'upsert' && x.document.type === 'decision')) {
        counts.push(m.length); if (fault && ++chunks === 2) return Effect.fail(new ServiceFailure({ code:'rate_limited',retryAfter:2 }));
      }
      return base.commitPartition(c,k,v,m);
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
  test('decision CAS conflicts recompute against the winning writer and first failure is wholly unprocessed', async ({ fixture, store: base }) => {
    let conflict = false; let fail = false;
    const f = await fixture({ store:{ ...base,commitPartition:(c,k,v,m) => {
      if (m.some((x) => x.type === 'upsert' && x.document.type === 'decision')) {
        if (fail) return Effect.fail(new ServiceFailure({ code:'unavailable' }));
        if (conflict) { conflict = false; return Effect.succeed(false); }
      }
      return base.commitPartition(c,k,v,m);
    } } });
    try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); await publish(f,owner.token,s.setupId,2); conflict = true;
      const writes = [{ decisions:[decision(s.setupId,2,'skip')] },{ decisions:[decision(s.setupId,1)] }];
      const results = await Promise.all(writes.map(async (sent) => decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()))); assert.equal(results[0].results[0].outcome,'stored');
      const authoritative = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(authoritative.decisions[0].revision,2); assert.equal(authoritative.decisions[0].decision,'skip');
      fail = true; const sent = { decisions:[decision(s.setupId,2)] }; const failed = decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()); assert.equal(failed.results[0].outcome,'unprocessed'); assert.equal(failed.seq,authoritative.seq);
    } finally { await f.close(); }
  });
  test('duplicate boundary positions coalesce without moving a reversal into an unprocessed chunk', async ({ fixture, store: base }) => {
    let fault = false; let chunks = 0;
    const f = await fixture({ store:{ ...base,commitPartition:(c,k,v,m) => {
      if (fault && m.some((x) => x.type === 'upsert' && x.document.type === 'decision') && ++chunks === 2) return Effect.fail(new ServiceFailure({ code:'unavailable' }));
      return base.commitPartition(c,k,v,m);
    } } });
    try { const owner = (await f.login()).body; const s = await setup(f,owner.token);
      const items = Array.from({ length:100 },(_,i) => ({ id:`file:claude:file${i}`,kind:'file',change:'added' }));
      assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,{ ...publication(1),items },owner.token)).status,201);
      const sent = { decisions:[...items.slice(0,98).map((i) => decision(s.setupId,1,'accept',i.id)),decision(s.setupId,1,'skip',items[0].id),decision(s.setupId,1,'accept',items[0].id),decision(s.setupId,1,'skip',items[98].id)] }; fault = true;
      const body = decodeDecisionsResponse(sent,await (await f.call('PUT','/v1/decisions',sent,owner.token)).json()); assert.equal(body.results[98].outcome,'stored'); assert.equal(body.results[99].outcome,'unprocessed'); assert.equal(body.results[100].outcome,'unprocessed');
      const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.find((d) => d.itemId === items[0].id)!.decision,'skip');
    } finally { await f.close(); }
  });
  test('a delayed earlier equal-revision receipt cannot overwrite a later reversal after CAS retry', async ({ fixture, store: base }) => {
    let pause = false; let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve); const started = new Promise<void>((resolve) => entered = resolve);
    const store = { ...base,commitPartition:((c,k,v,m) => pause && m.some((x) => x.type === 'upsert' && x.document.type === 'decision') ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* base.commitPartition(c,k,v,m); }) : base.commitPartition(c,k,v,m)) as typeof base.commitPartition };
    const f = await fixture({ store }); const replica = await fixture({ store });
    try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); pause = true;
      const earlier = { decisions:[decision(s.setupId,1,'accept')] }; const later = { decisions:[decision(s.setupId,1,'skip')] };
      const first = f.call('PUT','/v1/decisions',earlier,owner.token); await started;
      const winning = decodeDecisionsResponse(later,await (await replica.call('PUT','/v1/decisions',later,owner.token)).json()); assert.equal(winning.results[0].outcome,'stored'); release();
      const delayed = decodeDecisionsResponse(earlier,await (await first).json()); assert.equal(delayed.results[0].outcome,'stale'); assert.equal(delayed.seq,winning.seq);
      const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions[0].decision,'skip'); assert.equal(sync.seq,winning.seq);
    } finally { release(); await f.close(); await replica.close(); }
  });
  test('one request receipt survives a paused later chunk and retains stored/stale positions', async ({ fixture, store: base }) => {
    let chunks = 0; let pause = false; let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve); const started = new Promise<void>((resolve) => entered = resolve);
    const f = await fixture({ store:{ ...base,commitPartition:(c,k,v,m) => pause && m.some((x) => x.type === 'upsert' && x.document.type === 'decision') && ++chunks === 2 ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* base.commitPartition(c,k,v,m); }) : base.commitPartition(c,k,v,m) } });
    try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); pause = true;
      const earlier = { decisions:Array.from({ length:101 },() => decision(s.setupId,1,'accept')) }; const first = f.call('PUT','/v1/decisions',earlier,owner.token); await started;
      const later = { decisions:[decision(s.setupId,1,'skip')] }; const winning = decodeDecisionsResponse(later,await (await f.call('PUT','/v1/decisions',later,owner.token)).json()); release();
      const delayed = decodeDecisionsResponse(earlier,await (await first).json()); assert.ok(delayed.results.slice(0,99).every((r) => r.outcome === 'stored')); assert.ok(delayed.results.slice(99).every((r) => r.outcome === 'stale')); assert.equal(delayed.seq,winning.seq);
      const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions[0].decision,'skip');
    } finally { release(); await f.close(); }
  });
  test('decision count overflow is limit_reached while malformed entries retain strict invalid rejection', async ({ fixture }) => {
    const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
      const decisions = Array.from({ length:501 },() => decision(s.setupId));
      const count = await f.call('PUT','/v1/decisions',{ decisions },owner.token); assert.equal(count.status,409); assert.deepEqual(await count.json(),{ error:'limit_reached',message:'Request failed.' });
      for (const body of [{ decisions,private:'PRIVATE' },{ decisions:decisions.map((d,i) => i === 500 ? { ...d,digest:'PRIVATE' } : d) },{ decisions:decisions.map((d,i) => i === 500 ? { ...d,revision:-1 } : d) }]) {
        const response = await f.call('PUT','/v1/decisions',body,owner.token); assert.equal(response.status,400); assert.deepEqual(await response.json(),{ error:'invalid',message:'Request failed.' });
      }
      assert.doesNotMatch(JSON.stringify(f.diagnostics),/PRIVATE/);
      const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.length,0);
    } finally { await f.close(); }
  });
  test('receipt is reserved before asynchronous reference reads and a new HTTP retry gets new authority', async ({ fixture, store: base }) => {
    let pause = false; let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve); const started = new Promise<void>((resolve) => entered = resolve);
    const f = await fixture({ store:{ ...base,readPartition:(c,k) => pause && c === 'setups' ? Effect.gen(function* () { pause = false; entered(); yield* Effect.promise(() => gate); return yield* base.readPartition(c,k); }) : base.readPartition(c,k) } });
    try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1); pause = true;
      const earlier = { decisions:[decision(s.setupId,1,'accept')] }; const first = f.call('PUT','/v1/decisions',earlier,owner.token); await started;
      const during = await f.call('GET','/v1/sync',undefined,owner.token); const unchanged = await during.json();
      const later = { decisions:[decision(s.setupId,1,'skip')] }; const winning = decodeDecisionsResponse(later,await (await f.call('PUT','/v1/decisions',later,owner.token)).json()); assert.equal(winning.seq,unchanged.seq + 1); release();
      const delayed = decodeDecisionsResponse(earlier,await (await first).json()); assert.equal(delayed.results[0].outcome,'stale');
      const retry = decodeDecisionsResponse(earlier,await (await f.call('PUT','/v1/decisions',earlier,owner.token)).json()); assert.equal(retry.results[0].outcome,'stored'); assert.equal(retry.seq,winning.seq + 1);
      const exported = await (await f.call('GET','/v1/account/export',undefined,owner.token)).json(); assert.equal(exported.decisions[0].decision,'accept'); assert.doesNotMatch(JSON.stringify(exported),/lastReceipt|fieldReceipts|receipt|ticket|position/);
    } finally { release(); await f.close(); }
  });
  test('receipt counter exhaustion fails closed without exposing order metadata or changing seq', async ({ fixture }) => {
    const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
      const before = await f.call('GET','/v1/sync',undefined,owner.token); const beforeBody = await before.json();
      const snapshot = await Effect.runPromise(f.store.readPartition('accounts',owner.accountId)); const account = snapshot.documents.find((d) => d.type === 'account'); assert.ok(account?.type === 'account');
      assert.equal(await Effect.runPromise(f.store.commitPartition('accounts',owner.accountId,snapshot.version,[{ type:'upsert',document:{ ...account,lastReceipt:Number.MAX_SAFE_INTEGER } }])),true);
      for (const response of [await f.call('PUT','/v1/decisions',{ decisions:[decision(s.setupId)] },owner.token),await f.call('PATCH',`/v1/machines/${owner.machineId}`,{ policy:'manual' },owner.token)]) {
        assert.equal(response.status,503); assert.ok(response.headers.get('retry-after')); assert.deepEqual(await response.json(),{ error:'unavailable',message:'Request failed.' });
      }
      const after = await f.call('GET','/v1/sync',undefined,owner.token); assert.equal(after.headers.get('etag'),before.headers.get('etag')); assert.deepEqual(await after.json(),beforeBody);
      assert.doesNotMatch(JSON.stringify(f.diagnostics),/lastReceipt|receipt|9007199254740991/);
    } finally { await f.close(); }
  });

}
