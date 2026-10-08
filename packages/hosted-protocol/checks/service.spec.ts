import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.ts';
test('health has a minimal strict public projection', () => {
  assert.ok('HealthResponseSchema' in api, 'HealthResponseSchema must be exported');
  assert.deepEqual(api.decodeHosted(api.HealthResponseSchema, { status: 'ok' }), { status: 'ok' });
  assert.throws(() => api.decodeHosted(api.HealthResponseSchema, { status: 'ok', private: 'secret' }));
});
test('account export is a minimal strict projection with strict nested metadata', () => {
  assert.ok('AccountExportSchema' in api,'AccountExportSchema must be exported');
  const body = { account:{ accountId:'account',githubId:42,login:'Owner',seq:0,defaultPolicy:'notify',createdAt:'2026-10-07T00:00:00.000Z' },machines:[],setups:[],revisions:[],decisions:[] };
  assert.deepEqual(api.decodeHosted(api.AccountExportSchema,body),body);
  for (const invalid of [{ ...body,tokenHash:'PRIVATE' },{ ...body,account:{ ...body.account,state:'active' } },{ ...body,account:{ ...body.account,githubId:0 } },{ ...body,account:{ ...body.account,defaultPolicy:'manual' } }]) assert.throws(() => api.decodeHosted(api.AccountExportSchema,invalid));
});
