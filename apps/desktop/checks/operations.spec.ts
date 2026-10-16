import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bridge } from '../src/bridge.ts';
import { decodeHostEvent } from '../src/bridge.ts';
import { operation } from '../src/operations.ts';

const run = {
  runId: 'run-1', state: 'running', operation: 'applyChange', scope: { kind: 'machine' },
  intent: { requestId: 'request-1', inputDigest: 'a'.repeat(64), planId: 'plan-1', change: { kind: 'reconcile', only: [] } },
  intentSaved: false, steps: [], result: null,
};

test('operation decodes typed output through the registry', async () => {
  const input = { scope: { kind: 'machine' as const }, runId: 'run-1' };
  const bridge: Bridge = {
    subscribe: async () => () => {},
    invoke: async (command, args) => {
      assert.equal(command, 'operation');
      assert.deepEqual(args, { name: 'getRun', input });
      return { generation: 7, data: run };
    },
  };
  const result = await operation(bridge, 'getRun', input);
  assert.equal(result.generation, 7);
  assert.equal(result.data.runId, 'run-1');
});

test('operation rejects output that fails the registry schema', async () => {
  const bridge: Bridge = {
    subscribe: async () => () => {},
    invoke: async () => ({ generation: 7, data: { ...run, state: 'unknown' } }),
  };
  await assert.rejects(operation(bridge, 'getRun', { scope: { kind: 'machine' }, runId: 'run-1' }), /Invalid operation response/);
});

test('host status events retain the causing run and connection generation', () => {
  const event = decodeHostEvent({
    version: 3, generation: 7, event: 'status', runId: 'run-1',
    status: { at: 'now', policy: 'notify', paused: null, trusted: true, pending: [], drift: [], conflicts: [], probeErrors: [], counts: { pending: 0, held: 0, ready: 0, drift: 0 } },
  });
  assert.equal(event.event, 'status');
  if (event.event !== 'status') assert.fail('Expected status');
  assert.equal(event.runId, 'run-1');
  assert.equal(event.generation, 7);
});
