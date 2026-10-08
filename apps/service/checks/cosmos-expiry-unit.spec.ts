import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Database, FeedOptions, SqlQuerySpec } from '@azure/cosmos';
import { Effect } from 'effect';
import { makeCosmosStore } from '../src/cosmos-store.ts';
import type { DeviceSessionDocument } from '../src/documents.ts';

test('SDK unit: expiry scan visits every page and rechecks current point deadlines', async () => {
  let pages = 0; const points: string[] = []; let writes = 0;
  const session = (id: string): DeviceSessionDocument => ({ type: 'deviceSession', version: 1, id, pendingId: id.slice(7),
    deviceCode: 'temporary', description: { name: 'Machine', os: 'linux', agents: [] }, createdAt: 0, expiresAt: 2000,
    interval: 5, nextPollAt: 5, state: 'pending', claim: null });
  const database = { container: (name: string) => {
    assert.equal(name, 'identities');
    return { items: { query: (spec: SqlQuerySpec, options: FeedOptions) => {
      assert.equal(options.partitionKey, undefined); assert.equal(options.consistencyLevel, 'Strong');
      assert.equal(options.maxItemCount, 1);
      assert.ok(spec.query.includes('c.payload.expiresAt <= @now'));
      assert.deepEqual(spec.parameters, [{ name: '@now', value: 1000 }]);
      let next = 0;
      return { hasMoreResults: () => next < 2, fetchNext: async () => { pages++; return { resources: [{ id: `device:${++next}` }] }; } };
    } }, item: (id: string, key: string) => {
      assert.equal(key, id);
      return { read: async () => { assert.equal(pages, 2, 'finish scanning before cleanup mutates query rows'); points.push(id); return { resource: { id, _etag: 'fresh', payload: session(id) } }; },
        replace: async () => { writes++; }, delete: async () => { writes++; } };
    } };
  } } as unknown as Database;
  const store = makeCosmosStore({ database, now: () => 1000, pageSize: 1 });
  await Effect.runPromise(store.sweepExpiredDevices());
  assert.equal(pages, 2); assert.deepEqual(points, ['device:1', 'device:2']); assert.equal(writes, 0);
});

test('expiry page cancellation aborts the iterator signal and cannot begin point recovery after late page completion', async () => {
  let release: (() => void) | undefined; let querySignal: AbortSignal | undefined; let points = 0;
  const database = { container: () => ({
    item: () => { points++; throw new Error('recovery must not start'); },
    items: { query: (_spec: unknown, options: { abortSignal: AbortSignal }) => {
      querySignal = options.abortSignal; let more = true;
      return { hasMoreResults: () => more, fetchNext: () => new Promise((resolve) => { release = () => { more = false; resolve({ resources: [{ id: 'candidate' }] }); }; }) };
    } },
  }) } as unknown as Database;
  const controller = new AbortController();
  const running = Effect.runPromise(makeCosmosStore({ database }).sweepExpiredDevices(), { signal: controller.signal });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  controller.abort(); await assert.rejects(running); assert.equal(querySignal!.aborted, true);
  release(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(points, 0);
});
