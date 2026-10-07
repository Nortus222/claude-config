import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXCLUDED, MAX_HISTORY, MAX_RECORD_BYTES, PROTOCOL_VERSION,
  decodeHelloResult, decodeMessage, decodeRequest, toWireStatus, type AgentStatus,
} from '../src/index.ts';

const SHA = 'a'.repeat(40);
const head = { version: 3, id: '1' } as const;

// Every v3 request shape, each with all of its own arguments.
const accepted: ReadonlyArray<Record<string, unknown>> = [
  { ...head, command: 'hello', token: 't0k3n', client: 'app' },
  { ...head, command: 'hello', token: 'x'.repeat(200), client: 'cli' },
  { ...head, command: 'status' },
  { ...head, command: 'inspect' },
  { ...head, command: 'cancel' },
  { ...head, command: 'resume' },
  { ...head, command: 'shutdown' },
  { ...head, command: 'subscribe' },
  { ...head, command: 'preview', exclude: [] },
  { ...head, command: 'preview', exclude: ['config:claude:settings.json#model'] },
  { ...head, command: 'apply', planId: 'p' },
  { ...head, command: 'decide', items: [] },
  { ...head, command: 'decide', items: [{ setupId: 'local', id: 'setting:claude:settings.json#model', revision: SHA, decision: 'accept' }] },
  { ...head, command: 'decide', items: [{ setupId: 'local', id: 'skill:x', revision: 'b'.repeat(64), decision: 'skip' }] },
  { ...head, command: 'setPolicy', policy: 'auto-apply' },
  { ...head, command: 'setPolicy', policy: 'notify' },
  { ...head, command: 'setPolicy', policy: 'manual' },
  { ...head, command: 'history', limit: 1 },
  { ...head, command: 'history', limit: 1, before: { at: '2026-10-06T05:00:00-07:00', seq: Number.MAX_SAFE_INTEGER } },
  { ...head, command: 'history', limit: MAX_HISTORY, before: { at: '2026-10-06T12:00:00.000Z', seq: 0 } },
];

test('every v3 request shape decodes to itself', () => {
  for (const request of accepted) assert.deepEqual(decodeRequest(request), request, JSON.stringify(request));
});

test('an unknown field on any request is rejected', () => {
  for (const request of accepted) assert.throws(() => decodeRequest({ ...request, path: '/etc' }), JSON.stringify(request));
});

test('requests outside v3 are rejected', () => {
  const decision = { setupId: 'local', id: 'skill:x', revision: SHA, decision: 'accept' };
  for (const bad of [
    { version: 2, id: '1', command: 'inspect' },
    { version: 2, id: '1', command: 'hello', token: 't', client: 'app' },
    { ...head, command: 'restore', backupId: 'b' },
    { ...head, command: 'syncNow' },
    { ...head, command: 'hello', token: '', client: 'app' },
    { ...head, command: 'hello', token: 'x'.repeat(201), client: 'app' },
    { ...head, command: 'hello', token: 't', client: 'browser' },
    { ...head, command: 'preview', exclude: Array.from({ length: MAX_EXCLUDED + 1 }, (_, i) => `k${i}`) },
    { ...head, command: 'history', limit: 0 },
    { ...head, command: 'history', limit: MAX_HISTORY + 1 },
    { ...head, command: 'history', limit: 1.5 },
    { ...head, command: 'history', limit: 10, before: '2026-10-06T12:00:00.000Z' },
    ...[
      { at: 'yesterday', seq: 0 },
      { at: '2026-10-06T12:00:00.000Z', seq: -1 },
      { at: '2026-10-06T12:00:00.000Z', seq: 0.5 },
      { at: '2026-10-06T12:00:00.000Z', seq: Number.MAX_SAFE_INTEGER + 1 },
      { at: '2026-10-06T12:00:00.000Z', seq: '0' },
      { at: '2026-10-06T12:00:00.000Z' },
      { seq: 0 },
      { at: '2026-10-06T12:00:00.000Z', seq: 0, extra: 1 },
      null,
    ].map((before) => ({ ...head, command: 'history', limit: 10, before })),
    { ...head, command: 'decide', items: [{ ...decision, revision: 'HEAD' }] },
    { ...head, command: 'decide', items: [{ ...decision, revision: 'A'.repeat(40) }] },
    { ...head, command: 'decide', items: [{ ...decision, decision: 'defer' }] },
    { ...head, command: 'decide', items: [{ ...decision, setupId: 'team' }] },
    { ...head, command: 'decide', items: [{ ...decision, id: '' }] },
    { ...head, command: 'decide', items: [{ ...decision, extra: 1 }] },
    { ...head, command: 'decide', items: Array.from({ length: 1001 }, () => decision) },
    { ...head, command: 'setPolicy', policy: 'yolo' },
  ]) assert.throws(() => decodeRequest(bad), JSON.stringify(bad).slice(0, 100));
});

test('the protocol constants', () => {
  assert.equal(PROTOCOL_VERSION, 3);
  assert.equal(MAX_RECORD_BYTES, 1_048_576);
  assert.equal(MAX_HISTORY, 500);
});

