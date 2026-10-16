import test from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { fixture } from './support/service.ts';
import { setup, publish, publication } from './support/metadata.ts';

const run = Effect.runPromise;
async function shared() {
  const f = await fixture();
  const owner = (await f.login()).body;
  const s = await setup(f, owner.token);
  f.github.state.user = { id: 99, login: 'Follower' };
  const follower = (await f.login()).body;
  return { f, owner, follower, s };
}

test("any signed-in account can read a setup's public metadata by id", async () => {
  const { f, follower, s } = await shared();
  try {
    const response = await f.call('GET', `/v1/setups/${s.setupId}/public`, undefined, follower.token);
    assert.equal(response.status, 200);
    const { createdAt, ...metadata } = s;
    assert.deepEqual(await response.json(), metadata);
    assert.equal((await f.call('GET', '/v1/setups/unknown/public', undefined, follower.token)).status, 404);
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/public`)).status, 401);
  } finally { await f.close(); }
});

test('a subscriber sees revisions of a subscribed setup in sync', async () => {
  const { f, owner, follower, s } = await shared();
  try {
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/revisions`, undefined, follower.token)).status, 404);
    for (let i = 0; i < 2; i++) assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    const before = await f.call('GET', '/v1/sync', undefined, follower.token);
    const initial = await before.json();
    await publish(f, owner.token, s.setupId, 1);
    const response = await f.raw(Buffer.alloc(0), '/v1/sync', 'GET', { authorization: `Bearer ${follower.token}`, 'if-none-match': before.headers.get('etag')! });
    assert.equal(response.status, 200);
    const synced = JSON.parse(response.body);
    assert.equal(synced.seq, initial.seq);
    assert.deepEqual(synced.setups, [{ setupId:s.setupId, name:s.name, repoUrl:s.repoUrl, profile:'default', latestRevision:1, owned:false }]);
    assert.equal(synced.revisions.length, 1);
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/revisions`, undefined, follower.token)).status, 200);
    assert.equal((await f.call('POST', `/v1/setups/${s.setupId}/revisions`, publication(2), follower.token)).status, 404);
    const decision = { setupId:s.setupId, itemId:publication(1).items[0].id, revision:1, decision:'accept' };
    assert.equal((await f.call('PUT', '/v1/decisions', { decisions:[decision] }, follower.token)).status, 200);
    const ownerSync = await (await f.call('GET', '/v1/sync', undefined, owner.token)).json();
    assert.deepEqual(ownerSync.decisions, []);
    for (let i = 0; i < 2; i++) assert.equal((await f.call('DELETE', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    const removed = await (await f.call('GET', '/v1/sync', undefined, follower.token)).json();
    assert.deepEqual(removed.setups, []); assert.deepEqual(removed.decisions, []);
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/revisions`, undefined, follower.token)).status, 404);
    assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    const followedAgain = await (await f.call('GET', `/v1/sync?since=${removed.seq}`, undefined, follower.token)).json();
    assert.equal(followedAgain.decisions.length, 1);
    assert.equal(followedAgain.decisions[0].decision, 'accept');
  } finally { await f.close(); }
});

test("deleting an account removes its subscriptions but not others' setups", async () => {
  const { f, owner, follower, s } = await shared();
  try {
    assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    assert.equal((await f.call('DELETE', '/v1/account', undefined, follower.token)).status, 204);
    const account = await run(f.store.readPartition('accounts', follower.accountId));
    assert.deepEqual(account.documents, []);
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/public`, undefined, owner.token)).status, 200);
  } finally { await f.close(); }
});

test('a closed setup appears closed to subscribers', async () => {
  const { f, owner, follower, s } = await shared();
  try {
    assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    await publish(f, owner.token, s.setupId, 1);
    assert.equal((await f.call('DELETE', '/v1/account', undefined, owner.token)).status, 204);
    const synced = await (await f.call('GET', `/v1/sync?setups=${s.setupId}:1`, undefined, follower.token)).json();
    assert.equal(synced.setups[0].closed, true); assert.equal(synced.setups[0].owned, false);
    assert.deepEqual(synced.revisions, []);
    assert.equal((await f.call('GET', `/v1/setups/${s.setupId}/public`, undefined, follower.token)).status, 404);
    assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 404);
    assert.equal((await f.call('DELETE', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
  } finally { await f.close(); }
});

test('subscription limits share the owned setup budget and concurrent retries are idempotent', async () => {
  const { f, owner, follower, s } = await shared();
  try {
    const both = await Promise.all([1, 2].map(() => f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)));
    assert.deepEqual(both.map(r => r.status), [204, 204]);
    for (let i = 0; i < 9; i++) assert.equal((await f.call('POST', '/v1/setups', { name:`Owned ${i}`, repoUrl:s.repoUrl, profile:'team' }, follower.token)).status, 201);
    assert.equal((await f.call('POST', '/v1/setups', { name:'Too many', repoUrl:s.repoUrl, profile:'team' }, follower.token)).status, 409);
    const other = await setup(f, owner.token);
    assert.equal((await f.call('PUT', `/v1/subscriptions/${other.setupId}`, undefined, follower.token)).status, 409);
    assert.equal((await f.call('PUT', '/v1/subscriptions/unknown', undefined, follower.token)).status, 404);
  } finally { await f.close(); }
});


test('a non-owner cannot publish a revision', async () => {
  const { f, follower, s } = await shared();
  try {
    assert.equal((await f.call('PUT', `/v1/subscriptions/${s.setupId}`, undefined, follower.token)).status, 204);
    assert.equal((await f.call('POST', `/v1/setups/${s.setupId}/revisions`, publication(1), follower.token)).status, 404);
  } finally { await f.close(); }
});
