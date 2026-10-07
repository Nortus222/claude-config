import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';
import * as p from '../src/index.ts';
import { time, item, publication, revision, setup, decision, statusSetup, status, machine, sync } from './fixtures.ts';

const token = `nmt_account-1_machine-1_${'a'.repeat(43)}`;
const success = { accountId: 'account-1', login: 'Nortus222', machineId: 'machine-1', token, defaultPolicy: 'notify' };
const fixtures = [
  ['device start request', p.DeviceStartRequestSchema, { name: 'macOS machine', os: 'macos', agents: ['claude', 'codex'] }],
  ['device start response', p.DeviceStartResponseSchema, { pendingId: 'pending-1', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 }],
  ['device poll request', p.DevicePollRequestSchema, { pendingId: 'pending-1' }],
  ['device poll pending', p.DevicePollPendingSchema, { interval: 5 }],
  ['device poll success', p.DevicePollSuccessSchema, success],
  ['setup registration', p.SetupRegistrationSchema, { name: setup.name, repoUrl: setup.repoUrl }],
  ['setup record', p.SetupRecordSchema, setup],
  ['setup list', p.SetupsResponseSchema, { setups: [setup] }],
  ['revision item', p.RevisionItemSchema, item],
  ['revision publication', p.RevisionPublicationSchema, publication],
  ['revision record', p.RevisionRecordSchema, revision],
  ['revision page', p.RevisionsResponseSchema, { revisions: [revision], nextAfter: null }],
  ['decision request', p.DecisionsRequestSchema, { decisions: [decision] }],
  ['decision response', p.DecisionsResponseSchema, { seq: 43, results: [{ setupId: 'setup-1', itemId: item.id, outcome: 'stored' }] }],
  ['machine patch', p.MachinePatchSchema, { name: 'Linux machine', policy: 'manual', reportStatus: false }],
  ['machine record', p.MachineRecordSchema, machine],
  ['machine list', p.MachinesResponseSchema, { machines: [machine] }],
  ['sync query', p.SyncQuerySchema, { since: 42, setups: [{ setupId: 'setup-1', revision: 12 }] }],
  ['sync response', p.SyncResponseSchema, sync],
  ['setup status', p.SetupStatusSchema, statusSetup],
  ['status summary', p.StatusSummarySchema, status],
  ['error response', p.ErrorResponseSchema, { error: 'unavailable', message: 'Try again later' }],
] as const;
for (const [name, schema, fixture] of fixtures) {
  test(`${name} round trips literal JSON and rejects top-level extras`, () => {
    assert.ok(schema, `${name} schema must be exported`);
    assert.deepEqual(p.decodeHosted(schema as Schema.ConstraintDecoder<unknown>, JSON.parse(JSON.stringify(fixture))), fixture);
    assert.throws(() => p.decodeHosted(schema as Schema.ConstraintDecoder<unknown>, { ...fixture, tokenHash: 'SECRET' }), { message: 'Invalid hosted payload' });
  });
}

test('authentication excludes upstream credentials and matches embedded token IDs', () => {
  for (const value of [{ ...success, accountId: 'other' }, { ...success, machineId: 'other' }, { ...success, token: 'nmt_account-1_machine-1_short' }, { ...success, githubToken: 'SECRET' }, { ...success, defaultPolicy: 'always' }]) assert.throws(() => p.decodeHosted(p.DevicePollSuccessSchema, value));
  for (const value of [{ name: 'machine', os: 'macos', agents: ['claude', 'claude'] }]) assert.throws(() => p.decodeHosted(p.DeviceStartRequestSchema, value));
  assert.throws(() => p.decodeHosted(p.DeviceStartResponseSchema, { pendingId: 'x', userCode: 'ABCD', verificationUri: 'https://user:SECRET@github.com/login/device', interval: 0, expiresIn: 900 }));
  assert.throws(() => p.decodeHosted(p.DevicePollPendingSchema, { interval: 5, deviceCode: 'SECRET' }));
});