const status = (fields: Partial<AgentStatus> = {}): AgentStatus => ({
  at: '2026-10-06T12:00:00.000Z',
  policy: 'notify',
  paused: null,
  trusted: true,
  pending: [
    { key: 'config:claude:settings.json#model', itemId: 'setting:claude:settings.json#model', verdict: { kind: 'inert' } },
    { key: 'skill:x', itemId: 'skill:x', verdict: { kind: 'held', reason: 'skill' } },
  ],
  drift: ['skill-link:y'],
  conflicts: [],
  probeErrors: [],
  ...fields,
});

test('toWireStatus maps pending items and derives the counts', () => {
  const wire = toWireStatus(status());
  assert.deepEqual(wire, {
    at: '2026-10-06T12:00:00.000Z',
    policy: 'notify',
    paused: null,
    trusted: true,
    pending: [
      { key: 'config:claude:settings.json#model', itemId: 'setting:claude:settings.json#model', verdict: 'inert' },
      { key: 'skill:x', itemId: 'skill:x', verdict: 'held', reason: 'skill' },
    ],
    drift: ['skill-link:y'],
    conflicts: [],
    probeErrors: [],
    counts: { pending: 2, held: 1, ready: 1, drift: 1 },
  });
  assert.deepEqual(decodeMessage({ version: 3, event: 'status', status: wire }), { version: 3, event: 'status', status: wire });
});

test('inert items are ready unless the machine auto-applies them', () => {
  const paused = { reason: 'auto-apply run r failed', at: '2026-10-06T11:00:00.000Z', runId: 'r' };
  assert.equal(toWireStatus(status({ policy: 'manual' })).counts.ready, 1);
  assert.equal(toWireStatus(status({ policy: 'auto-apply' })).counts.ready, 0);
  const pausedWire = toWireStatus(status({ policy: 'auto-apply', paused }));
  assert.equal(pausedWire.counts.ready, 1);
  // The run id stays inside the agent.
  assert.deepEqual(pausedWire.paused, { reason: paused.reason, at: paused.at });
});

test('a failed status keeps its error and detail, and drops the auto-apply outcome', () => {
  const wire = toWireStatus(status({ pending: [], error: 'JOB_FAILED', detail: 'boom', autoApply: { kind: 'lock-held' } }));
  assert.equal(wire.error, 'JOB_FAILED');
  assert.equal(wire.detail, 'boom');
  assert.equal('autoApply' in wire, false);
  assert.deepEqual(decodeMessage({ version: 3, event: 'status', status: wire }).version, 3);
});

test('messages are v3 responses, progress events and status events, decoded strictly', () => {
  const step = { key: 'config:a', domain: 'config', action: 'write-file', summary: 'write a', touches: ['/x'], interruptible: false };
  for (const progress of [
    { type: 'started', index: 0, total: 1, step },
    { type: 'finished', index: 0, total: 1, key: 'config:a', outcome: 'ok', note: '' },
    { type: 'done', ok: 1, failed: 0, backups: '/b' },
    { type: 'cancelled', remaining: ['config:b'] },
    { type: 'failed', message: 'locked' },
  ]) assert.deepEqual(decodeMessage({ version: 3, event: 'progress', runId: 'r', progress }), { version: 3, event: 'progress', runId: 'r', progress });
  assert.equal(decodeMessage({ version: 3, id: '1', ok: true, result: { any: 1 } }).version, 3);
  assert.equal(decodeMessage({ version: 3, id: '1', ok: false, error: { code: 'UNAUTHORIZED', message: 'wrong token' } }).version, 3);
  for (const bad of [
    { version: 2, id: '1', ok: true, result: null },
    { version: 2, event: 'progress', runId: 'r', progress: { type: 'failed', message: 'm' } },
    { version: 3, id: '1', ok: false, error: { code: 'X', message: 'm'.repeat(501) } },
    { version: 3, event: 'status', status: { ...toWireStatus(status()), extra: 1 } },
    { version: 3, event: 'notification' },
  ]) assert.throws(() => decodeMessage(bad), JSON.stringify(bad).slice(0, 100));
});

test('the hello result names the protocol, the agent version, the policy and the pause', () => {
  const hello = { agentVersion: '0.1.0', protocol: 3, policy: 'notify', paused: null };
  assert.deepEqual(decodeHelloResult(hello), hello);
  const paused = { ...hello, paused: { reason: 'r', at: '2026-10-06T12:00:00.000Z' } };
  assert.deepEqual(decodeHelloResult(paused), paused);
  assert.throws(() => decodeHelloResult({ ...hello, protocol: 2 }));
  assert.throws(() => decodeHelloResult({ ...hello, token: 't' }));
});

test('inspect accepts its agent status and rejects unknown status and inspect fields', async () => {
  const { decodeInspectResult } = await import('../src/ipc/protocol.ts');
  const inspected = { profile: { repo: '/r', revision: null, overrides: '/s/overrides.json', issues: [] }, items: [], probeErrors: [], status: { ...toWireStatus(status()), applying: true } };
  assert.deepEqual(decodeInspectResult(inspected), inspected);
  assert.throws(() => decodeInspectResult({ ...inspected, extra: 1 }));
  assert.throws(() => decodeInspectResult({ ...inspected, status: { ...inspected.status, extra: 1 } }));
  assert.throws(() => decodeInspectResult({ ...inspected, status: { ...inspected.status, applying: 'yes' } }));
});
