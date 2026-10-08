import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import type { AccountDocument, DecisionDocument, ServiceDocument } from '../src/documents.ts';
import { makeMemoryStore, memoryStore } from '../src/memory-store.ts';
import { Store } from '../src/store.ts';
import { ServiceFailure } from '../src/errors.ts';
import { newId, newTokenSecret, hashTokenSecret, verifyTokenSecret, machineToken } from '../src/ids.ts';

const account = (accountId = 'account-a'): AccountDocument => ({
  type: 'account', version: 1, id: 'account', accountId, githubId: 123, login: 'owner', seq: 0,
  defaultPolicy: 'notify', createdAt: '2026-10-07T00:00:00Z', state: 'active', setups: [],
});
const decision = (index: number): DecisionDocument => ({
  type: 'decision', version: 1, id: `decision:setup-a:setting:claude:key-${index}`, accountId: 'account-a',
  setupId: 'setup-a', itemId: `setting:claude:key-${index}`, revision: 1, decision: 'accept',
  decidedAt: '2026-10-07T00:00:00Z', machineId: 'machine-a', seq: index + 1,
});
const upsert = (document: ServiceDocument) => ({ type: 'upsert' as const, document });

test('absent partitions accept one null CAS and then require their marker version', async () => {
  const store = makeMemoryStore();
  assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'account-a')), { version: null, documents: [] });
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', 'stale', [upsert(account())])), false);
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account())])), true);
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account())])), false);
  assert.equal(typeof (await Effect.runPromise(store.readPartition('accounts', 'account-a'))).version, 'string');
});

test('snapshots and committed input are detached from stored nested metadata', async () => {
  const store = makeMemoryStore();
  const source = account();
  await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(source)]));
  (source as { login: string }).login = 'input-changed';
  const first = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
  const readAccount = first.documents[0] as AccountDocument;
  (readAccount as { login: string }).login = 'snapshot-changed';
  (readAccount.setups as unknown[]).push({ setupId: 'injected' });
  (first.documents as ServiceDocument[]).length = 0;
  assert.deepEqual((await Effect.runPromise(store.readPartition('accounts', 'account-a'))).documents, [account()]);
});

test('concurrent writes to the same marker have exactly one winner', async () => {
  const store = makeMemoryStore();
  await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account())]));
  const before = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
  const results = await Promise.all([1, 2].map((seq) => Effect.runPromise(
    store.commitPartition('accounts', 'account-a', before.version, [upsert({ ...account(), seq })]),
  )));
  assert.deepEqual(results.sort(), [false, true]);
  assert.notEqual((await Effect.runPromise(store.readPartition('accounts', 'account-a'))).version, before.version);
});

test('a stale commit leaves all prior documents and the marker unchanged', async () => {
  const store = makeMemoryStore();
  await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account()), upsert(decision(0))]));
  const before = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', 'stale', [
    { type: 'delete', id: 'account' }, upsert(decision(1)),
  ])), false);
  assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'account-a')), before);
});

test('partition mismatches fail generically without applying any mutation', async () => {
  const store = makeMemoryStore();
  for (const [container, key, document] of [
    ['accounts', 'account-a', account('account-b')],
    ['setups', 'account-a', account()],
    ['identities', 'account-a', account()],
  ] as const) {
    const result = await Effect.runPromise(Effect.result(store.commitPartition(container, key, null, [upsert(document)])));
    assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') {
      assert.ok(result.failure instanceof ServiceFailure);
      assert.equal(result.failure.code, 'invalid');
      assert.equal(result.failure.message, 'Request failed.');
      assert.ok(!JSON.stringify(result.failure).includes(key));
    }
    assert.deepEqual(await Effect.runPromise(store.readPartition(container, key)), { version: null, documents: [] });
  }
});