test('revision and account list bounds, ordering and logical identities', () => {
  for (const value of [{ ...publication, items: [{ ...item, kind: 'skill' }] }, { ...publication, items: [item, item] }, { ...publication, items: Array.from({ length: 501 }, (_, i) => ({ ...item, id: `integration:x${i}`, kind: 'integration' })) }, { ...publication, requiredEnv: ['API_KEY', 'API_KEY'] }, { ...publication, items: [{ ...item, digest: 'SECRET' }] }, { ...publication, changelog: 'é'.repeat(8193) }, { ...publication, number: 0 }]) assert.throws(() => p.decodeHosted(p.RevisionPublicationSchema, value));
  assert.equal(p.decodeHosted(p.RevisionPublicationSchema, { ...publication, changelog: 'é'.repeat(8192) }).changelog.length, 8192);
  const large = { ...publication, items: Array.from({ length: 500 }, (_, i) => ({ id: `integration:${'x'.repeat(195)}${i}`, kind: 'integration', change: 'changed' })) };
  assert.ok(p.jsonByteLength(large) > p.MAX_REVISION_BYTES);
  assert.throws(() => p.decodeHosted(p.RevisionPublicationSchema, large));
  assert.throws(() => p.decodeHosted(p.RevisionRecordSchema, { ...revision, publishedAt: 'invalid' }));
  for (const revisions of [[revision, revision], [{ ...revision, number: 13 }, revision], Array.from({ length: 51 }, (_, i) => ({ ...revision, number: i + 1 }))]) assert.throws(() => p.decodeHosted(p.RevisionsResponseSchema, { revisions, nextAfter: null }));
  assert.deepEqual(p.decodeHosted(p.RevisionsResponseSchema, { revisions: [revision], nextAfter: 12 }).nextAfter, 12);
  assert.throws(() => p.decodeHosted(p.RevisionsResponseSchema, { revisions: [revision], nextAfter: 11 }));
  assert.throws(() => p.decodeHosted(p.SetupsResponseSchema, { setups: [setup, setup] }));
  assert.throws(() => p.decodeHosted(p.SetupsResponseSchema, { setups: Array.from({ length: 11 }, (_, i) => ({ ...setup, setupId: `s${i}` })) }));
  assert.throws(() => p.decodeHosted(p.MachinesResponseSchema, { machines: [machine, machine] }));
  assert.throws(() => p.decodeHosted(p.MachinesResponseSchema, { machines: Array.from({ length: 26 }, (_, i) => ({ ...machine, machineId: `m${i}` })) }));
});

test('machine settings and status are recursive metadata-only shapes', () => {
  assert.deepEqual(p.decodeHosted(p.MachineRecordSchema, { ...machine, status: null }).status, null);
  assert.throws(() => p.decodeHosted(p.MachinePatchSchema, {}));
  assert.throws(() => p.decodeHosted(p.MachineRecordSchema, { ...machine, reportStatus: false }));
  assert.throws(() => p.decodeHosted(p.StatusSummarySchema, { ...status, policy: 'notify' }));
  assert.throws(() => p.decodeHosted(p.StatusSummarySchema, { ...status, policy: 'manual' }));
  for (const value of [{ ...machine, tokenHash: 'SECRET' }, { ...machine, status: { ...status, setups: [{ ...statusSetup, trust: true }] } }, { ...machine, agents: ['codex', 'codex'] }]) assert.throws(() => p.decodeHosted(p.MachineRecordSchema, value));
  for (const value of [{ ...status, setups: [statusSetup, statusSetup] }, { ...status, setups: [{ ...statusSetup, adopted: [item.id, item.id] }] }, { ...status, setups: [{ ...statusSetup, adopted: [item.id] }] }, { ...status, drift: { ...status.drift, setting: -1 } }, { ...status, drift: { ...status.drift, paths: [] } }]) assert.throws(() => p.decodeHosted(p.StatusSummarySchema, value));
  const manyIds = Array.from({ length: 501 }, (_, i) => `integration:x${i}`);
  assert.equal(p.decodeHosted(p.StatusSummarySchema, { ...status, setups: [{ ...statusSetup, revisionApplied: 0, adopted: manyIds }] }).setups[0].adopted.length, 501);
});

