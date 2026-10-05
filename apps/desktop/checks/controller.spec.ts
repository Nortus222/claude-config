import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureController } from '../src/controller.ts';
import { inspectFixture } from '../backend/fixture.ts';

test('subscriptions precede requests, early progress is retained, and stale events are ignored', async () => {
  let callback: (event: any) => void = () => {};
  const order: string[] = [];
  const controller = new FixtureController({
    subscribe: async (receive) => {
      order.push('subscribe');
      callback = receive;
      return () => order.push('unlisten');
    },
    invoke: async (command) => {
      order.push(command);
      if (command === 'start_fixture') {
        callback({
          generation: 1,
          version: 1,
          event: 'progress',
          operationId: 'fresh',
          state: 'running',
          percent: 40,
          detail: 'Working',
        });
        return { generation: 1, data: { operationId: 'fresh' } };
      }
      return { generation: 1, data: inspectFixture() };
    },
  });
  await controller.connect();
  assert.deepEqual(order.slice(0, 2), ['subscribe', 'inspect_fixture']);
  await controller.start();
  assert.equal(controller.state.operation?.percent, 40);
  callback({
    generation: 1,
    version: 1,
    event: 'progress',
    operationId: 'old',
    state: 'completed',
    percent: 100,
    detail: 'stale',
  });
  assert.equal(controller.state.operation?.state, 'running');
  callback({ generation: 0, event: 'disconnected', detail: 'stale exit' });
  assert.equal(controller.state.connection, 'connected');
  controller.dispose();
  assert.equal(order.at(-1), 'unlisten');
});

test('disconnect ends work, explicit restart clears operation and ignores previous generation', async () => {
  let callback: (event: any) => void = () => {};
  const controller = new FixtureController({
    subscribe: async (receive) => {
      callback = receive;
      return () => {};
    },
    invoke: async (command) => ({
      generation: command === 'restart_backend' ? 2 : 1,
      data: command === 'start_fixture' ? { operationId: 'op' } : inspectFixture(),
    }),
  });
  await controller.connect();
  await controller.start();
  callback({ generation: 1, event: 'disconnected', detail: 'Backend died' });
  assert.equal(controller.state.connection, 'disconnected');
  await controller.restart();
  assert.equal(controller.state.operation, null);
  callback({ generation: 1, event: 'disconnected', detail: 'Late old exit' });
  assert.equal(controller.state.connection, 'connected');
  controller.dispose();
});

test('disposing while subscribe resolves unregisters and prevents the initial request', async () => {
  let finish: (value: () => void) => void = () => {};
  let removed = 0,
    requests = 0;
  const controller = new FixtureController({
    subscribe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    invoke: async () => {
      requests++;
      return { generation: 1, data: inspectFixture() };
    },
  });
  const connected = controller.connect();
  controller.dispose();
  finish(() => removed++);
  await connected;
  assert.equal(removed, 1);
  assert.equal(requests, 0);
});
