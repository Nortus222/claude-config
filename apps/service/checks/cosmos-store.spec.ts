import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeCosmosStore, cosmosDocumentId } from '../src/cosmos-store.ts';

import type { Database, FeedOptions, RequestOptions } from '@azure/cosmos';
import { Effect } from 'effect';
import { MAX_COSMOS_BATCH_BYTES, validateCosmosConfiguration } from '../src/cosmos-store.ts';
import { account, upsert } from './support/store-contract.ts';
import { requireEmulatorConfiguration } from './support/cosmos.ts';

test('physical IDs reversibly encode unsafe logical IDs without marker collisions', () => {
  const ids = ['account', 'decision:setup:skill:owner/repo#name?x\\y', '~escaped', '__partition-other'];
  assert.equal(new Set(ids.map(cosmosDocumentId)).size, ids.length);
  for (const id of ids) {
    assert.doesNotMatch(cosmosDocumentId(id), /[/#?\\]/);
    assert.equal(Buffer.from(cosmosDocumentId(id).slice(1), 'base64url').toString(), id);
  }
  assert.equal(typeof makeCosmosStore, 'function');
});

// These SDK boundary doubles exercise error mapping, not emulator transaction behavior.
const fakeDatabase = (options: { batch?: () => Promise<unknown>; point?: (options: RequestOptions) => Promise<unknown>; query?: (spec: unknown, options: FeedOptions) => unknown } = {}): Database => ({
  container: () => ({
    item: () => ({ read: options.point ?? (async () => ({ statusCode: 404 })) }),
    items: { query: options.query ?? (() => ({ hasMoreResults: () => false })), batch: options.batch },
  }),
}) as unknown as Database;

const resultOf = async (database: Database) => Effect.runPromise(Effect.result(makeCosmosStore({ database }).commitPartition('accounts', 'account-a', null, [upsert(account())])));

test('batch rollback siblings do not hide the actual conditional conflict', async () => {
  for (const code of [409, 412]) {
    const result = await resultOf(fakeDatabase({ batch: async () => ({ code: 207, result: [{ statusCode: 424 }, { statusCode: code }] }) }));
    assert.equal(result._tag, 'Success'); if (result._tag === 'Success') assert.equal(result.success, false);
  }
  const wrapped = await resultOf(fakeDatabase({ batch: async () => { throw new Error('private SDK message', { cause: { code: 412 } }); } }));
  assert.equal(wrapped._tag, 'Success'); if (wrapped._tag === 'Success') assert.equal(wrapped.success, false);
});

test('SDK failures and standalone 424 redact diagnostics and preserve Retry-After', async () => {
  for (const batch of [
    async () => ({ code: 207, result: [{ statusCode: 424 }, { statusCode: 429 }], headers: { 'x-ms-retry-after-ms': '2300' } }),
    async () => { throw new Error('secret deviceCode', { cause: { code: 429, retryAfterInMs: 2300 } }); },
  ]) {
    const result = await resultOf(fakeDatabase({ batch }));
    assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') {
      assert.equal(result.failure.code, 'unavailable'); assert.equal(result.failure.retryAfter, 3);
      assert.equal(result.failure.message, 'Request failed.'); assert.equal(result.failure.cause, undefined);
    }
    assert.doesNotMatch(JSON.stringify(result), /deviceCode|secret|SDK/);
  }
  const orphan = await resultOf(fakeDatabase({ batch: async () => ({ code: 207, result: [{ statusCode: 424 }] }) }));
  assert.equal(orphan._tag, 'Failure');
});

test('snapshot retry budget rejects continuously changing markers with Strong partition reads', async () => {
  let reads = 0; let pages = 0;
  const database = fakeDatabase({
    point: async (options) => {
      assert.equal(options.consistencyLevel, 'Strong');
      return { resource: { id: '__partition', accountId: 'account-a', closed: false, _etag: `${++reads}` } };
    },
    query: (_spec, options) => {
      assert.equal(options.consistencyLevel, 'Strong'); assert.equal(options.partitionKey, 'account-a');
      let done = false;
      return { hasMoreResults: () => !done, fetchNext: async () => { done = true; pages++; return { resources: [] }; } };
    },
  });
  const result = await Effect.runPromise(Effect.result(makeCosmosStore({ database, maxSnapshotAttempts: 3 }).readPartition('accounts', 'account-a')));
  assert.equal(result._tag, 'Failure'); assert.equal(reads, 6); assert.equal(pages, 3);
});

test('oversized atomic writes and unsafe singleton IDs fail before SDK access', async () => {
  let calls = 0;
  const database = { container: () => { calls++; throw new Error('SDK must not be called'); } } as unknown as Database;
  const store = makeCosmosStore({ database });
  const huge = { ...account(), login: 'x'.repeat(MAX_COSMOS_BATCH_BYTES) };
  const size = await Effect.runPromise(Effect.result(store.commitPartition('accounts', 'account-a', null, [upsert(huge)])));
  assert.equal(size._tag, 'Failure'); if (size._tag === 'Failure') assert.equal(size.failure.code, 'payload_too_large');
  const id = 'github:unsafe/key';
  const identity = { type: 'identity' as const, version: 1 as const, id, githubId: 1, accountId: 'account-a', state: 'active' as const };
  const bad = await Effect.runPromise(Effect.result(store.commitPartition('identities', id, null, [upsert(identity)])));
  assert.equal(bad._tag, 'Failure'); assert.equal(calls, 0);
});

test('configuration checks partition paths, TTL and Strong account support without mutations', async () => {
  for (const bad of ['none', 'consistency', 'partition', 'ttl', 'accountsTtl']) {
    const database = {
      client: { getDatabaseAccount: async () => ({ resource: { consistencyPolicy: bad === 'consistency' ? 'Session' : 'Strong' } }) },
      container: (name: string) => ({ read: async () => ({ resource: {
        partitionKey: { paths: [bad === 'partition' ? '/wrong' : ({ accounts: '/accountId', setups: '/setupId', identities: '/id' })[name]] },
        ...(name === 'identities' ? { defaultTtl: bad === 'ttl' ? 900 : -1 } : bad === 'accountsTtl' ? { defaultTtl: 10 } : {}),
      } }) }),
    } as unknown as Database;
    const result = await Effect.runPromise(Effect.result(validateCosmosConfiguration(database)));
    assert.equal(result._tag, bad === 'none' ? 'Success' : 'Failure');
  }
});

test('emulator harness rejects remote and malformed endpoints before creating a client', () => {
  const endpoint = process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT;
  const key = process.env.NORTUSCC_COSMOS_EMULATOR_KEY;
  try {
    process.env.NORTUSCC_COSMOS_EMULATOR_KEY = 'dummy';
    for (const value of ['https://cloud.documents.azure.com', 'http://127.0.0.1.evil', 'http://localhost/dbs', 'http://secret@localhost', 'http://localhost?secret=yes', 'file://localhost']) {
      process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT = value;
      assert.throws(requireEmulatorConfiguration);
    }
  } finally {
    if (endpoint === undefined) delete process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT; else process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT = endpoint;
    if (key === undefined) delete process.env.NORTUSCC_COSMOS_EMULATOR_KEY; else process.env.NORTUSCC_COSMOS_EMULATOR_KEY = key;
  }
});
