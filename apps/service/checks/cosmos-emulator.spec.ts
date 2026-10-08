import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect } from 'effect';
import { cosmosDocumentId, makeCosmosStore } from '../src/cosmos-store.ts';
import { createCosmosFixture, emulatorConfigured, requireEmulatorConfiguration } from './support/cosmos.ts';
import { account, decision, upsert, registerStoreContract } from './support/store-contract.ts';

if (process.env.NORTUSCC_COSMOS_REQUIRED === '1') requireEmulatorConfiguration();
if (!emulatorConfigured()) {
  test('Cosmos emulator Store contracts require explicit local configuration', { skip: true }, () => {});
} else {
  registerStoreContract('Cosmos emulator', () => createCosmosFixture({ pageSize: 7 }));

  test('Cosmos stores opaque payload IDs and minimal permanent markers in approved partitions', async (t) => {
    const { store, database, dispose } = await createCosmosFixture(); t.after(dispose);
    const document = { ...decision(0), id: 'decision:setup-a:skill:owner/repo#name?x\\y' };
    assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(document)])), true);
    const raw = await database.container('accounts').item(cosmosDocumentId(document.id), 'account-a').read();
    assert.equal(raw.resource?.id, cosmosDocumentId(document.id));
    assert.deepEqual(raw.resource?.payload, document);
    const snapshot = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    assert.deepEqual(snapshot.documents, [document]);
    const marker = await database.container('accounts').item('__partition', 'account-a').read();
    assert.equal(snapshot.version, marker.resource?._etag);
    assert.equal(await Effect.runPromise(store.closePartition('accounts', 'account-a', snapshot.version)), true);
    const closed = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    await Effect.runPromise(store.commitPartition('accounts', 'account-a', closed.version, [{ type: 'delete', id: document.id }]));
    const remaining = (await database.container('accounts').items.query('SELECT * FROM c', { partitionKey: 'account-a' }).fetchAll()).resources;
    assert.equal(remaining.length, 1);
    assert.deepEqual(Object.keys(remaining[0]).filter((key) => !['_rid', '_self', '_etag', '_attachments', '_ts'].includes(key)).sort(), ['accountId', 'closed', 'id']);
    assert.equal(remaining[0].closed, true);
  });

  test('Cosmos identity ETag fences update, deletion and recreation without a marker', async (t) => {
    const { store, database, dispose } = await createCosmosFixture(); t.after(dispose);
    const identity = { type: 'identity' as const, version: 1 as const, id: 'github:123', githubId: 123, accountId: 'account-a', state: 'reserved' as const };
    await Effect.runPromise(store.commitPartition('identities', identity.id, null, [upsert(identity)]));
    const first = await Effect.runPromise(store.readPartition('identities', identity.id));
    const raw = await database.container('identities').item(identity.id, identity.id).read();
    assert.equal(first.version, raw.resource?._etag);
    assert.equal(raw.resource?.ttl, undefined);
    assert.equal(await Effect.runPromise(store.commitPartition('identities', identity.id, first.version, [{ type: 'delete', id: identity.id }])), true);
    assert.equal(await Effect.runPromise(store.commitPartition('identities', identity.id, first.version, [upsert(identity)])), false);
    assert.equal(await Effect.runPromise(store.commitPartition('identities', identity.id, null, [upsert(identity)])), true);
    assert.equal(await Effect.runPromise(store.commitPartition('identities', identity.id, first.version, [{ type: 'delete', id: identity.id }])), false);
    assert.equal((await database.container('identities').items.query('SELECT * FROM c', { partitionKey: identity.id }).fetchAll()).resources.length, 1);
  });

  test('Cosmos missing deletes are no-ops even beside existing upserts', async (t) => {
    const { store, dispose } = await createCosmosFixture(); t.after(dispose);
    assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [{ type: 'delete', id: 'absent' }])), true);
    assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [{ type: 'delete', id: 'absent' }, upsert(account())])), true);
    const snapshot = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    assert.deepEqual(snapshot.documents, [account()]);
  });

  test('actual Cosmos pages retry a snapshot when a writer changes the marker between pages', async (t) => {
    const fixture = await createCosmosFixture({ pageSize: 1 }); t.after(fixture.dispose);
    const { database, store } = fixture;
    await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account()), ...[0, 1, 2].map((i) => upsert(decision(i)))]));
    // Wrap only scheduling, preserving the actual SDK iterator and actual emulator reads/writes.
    const container = database.container('accounts');
    const originalQuery = container.items.query.bind(container.items);
    let pages = 0; let mutated = false;
    const originalContainer = database.container.bind(database);
    const query = (...args: Parameters<typeof originalQuery>) => {
      const iterator = originalQuery(...args);
      const next = iterator.fetchNext.bind(iterator);
      iterator.fetchNext = async () => {
        const page = await next(); pages++;
        if (!mutated) {
          mutated = true;
          const current = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
          await Effect.runPromise(store.commitPartition('accounts', 'account-a', current.version, [upsert({ ...account(), seq: 9 }), { type: 'delete', id: decision(2).id }]));
        }
        return page;
      };
      return iterator;
    };
    const wrapped = Object.create(database);
    wrapped.container = (name: string) => name === 'accounts' ? { item: container.item.bind(container), items: { query } } : originalContainer(name);
    const reader = makeCosmosStore({ database: wrapped, pageSize: 1 });
    const snapshot = await Effect.runPromise(reader.readPartition('accounts', 'account-a'));
    assert.ok(pages >= 4);
    assert.equal(snapshot.documents.length, 3);
    assert.equal((snapshot.documents.find((d) => d.type === 'account') as ReturnType<typeof account>).seq, 9);
    assert.deepEqual(snapshot, await Effect.runPromise(store.readPartition('accounts', 'account-a')));
  });
  test('actual Cosmos marker deletion CAS cannot erase a writer that wins after the sweep read', async (t) => {
    const { database, store, dispose } = await createCosmosFixture(); t.after(dispose);
    await Effect.runPromise(store.commitPartition('accounts', 'account-a', null, [upsert(account())]));
    const before = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    const container = database.container('accounts');
    const wrapped = Object.create(database);
    wrapped.container = () => ({ item: container.item.bind(container), items: {
      query: container.items.query.bind(container.items),
      batch: async (...args: Parameters<typeof container.items.batch>) => {
        assert.equal(args[0][0].operationType, 'Delete');
        assert.equal(await Effect.runPromise(store.commitPartition('accounts', 'account-a', before.version, [upsert({ ...account(), seq: 2 })])), true);
        return container.items.batch(...args);
      },
    } });
    const pausedSweeper = makeCosmosStore({ database: wrapped });
    assert.equal(await Effect.runPromise(pausedSweeper.commitPartition('accounts', 'account-a', before.version, [{ type: 'delete', id: 'account' }])), false);
    const after = await Effect.runPromise(store.readPartition('accounts', 'account-a'));
    assert.deepEqual(after.documents, [{ ...account(), seq: 2 }]);
    assert.notEqual(after.version, before.version);
  });

}
