import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeHosted, SetupsResponseSchema, SetupRecordSchema } from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';

test('setup reservations enforce ten under concurrency and preserve the fixed repo reference', async () => {
  const f = await fixture();
  try { const owner = (await f.login()).body;
    const responses = await Promise.all(Array.from({ length:11 }, (_,i) => f.call('POST','/v1/setups',{ name:`Setup ${i}`,repoUrl:'git@github.com:Nortus222/config.git' },owner.token)));
    assert.equal(responses.filter((r) => r.status === 201).length,10);
    assert.equal(responses.filter((r) => r.status === 409).length,1);
    for (const response of responses.filter((r) => r.status === 201)) assert.equal(decodeHosted(SetupRecordSchema,await response.json()).repoUrl,'git@github.com:Nortus222/config.git');
    const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,10);
    assert.equal((await f.call('POST','/v1/setups',{ name:'Bad',repoUrl:'https://github.com/a/b',accountId:'other' },owner.token)).status,400);
  } finally { await f.close(); }
});
test('a failed setup materialization retains its counted reservation and list repairs it', async () => {
  const memory = makeMemoryStore(); let fail = false;
  const f = await fixture({ store:{ ...memory,commitPartition:(container,key,version,mutations) => {
    if (fail && container === 'setups') { fail = false; return Effect.fail(new ServiceFailure({ code:'unavailable',retryAfter:3 })); }
    return memory.commitPartition(container,key,version,mutations);
  } } });
  try { const owner = (await f.login()).body; fail = true;
    const broken = await f.call('POST','/v1/setups',{ name:'Recover',repoUrl:'https://github.com/a/b' },owner.token); assert.equal(broken.status,503); assert.equal(broken.headers.get('retry-after'),'3');
    const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,1); assert.equal(list.setups[0].name,'Recover');
    const again = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.deepEqual(again,list);
    f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
    assert.equal((await f.call('GET',`/v1/setups/${list.setups[0].setupId}/revisions`,undefined,other.token)).status,404);
  } finally { await f.close(); }
});
test('a ready-checkpoint failure leaves a recoverable reservation and never counts it twice', async () => {
  const memory = makeMemoryStore(); let fail = false;
  const f = await fixture({ store:{ ...memory,commitPartition:(c,k,v,m) => {
    if (fail && c === 'accounts' && m.some((x) => x.type === 'upsert' && x.document.type === 'account' && x.document.setups.some((s) => s.state === 'ready'))) { fail = false; return Effect.fail(new ServiceFailure({ code:'unavailable' })); }
    return memory.commitPartition(c,k,v,m);
  } } });
  try { const owner = (await f.login()).body; fail = true;
    assert.equal((await f.call('POST','/v1/setups',{ name:'Reserved',repoUrl:'https://github.com/a/b' },owner.token)).status,503);
    const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,1);
    const before = await (await f.call('GET','/v1/sync',undefined,owner.token)).json();
    await f.call('GET','/v1/setups',undefined,owner.token);
    assert.equal((await (await f.call('GET','/v1/sync',undefined,owner.token)).json()).seq,before.seq);
  } finally { await f.close(); }
});
