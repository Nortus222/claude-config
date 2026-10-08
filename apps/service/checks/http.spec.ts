import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { ServiceFailure } from '../src/errors.ts';
import { fixture } from './support/service.ts';
import { makeMemoryStore } from '../src/memory-store.ts';

test('loopback health does not access Store and rejects unknown query/body', async () => {
  const memory = makeMemoryStore();
  const f = await fixture({ store: { ...memory, readPartition: () => Effect.fail(new ServiceFailure({ code: 'unavailable', retryAfter: 7 })), commitPartition: () => Effect.fail(new ServiceFailure({ code: 'unavailable', retryAfter: 7 })) } });
  try { assert.deepEqual(await (await f.call('GET', '/v1/health')).json(), { status: 'ok' });
    assert.equal((await f.call('GET', '/v1/health?private=secret')).status, 400);
    assert.equal((await f.call('GET', '/v1/machines', undefined, 'nmt_bad_bad_wrong')).status, 401);
    const result = await f.start(); assert.equal(result.response.status, 503); assert.equal(result.response.headers.get('retry-after'), '7');
  } finally { await f.close(); }
});
test('loopback original body bound and strict JSON/UTF8 errors remain generic', async () => {
  const f = await fixture();
  try { for (const input of [Buffer.from('{'), Buffer.from([0xc3,0x28])]) assert.equal((await f.raw(input)).status, 400);
    assert.equal((await f.raw(Buffer.from(' '.repeat(128 * 1024) + '{}'))).status, 413);
    assert.equal((await f.call('POST', '/v1/auth/device/start', { name: 'M', os: 'linux', agents: ['codex'], secret: 'private' })).status, 400);
    assert.equal((await f.call('POST', '/v1/auth/device/poll', { pendingId: 'x', nested: { value: 'secret' } })).status, 400);
    await f.call('GET', '/v1/private-token?private-path=SECRET', undefined, 'PRIVATE_TOKEN');
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /SECRET|PRIVATE|private-path|github.com|deviceCode|tokenHash/);
  } finally { await f.close(); }
});

test('diagnostic callback exceptions are ignored and all fields are constrained', async () => {
  const f = await fixture({ diagnostic: () => { throw new Error('PRIVATE diagnostic callback'); } });
  try { const login = (await f.login()).body; await f.call('GET','/v1/machines',undefined,login.token);
    for (const entry of f.diagnostics as Record<string, unknown>[]) assert.ok(Object.keys(entry).every((key) => ['requestId','route','status','duration','accountHash'].includes(key)));
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE_OAUTH|PRIVATE_DEVICE/);
  } finally { await f.close(); }
});

test('encoded metadata queries reach the strict metadata decoder and method templates cannot carry values', async () => {
  const f = await fixture({ metadata: () => Effect.succeed({ status: 200 }) });
  try { const login = (await f.login()).body;
    assert.equal((await f.call('GET','/v1/sync?since=0&setups=ABC%3A0',undefined,login.token)).status,200);
    await f.raw(Buffer.alloc(0), '/v1/health', 'PRIVATE');
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /PRIVATE/);
    assert.equal((await f.raw(Buffer.from('{}'), '/v1/health', 'GET', { 'content-length': '2' })).status,400);
  } finally { await f.close(); }
});

test('malformed and duplicate bearer headers never authenticate', async () => {
  const f = await fixture();
  try { const login = (await f.login()).body;
    for (const token of ['wrong', `${login.token} trailing`, login.token.replace('nmt_','NMT_')]) assert.equal((await f.call('GET','/v1/machines',undefined,token)).status,401);
    assert.equal((await f.raw(Buffer.alloc(0), '/v1/machines', 'GET', { authorization:`bearer ${login.token}` })).status,401);
    assert.equal((await f.raw(Buffer.alloc(0), '/v1/machines', 'GET', { authorization:`Bearer ${login.token}, Bearer ${login.token}` })).status,401);
    assert.equal((await f.raw(Buffer.from('{}'), '/v1/machines', 'DELETE', { authorization:`Bearer ${login.token}`, 'content-length':'2' })).status,400);
  } finally { await f.close(); }
});
