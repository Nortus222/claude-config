import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFixture } from '../backend/fixture.ts';
import { decodeRequest, decodeMessage } from '../backend/protocol.ts';

test('machine overrides win and preview compares current with resolved values', () => {
  const fixture = inspectFixture();
  assert.deepEqual(
    fixture.rows.find((row) => row.key === 'model'),
    {
      key: 'model',
      base: 'balanced',
      override: 'fast',
      desired: 'fast',
      current: 'balanced',
      source: 'machine override',
      changed: true,
    },
  );
  assert.equal(fixture.rows.find((row) => row.key === 'theme')?.source, 'base profile');
  assert.deepEqual(fixture.diff, [
    { key: 'model', before: 'balanced', after: 'fast' },
    { key: 'telemetry', before: true, after: false },
  ]);
});

test('protocol rejects unknown commands, versions and arbitrary arguments', () => {
  assert.equal(decodeRequest({ version: 1, id: 'x', command: 'inspect' }).command, 'inspect');
  for (const value of [
    { version: 2, id: 'x', command: 'inspect' },
    { version: 1, id: 'x', command: 'shell' },
    { version: 1, id: 'x', command: 'start', path: '/tmp/anything' },
    { version: 1, id: '', command: 'cancel' },
  ])
    assert.throws(() => decodeRequest(value));
});

test('progress contract rejects out-of-range percent and unknown states', () => {
  const event = {
    version: 1,
    event: 'progress',
    operationId: 'op',
    state: 'running',
    percent: 0,
    detail: 'Preparing',
  };
  assert.deepEqual(decodeMessage(event), event);
  assert.throws(() => decodeMessage({ ...event, percent: 101 }));
  assert.throws(() => decodeMessage({ ...event, state: 'invented' }));
});