test('decision duplicates keep arrival order, outcomes require an unprocessed suffix and exact correlation', () => {
  const entries = [decision, { ...decision, decision: 'skip' }, { ...decision, itemId: 'integration:other' }];
  const request = p.decodeHosted(p.DecisionsRequestSchema, { decisions: entries });
  assert.deepEqual(request.decisions, entries);
  const results = entries.map((d, i) => ({ setupId: d.setupId, itemId: d.itemId, outcome: i === 0 ? 'stored' : 'unprocessed' }));
  assert.deepEqual(p.decodeDecisionsResponse(request, { seq: 43, results }).results, results);
  assert.throws(() => p.decodeHosted(p.DecisionsResponseSchema, { seq: 43, results: [results[1], results[0]] }));
  assert.throws(() => p.decodeDecisionsResponse(request, { seq: 43, results: results.slice(1) }));
  assert.throws(() => p.decodeDecisionsResponse(request, { seq: 43, results: [results[2], results[1], results[1]] }));
  assert.throws(() => p.decodeHosted(p.DecisionsRequestSchema, { decisions: [] }));
  assert.throws(() => p.decodeHosted(p.DecisionsRequestSchema, { decisions: Array.from({ length: 501 }, () => decision) }));
  assert.throws(() => p.decodeHosted(p.DecisionsRequestSchema, { decisions: [{ ...decision, decidedAt: time }] }));
});

test('sync preserves the source projections and is complete beyond one revision page', () => {
  const revisions = Array.from({ length: 51 }, (_, i) => ({ ...sync.revisions[0], number: i + 1 }));
  const setups = [{ ...sync.setups[0], latestRevision: 51 }];
  assert.equal(p.decodeHosted(p.SyncResponseSchema, { ...sync, revisions, setups }).revisions.length, 51);
  for (const value of [{ ...sync, revisions: [sync.revisions[0], sync.revisions[0]] }, { ...sync, revisions: [...revisions].reverse() }, { ...sync, decisions: [sync.decisions[0], sync.decisions[0]] }, { ...sync, machine: { ...sync.machine, defaultPolicy: 'notify' } }, { ...sync, setups: [{ ...sync.setups[0], createdAt: time }] }, { ...sync, decisions: [{ ...sync.decisions[0], source: 'synced' }] }, { ...sync, revisions: [{ ...sync.revisions[0], items: [{ ...item, value: 'SECRET' }] }] }]) assert.throws(() => p.decodeHosted(p.SyncResponseSchema, value));
});

test('error codes have a closed status mapping', () => {
  assert.deepEqual(p.ERROR_STATUS, { unauthenticated: 401, not_allowlisted: 403, forbidden: 403, not_found: 404, invalid: 400, payload_too_large: 413, revision_conflict: 409, status_disabled: 409, limit_reached: 409, sign_in_expired: 410, rate_limited: 429, unavailable: 503 });
  for (const code of Object.keys(p.ERROR_STATUS)) assert.equal(p.decodeHosted(p.ErrorResponseSchema, { error: code, message: 'Request failed' }).error, code);
  assert.throws(() => p.decodeHosted(p.ErrorResponseSchema, { error: 'internal', message: 'Request failed' }));
});


test('machine descriptions allow no configured agents yet', () => {
  assert.deepEqual(p.decodeHosted(p.DeviceStartRequestSchema, { name: 'Linux machine', os: 'linux', agents: [] }).agents, []);
  assert.deepEqual(p.decodeHosted(p.MachineRecordSchema, { ...machine, agents: [] }).agents, []);
  assert.deepEqual(p.decodeHosted(p.StatusSummarySchema, { ...status, agents: [] }).agents, []);
});

test('sync records must reference a returned setup and cannot exceed its advertised head', () => {
  for (const value of [
    { ...sync, revisions: [{ ...sync.revisions[0], setupId: 'other' }] },
    { ...sync, revisions: [{ ...sync.revisions[0], number: 13 }] },
    { ...sync, decisions: [{ ...sync.decisions[0], setupId: 'other' }] },
    { ...sync, decisions: [{ ...sync.decisions[0], revision: 13 }] },
  ]) assert.throws(() => p.decodeHosted(p.SyncResponseSchema, value));
});

