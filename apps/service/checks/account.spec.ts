import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import * as protocol from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { setup, publish } from './support/metadata.ts';

test('export is a strict complete public metadata projection excluding internal documents and secrets', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[{ setupId:s.setupId,itemId:'file:claude:CLAUDE.md',revision:1,decision:'skip' }] },owner.token)).status,200);
    const snapshot = await Effect.runPromise(f.store.readPartition('accounts',owner.accountId));
    await Effect.runPromise(f.store.commitPartition('accounts',owner.accountId,snapshot.version,[{ type:'upsert',document:{ type:'issuanceFence',version:1,id:'issuance:internal',accountId:owner.accountId,machineId:'internal' } },{ type:'upsert',document:{ type:'deviceReservation',version:1,id:'device:internal',accountId:owner.accountId,sessionId:'device:internal' } }]));
    const response = await f.call('GET','/v1/account/export',undefined,owner.token); assert.equal(response.status,200);
    assert.ok('AccountExportSchema' in protocol); const body = protocol.decodeHosted(protocol.AccountExportSchema,await response.json());
    assert.deepEqual(Object.keys(body).sort(),['account','decisions','machines','revisions','setups']); assert.equal(body.account.accountId,owner.accountId); assert.equal(body.machines.length,1); assert.equal(body.setups.length,1); assert.equal(body.revisions.length,1); assert.equal(body.decisions.length,1);
    assert.doesNotMatch(JSON.stringify(body),/tokenHash|deviceCode|deviceReservation|sessionId|claim|issuance|__partition|publishedHead|publicationDay|ownerAccountId|"version"|"type"/);
    f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body; const exportOther = protocol.decodeHosted(protocol.AccountExportSchema,await (await f.call('GET','/v1/account/export',undefined,other.token)).json()); assert.equal(exportOther.setups.length,0); assert.equal(exportOther.decisions.length,0);
    assert.equal((await f.call('DELETE','/v1/account',undefined,owner.token)).status,204);
  } finally { await f.close(); }
});
