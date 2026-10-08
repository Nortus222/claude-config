import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { makeMemoryStore, memoryStore } from '../src/memory-store.ts';
import { Store } from '../src/store.ts';
import { newId, newTokenSecret, hashTokenSecret, verifyTokenSecret, machineToken } from '../src/ids.ts';
import { account, upsert, registerStoreContract } from './support/store-contract.ts';

registerStoreContract('memory', async () => ({ store: makeMemoryStore(), dispose: async () => {} }));

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
