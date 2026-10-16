import { serviceContract, type ServiceStoreFactory } from './service-contract.ts';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { decodeHosted, SetupsResponseSchema, SetupRecordSchema } from '@nortuscc/hosted-protocol';
import { ServiceFailure } from '../../src/errors.ts';

export function registerSetupsContract(name: string, factory: ServiceStoreFactory) {
  const test = serviceContract(name, factory);
  test('setup reservations enforce ten under concurrency and preserve the fixed repo reference', async ({ fixture }) => {
    const f = await fixture();
    try { const owner = (await f.login()).body;
      const responses = await Promise.all(Array.from({ length:11 }, (_,i) => f.call('POST','/v1/setups',{ name:`Setup ${i}`,repoUrl:'git@github.com:Nortus222/config.git', profile: `profile-${i}` },owner.token)));
      assert.equal(responses.filter((r) => r.status === 201).length,10);
      assert.equal(responses.filter((r) => r.status === 409).length,1);
      for (const response of responses.filter((r) => r.status === 201)) assert.equal(decodeHosted(SetupRecordSchema,await response.json()).repoUrl,'git@github.com:Nortus222/config.git');
      const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,10);
      const existing = list.setups[0];
      const retry = await f.call('POST', '/v1/setups', { name:'Full budget retry', repoUrl:existing.repoUrl, profile:existing.profile }, owner.token);
      assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), existing);
      assert.equal((await f.call('POST','/v1/setups',{ name:'Bad',repoUrl:'https://github.com/a/b', profile: 'default',accountId:'other' },owner.token)).status,400);
    } finally { await f.close(); }
  });
  test('a failed setup materialization retains its counted reservation and list repairs it', async ({ fixture, store: base }) => {
    let fail = false;
    const f = await fixture({ store:{ ...base,commitPartition:(container,key,version,mutations) => {
      if (fail && container === 'setups') { fail = false; return Effect.fail(new ServiceFailure({ code:'unavailable',retryAfter:3 })); }
      return base.commitPartition(container,key,version,mutations);
    } } });
    try { const owner = (await f.login()).body; fail = true;
      const broken = await f.call('POST','/v1/setups',{ name:'Recover',repoUrl:'https://github.com/a/b', profile: 'default' },owner.token); assert.equal(broken.status,503); assert.equal(broken.headers.get('retry-after'),'3');
      const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,1); assert.equal(list.setups[0].name,'Recover');
      const again = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.deepEqual(again,list);
      f.github.state.user = { id:99,login:'Other' }; const other = (await f.login()).body;
      assert.equal((await f.call('GET',`/v1/setups/${list.setups[0].setupId}/revisions`,undefined,other.token)).status,404);
    } finally { await f.close(); }
  });
  test('a ready-checkpoint failure leaves a recoverable reservation and never counts it twice', async ({ fixture, store: base }) => {
    let fail = false;
    const f = await fixture({ store:{ ...base,commitPartition:(c,k,v,m) => {
      if (fail && c === 'accounts' && m.some((x) => x.type === 'upsert' && x.document.type === 'account' && x.document.setups.some((s) => s.state === 'ready'))) { fail = false; return Effect.fail(new ServiceFailure({ code:'unavailable' })); }
      return base.commitPartition(c,k,v,m);
    } } });
    try { const owner = (await f.login()).body; fail = true;
      assert.equal((await f.call('POST','/v1/setups',{ name:'Reserved',repoUrl:'https://github.com/a/b', profile: 'default' },owner.token)).status,503);
      const list = decodeHosted(SetupsResponseSchema,await (await f.call('GET','/v1/setups',undefined,owner.token)).json()); assert.equal(list.setups.length,1);
      const before = await (await f.call('GET','/v1/sync',undefined,owner.token)).json();
      await f.call('GET','/v1/setups',undefined,owner.token);
      assert.equal((await (await f.call('GET','/v1/sync',undefined,owner.token)).json()).seq,before.seq);
    } finally { await f.close(); }
  });

  test('concurrent registration retries return one owned setup for normalized repository and profile', async ({ fixture }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      const urls = ['https://github.com/Example/config.git', 'git@github.com:example/config.git', 'github.com/example/config'];
      const responses = await Promise.all(urls.map((repoUrl, index) => f.call('POST', '/v1/setups', { name:`Attempt ${index}`, repoUrl, profile:'team' }, owner.token)));
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 201]);
      const records = await Promise.all(responses.map(async response => decodeHosted(SetupRecordSchema, await response.json())));
      assert.ok(records.every(record => record.setupId === records[0].setupId));
      assert.ok(records.every(record => JSON.stringify(record) === JSON.stringify(records[0])));
      const before = await (await f.call('GET', '/v1/sync', undefined, owner.token)).json();
      const retry = await f.call('POST', '/v1/setups', { name:'Renamed retry', repoUrl:urls[1], profile:'team' }, owner.token);
      assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), records[0]);
      assert.equal((await (await f.call('GET', '/v1/sync', undefined, owner.token)).json()).seq, before.seq);
      const listed = decodeHosted(SetupsResponseSchema, await (await f.call('GET', '/v1/setups', undefined, owner.token)).json());
      assert.equal(listed.setups.length, 1);
      assert.equal((await f.call('POST', '/v1/setups', { name:'Personal', repoUrl:urls[0], profile:'personal' }, owner.token)).status, 201);
      f.github.state.user = { id:99, login:'Other' }; const other = (await f.login()).body;
      const otherResponse = await f.call('POST', '/v1/setups', { name:'Team', repoUrl:urls[0], profile:'team' }, other.token);
      assert.equal(otherResponse.status, 201); assert.notEqual((await otherResponse.json()).setupId, records[0].setupId);
    } finally { await f.close(); }
  });
  test('registration retries repair the same reserved setup after materialization fails', async ({ fixture, store: base }) => {
    let fail = false;
    const f = await fixture({ store:{ ...base, commitPartition:(container, key, version, mutations) => {
      if (fail && container === 'setups') { fail = false; return Effect.fail(new ServiceFailure({ code:'unavailable' })); }
      return base.commitPartition(container, key, version, mutations);
    } } });
    try {
      const owner = (await f.login()).body; fail = true;
      const registration = { name:'Team', repoUrl:'https://github.com/example/config.git', profile:'team' };
      assert.equal((await f.call('POST', '/v1/setups', registration, owner.token)).status, 503);
      const snapshot = await Effect.runPromise(base.readPartition('accounts', owner.accountId));
      const reserved = snapshot.documents.find(document => document.type === 'account')!.setups[0];
      const retried = await f.call('POST', '/v1/setups', { ...registration, name:'Retry', repoUrl:'git@github.com:example/config.git' }, owner.token);
      assert.equal(retried.status, 200); assert.equal((await retried.json()).setupId, reserved.setupId);
      const listed = decodeHosted(SetupsResponseSchema, await (await f.call('GET', '/v1/setups', undefined, owner.token)).json());
      assert.equal(listed.setups.length, 1);
    } finally { await f.close(); }
  });

  test('a legacy setup without profile reads as default', async ({ fixture, store }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      const response = await f.call('POST', '/v1/setups', { name:'Legacy', repoUrl:'https://github.com/a/b', profile:'default' }, owner.token);
      assert.equal(response.status, 201);
      const setup = await response.json();
      for (const [container, key] of [['accounts', owner.accountId], ['setups', setup.setupId]] as const) {
        const snapshot = await Effect.runPromise(store.readPartition(container, key));
        const documents = JSON.parse(JSON.stringify(snapshot.documents));
        for (const document of documents) {
          if (document.type === 'setup') delete document.profile;
          if (document.type === 'account') for (const reservation of document.setups) delete reservation.profile;
        }
        assert.equal(await Effect.runPromise(store.commitPartition(container, key, snapshot.version, documents.map((document: any) => ({ type:'upsert', document })))), true);
      }
      const listed = decodeHosted(SetupsResponseSchema, await (await f.call('GET', '/v1/setups', undefined, owner.token)).json());
      assert.equal(listed.setups[0].profile, 'default');
      const publication = { number:1, commitSha:'a'.repeat(40), tag:'v1', changelog:'', items:[], requiredEnv:[] };
      assert.equal((await f.call('POST', `/v1/setups/${setup.setupId}/revisions`, publication, owner.token)).status, 201);
      const snapshot = await Effect.runPromise(store.readPartition('setups', setup.setupId));
      assert.equal(snapshot.documents.find(d => d.type === 'setup')?.profile, 'default');
      const account = await Effect.runPromise(store.readPartition('accounts', owner.accountId));
      assert.equal(account.documents.find(d => d.type === 'account')?.setups[0].profile, 'default');
    } finally { await f.close(); }
  });

  test('profiles in the same repository have independent setup identities and revisions', async ({ fixture }) => {
    const f = await fixture();
    try {
      const owner = (await f.login()).body;
      const setups = [];
      for (const profile of ['personal', 'team']) {
        const response = await f.call('POST', '/v1/setups', { name:profile, repoUrl:'https://github.com/a/b', profile }, owner.token);
        assert.equal(response.status, 201); setups.push(decodeHosted(SetupRecordSchema, await response.json()));
      }
      assert.notEqual(setups[0].setupId, setups[1].setupId);
      const publication = { number:1, commitSha:'a'.repeat(40), tag:'v1', changelog:'', items:[], requiredEnv:[] };
      assert.equal((await f.call('POST', `/v1/setups/${setups[0].setupId}/revisions`, publication, owner.token)).status, 201);
      const list = decodeHosted(SetupsResponseSchema, await (await f.call('GET', '/v1/setups', undefined, owner.token)).json());
      assert.deepEqual(list.setups.map(s => [s.profile, s.latestRevision]), [['personal', 1], ['team', 0]]);
    } finally { await f.close(); }
  });

}