test('full revision byte boundary includes publication metadata', () => {
  const empty = { ...revision, requiredEnv: ['A'] };
  const exact = { ...empty, requiredEnv: ['A'.repeat(p.MAX_REVISION_BYTES - p.jsonByteLength(empty) + 1)] };
  assert.equal(p.jsonByteLength(exact), p.MAX_REVISION_BYTES);
  assert.deepEqual(p.decodeHosted(p.RevisionRecordSchema, exact), exact);
  const { publishedAt, machineId, ...projection } = exact;
  assert.ok(p.jsonByteLength(projection) <= p.MAX_REVISION_BYTES);
  assert.deepEqual(p.decodeHosted(p.SyncRevisionSchema, projection), projection);
  assert.throws(() => p.decodeHosted(p.RevisionRecordSchema, { ...exact, requiredEnv: [exact.requiredEnv[0] + 'A'] }));
});

test('every status list is unique and disjoint from every other list', () => {
  const keys = ['adopted', 'skipped', 'pending', 'waitingForPerson'] as const;
  for (const key of keys) assert.throws(() => p.decodeHosted(p.SetupStatusSchema, { ...statusSetup, [key]: [item.id, item.id] }));
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) assert.throws(() => p.decodeHosted(p.SetupStatusSchema, { ...statusSetup, [keys[i]]: [item.id], [keys[j]]: [item.id] }));
});

test('oversized cumulative adoption stays complete in responses but cannot be uploaded', () => {
  const large = { ...status, setups: [{ ...statusSetup, adopted: Array.from({ length: 1000 }, (_, i) => `integration:${'x'.repeat(190)}${i}`) }] };
  assert.ok(p.jsonByteLength(large) > p.MAX_REQUEST_BODY_BYTES);
  assert.equal(p.decodeHosted(p.StatusSummarySchema, large).setups[0].adopted.length, 1000);
  assert.throws(() => p.decodeRequestBody(p.StatusSummarySchema, large), { message: 'Hosted request body too large' });
});


test('revision pages cannot mix setup identities', () => {
  assert.throws(() => p.decodeHosted(p.RevisionsResponseSchema, { revisions: [revision, { ...revision, setupId: 'other', number: 13 }], nextAfter: null }));
});

test('valid maximum wire counts and all decision outcomes remain usable', () => {
  assert.equal(p.decodeHosted(p.DecisionsRequestSchema, { decisions: Array.from({ length: 500 }, () => decision) }).decisions.length, 500);
  assert.equal(p.decodeHosted(p.RevisionPublicationSchema, { ...publication, items: Array.from({ length: 500 }, (_, i) => ({ id: `integration:x${i}`, kind: 'integration', change: 'added' })) }).items.length, 500);
  assert.equal(p.decodeHosted(p.SetupsResponseSchema, { setups: Array.from({ length: 10 }, (_, i) => ({ ...setup, setupId: `s${i}` })) }).setups.length, 10);
  assert.equal(p.decodeHosted(p.MachinesResponseSchema, { machines: Array.from({ length: 25 }, (_, i) => ({ ...machine, machineId: `m${i}` })) }).machines.length, 25);
  assert.equal(p.decodeHosted(p.RevisionsResponseSchema, { revisions: Array.from({ length: 50 }, (_, i) => ({ ...revision, number: i + 1 })), nextAfter: 50 }).revisions.length, 50);
  assert.deepEqual(p.decodeHosted(p.RevisionsResponseSchema, { revisions: [], nextAfter: null }).revisions, []);
  const decisions = [decision, { ...decision, itemId: 'integration:other' }];
  const results = decisions.map((entry, index) => ({ setupId: entry.setupId, itemId: entry.itemId, outcome: index === 0 ? 'stale' : 'stored' }));
  assert.deepEqual(p.decodeDecisionsResponse(p.decodeHosted(p.DecisionsRequestSchema, { decisions }), { seq: 43, results }).results, results);
  assert.deepEqual(p.decodeHosted(p.MachinePatchSchema, { reportStatus: false }), { reportStatus: false });
  assert.deepEqual(p.decodeHosted(p.MachineRecordSchema, { ...machine, reportStatus: false, status: null }).status, null);
});
