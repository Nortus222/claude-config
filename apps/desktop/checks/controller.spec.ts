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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
for (const action of ['connect', 'restart'] as const)
  test(`${action} retains a matching disconnect received before its successful response`, async () => {
    let receive: (event: any) => void = () => {};
    const controller = new FixtureController({
      subscribe: async (callback) => {
        receive = callback;
        return () => {};
      },
      invoke: async (command) => {
        const generation = command === 'restart_backend' ? 2 : 1;
        if (action === 'connect' || command === 'restart_backend')
          receive({ generation, event: 'disconnected', detail: 'Early backend exit' });
        return { generation, data: inspectFixture() };
      },
    });
    await controller.connect();
    if (action === 'restart') await controller.restart();
    assert.equal(controller.state.connection, 'disconnected');
    assert.equal(controller.state.detail, 'Early backend exit');
    assert.equal(controller.state.pending, false);
    controller.dispose();
  });

for (const outcome of ['resolve', 'reject'] as const)
  test(`old start ${outcome} cannot release a pending restart or disrupt a fresh start`, async () => {
    const old = deferred<any>(),
      restarting = deferred<any>(),
      fresh = deferred<any>();
    let receive: (event: any) => void = () => {},
      starts = 0;
    const controller = new FixtureController({
      subscribe: async (callback) => {
        receive = callback;
        return () => {};
      },
      invoke: async (command) => {
        if (command === 'start_fixture') return ++starts === 1 ? old.promise : fresh.promise;
        if (command === 'restart_backend') return restarting.promise;
        return { generation: 1, data: inspectFixture() };
      },
    });
    await controller.connect();
    const oldStart = controller.start();
    receive({ generation: 1, event: 'disconnected', detail: 'Dead' });
    const restart = controller.restart();
    const restartState = controller.state;
    if (outcome === 'resolve') old.resolve({ generation: 1, data: { operationId: 'old' } });
    else old.reject(new Error('Old request failed'));
    await oldStart;
    assert.deepEqual(controller.state, restartState);
    restarting.resolve({ generation: 2, data: inspectFixture() });
    await restart;
    const freshStart = controller.start();
    receive({
      generation: 2,
      version: 1,
      event: 'progress',
      operationId: 'fresh',
      state: 'running',
      percent: 40,
      detail: 'Fresh progress',
    });
    fresh.resolve({ generation: 2, data: { operationId: 'fresh' } });
    await freshStart;
    assert.equal(controller.state.operation?.percent, 40);
    controller.dispose();
  });

test('late old start rejection cannot clear the early-progress buffer of a fresh start', async () => {
  const old = deferred<any>(),
    fresh = deferred<any>();
  let receive: (event: any) => void = () => {},
    starts = 0;
  const controller = new FixtureController({
    subscribe: async (callback) => {
      receive = callback;
      return () => {};
    },
    invoke: async (command) => {
      if (command === 'start_fixture') return ++starts === 1 ? old.promise : fresh.promise;
      return { generation: command === 'restart_backend' ? 2 : 1, data: inspectFixture() };
    },
  });
  await controller.connect();
  const oldStart = controller.start();
  receive({ generation: 1, event: 'disconnected', detail: 'Dead' });
  await controller.restart();
  const freshStart = controller.start();
  old.reject(new Error('Late old failure'));
  await oldStart;
  assert.equal(controller.state.pending, true);
  receive({
    generation: 2,
    version: 1,
    event: 'progress',
    operationId: 'fresh',
    state: 'running',
    percent: 50,
    detail: 'Fresh progress',
  });
  fresh.resolve({ generation: 2, data: { operationId: 'fresh' } });
  await freshStart;
  assert.equal(controller.state.operation?.percent, 50);
  controller.dispose();
});

for (const command of ['cancel_fixture', 'crash_probe'] as const)
  test(`late ${command} rejection cannot overwrite restart state`, async () => {
    const old = deferred<any>(),
      restarting = deferred<any>();
    let receive: (event: any) => void = () => {};
    const controller = new FixtureController({
      subscribe: async (callback) => {
        receive = callback;
        return () => {};
      },
      invoke: async (requested) => {
        if (requested === command) return old.promise;
        if (requested === 'restart_backend') return restarting.promise;
        return { generation: 1, data: inspectFixture() };
      },
    });
    await controller.connect();
    const action = command === 'cancel_fixture' ? controller.cancel() : controller.crash();
    receive({ generation: 1, event: 'disconnected', detail: 'Dead' });
    const restart = controller.restart();
    const expected = controller.state;
    old.reject(new Error('Old failure'));
    await action;
    assert.deepEqual(controller.state, expected);
    restarting.resolve({ generation: 2, data: inspectFixture() });
    await restart;
    controller.dispose();
  });

for (const outcome of ['resolve', 'reject'] as const)
  test(`superseded refresh ${outcome} cannot change a new action's state`, async () => {
    const refreshing = deferred<any>(),
      newStart = deferred<any>();
    let receive: (event: any) => void = () => {},
      inspections = 0,
      starts = 0;
    const controller = new FixtureController({
      subscribe: async (callback) => {
        receive = callback;
        return () => {};
      },
      invoke: async (command) => {
        if (command === 'inspect_fixture' && ++inspections > 1) return refreshing.promise;
        if (command === 'start_fixture')
          return ++starts === 1
            ? { generation: 1, data: { operationId: 'first' } }
            : newStart.promise;
        return { generation: 1, data: inspectFixture() };
      },
    });
    await controller.connect();
    await controller.start();
    receive({
      generation: 1,
      version: 1,
      event: 'progress',
      operationId: 'first',
      state: 'completed',
      percent: 100,
      detail: 'Done',
    });
    const starting = controller.start();
    const expected = controller.state;
    if (outcome === 'reject') refreshing.reject(new Error('Old refresh failed'));
    else
      refreshing.resolve({
        generation: 1,
        data: inspectFixture({ model: 'fast', theme: 'dark', telemetry: false }),
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(controller.state, expected);
    newStart.resolve({ generation: 1, data: { operationId: 'new' } });
    await starting;
    controller.dispose();
  });
