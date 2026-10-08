import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHosted, MachinesResponseSchema, SyncResponseSchema } from '@nortuscc/hosted-protocol';
import { fixture } from './support/service.ts';
import { setup, publish, publication } from './support/metadata.ts';

test('status accepts removed historical items, rejects private nested data, and remains owner-only', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    assert.equal((await f.call('POST',`/v1/setups/${s.setupId}/revisions`,{ ...publication(2),items:[{ id:'file:claude:CLAUDE.md',kind:'file',change:'removed' }] },owner.token)).status,201);
    const summary = { reportedAt:new Date(f.clock.now).toISOString(),policy:'notify',agents:['codex'],setups:[{ setupId:s.setupId,revisionApplied:2,adopted:[],skipped:['file:claude:CLAUDE.md'],pending:[],waitingForPerson:[] }],drift:{ setting:1,skill:0,integration:0,file:0 } };
    const put = (body: unknown) => f.call('PUT','/v1/machines/self/status',body,owner.token);
    assert.equal((await put(summary)).status,204);
    for (const invalid of [{ ...summary,setups:[{ ...summary.setups[0],revisionApplied:3 }] },{ ...summary,setups:[{ ...summary.setups[0],skipped:['file:claude:unknown'] }] },{ ...summary,setups:[{ ...summary.setups[0],path:'/PRIVATE' }] },{ ...summary,drift:{ ...summary.drift,digest:'PRIVATE' } }]) assert.equal((await put(invalid)).status,400);
    assert.deepEqual(decodeHosted(MachinesResponseSchema,await (await f.call('GET','/v1/machines',undefined,owner.token)).json()).machines[0].status,summary);
    f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
    assert.equal((await f.call('PUT','/v1/machines/self/status',summary,other.token)).status,404);
    assert.equal(decodeHosted(MachinesResponseSchema,await (await f.call('GET','/v1/machines',undefined,other.token)).json()).machines[0].status,null);
    assert.equal((await f.call('PUT',`/v1/machines/${owner.machineId}/status`,summary,other.token)).status,404);
    assert.doesNotMatch(JSON.stringify(f.diagnostics),/PRIVATE|CLAUDE.md/);
  } finally { await f.close(); }
});
test('disabling reporting deletes status, rejects later uploads, and keeps decision sync', async () => {
  const f = await fixture(); try { const owner = (await f.login()).body; const s = await setup(f,owner.token); await publish(f,owner.token,s.setupId,1);
    const summary = { reportedAt:new Date(f.clock.now).toISOString(),policy:'notify',agents:[],setups:[],drift:{ setting:0,skill:0,integration:0,file:0 } };
    assert.equal((await f.call('PUT','/v1/machines/self/status',summary,owner.token)).status,204);
    assert.equal((await f.call('PATCH',`/v1/machines/${owner.machineId}`,{ reportStatus:false },owner.token)).status,200);
    const disabled = await f.call('PUT','/v1/machines/self/status',summary,owner.token); assert.equal(disabled.status,409); assert.equal((await disabled.json()).error,'status_disabled');
    assert.equal((await f.call('PUT','/v1/decisions',{ decisions:[{ setupId:s.setupId,itemId:'file:claude:CLAUDE.md',revision:1,decision:'skip' }] },owner.token)).status,200);
    const sync = decodeHosted(SyncResponseSchema,await (await f.call('GET','/v1/sync',undefined,owner.token)).json()); assert.equal(sync.decisions.length,1); assert.equal(sync.machine.reportStatus,false);
    assert.equal(decodeHosted(MachinesResponseSchema,await (await f.call('GET','/v1/machines',undefined,owner.token)).json()).machines[0].status,null);
  } finally { await f.close(); }
});