test('99 document operations fit beside the marker while 100 fail atomically', async () => {
  const store = makeMemoryStore();
  const oversized = Array.from({ length: 100 }, (_, i) => upsert(decision(i)));
  const failure = await Effect.runPromise(Effect.result(store.commitPartition('accounts', 'account-a', null, oversized)));
  assert.equal(failure._tag, 'Failure');
  assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'account-a')), { version: null, documents: [] });
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, oversized.slice(0, 99))), true);
  assert.equal((await Effect.runPromise(store.readPartition('accounts', 'account-a'))).documents.length, 99);
});

test('duplicate document targets including delete plus upsert fail atomically', async () => {
  const store = makeMemoryStore();
  for (const mutations of [[upsert(account()), upsert(account())], [upsert(account()), { type: 'delete' as const, id: 'account' }]]) {
    const failure = await Effect.runPromise(Effect.result(store.commitPartition('accounts', 'account-a', null, mutations)));
    assert.equal(failure._tag, 'Failure');
    assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'account-a')), { version: null, documents: [] });
  }
});

test('deletion sweeps remove every document and stale CAS cannot target a recreated partition', async () => {
  const store = makeMemoryStore();
  for (let start = 0; start < 205; start += 99) {
    const snapshot = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    const writes = Array.from({ length: Math.min(99, 205 - start) }, (_, i) => upsert(decision(start + i)));
    assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', snapshot.version, writes)), true);
  }
  const full = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
  assert.equal(full.documents.length, 205);
  for (;;) {
    const snapshot = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    if (snapshot.documents.length === 0) break;
    assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', snapshot.version,
      snapshot.documents.slice(0, 99).map(({ id }) => ({ type: 'delete', id })))), true);
  }
  assert.deepEqual(await Effect.runPromise(store.readPartition('accounts', 'account-a')), { version: null, documents: [] });
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account())])), true);
  assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', full.version, [upsert(account())])), false);
});

test('identity documents use their id as partition key and remain separate from device sessions', async () => {
  const store = makeMemoryStore();
  const identity = { type: 'identity' as const, version: 1 as const, id: 'github:123', githubId: 123, accountId: 'account-a', state: 'reserved' as const };
  assert.equal(await Effect.runPromise(store.commitPartition('identities', identity.id, null, [upsert(identity)])), true);
  const failure = await Effect.runPromise(Effect.result(store.commitPartition('identities', 'github:456', null, [upsert(identity)])));
  assert.equal(failure._tag, 'Failure');
  assert.deepEqual((await Effect.runPromise(store.readPartition('identities', identity.id))).documents, [identity]);
});

test('memoryStore is an isolated Effect layer exposing the same Store contract', async () => {
  const program = Effect.gen(function* () {
    const store = yield* Store;
    yield* store.commitPartition('accounts', 'account-a', null, [upsert(account())]);
    return yield* store.readPartition('accounts', 'account-a');
  });
  assert.equal((await Effect.runPromise(program.pipe(Effect.provide(memoryStore())))).documents.length, 1);
});

test('random IDs are valid ULIDs and encode the supplied timestamp', async () => {
  const ids = Array.from({ length: 500 }, () => newId(1791331200000));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)));
  assert.ok(ids.every((id) => id.slice(0, 10) === ids[0].slice(0, 10)));
  assert.ok(newId(0).startsWith('0000000000'));
  assert.throws(() => newId(-1));
  assert.throws(() => newId(2 ** 48));
});

test('credentials use 32 random bytes and SHA256 with safe malformed-hash rejection', async () => {
  const secret = newTokenSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.notEqual(secret, newTokenSecret());
  assert.equal(hashTokenSecret('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const hash = hashTokenSecret(secret);
  assert.equal(verifyTokenSecret(secret, hash), true);
  assert.equal(verifyTokenSecret(newTokenSecret(), hash), false);
  for (const malformed of ['', 'x'.repeat(64), 'a'.repeat(63), hash.toUpperCase()]) assert.equal(verifyTokenSecret(secret, malformed), false);
  assert.equal(machineToken('account-a', 'machine-a', secret), `nmt_account-a_machine-a_${secret}`);
});
