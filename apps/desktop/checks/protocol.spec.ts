import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXCLUDED, decodeApplyResult, decodeInspectResult, decodeMessage, decodeRequest,
} from '../backend/protocol.ts';

const step = { key: 'config:a', domain: 'config', action: 'write-file', summary: 'write a', touches: ['/x'], interruptible: false };

test('requests are the five v2 commands with only their own arguments', () => {
  assert.equal(decodeRequest({ version: 2, id: '1', command: 'inspect' }).command, 'inspect');
  assert.deepEqual(decodeRequest({ version: 2, id: '2', command: 'preview', exclude: ['k'] }), { version: 2, id: '2', command: 'preview', exclude: ['k'] });
  assert.equal(decodeRequest({ version: 2, id: '3', command: 'apply', planId: 'p' }).command, 'apply');
  for (const bad of [
    { version: 1, id: '1', command: 'inspect' },
    { version: 2, id: '1', command: 'start' },
    { version: 2, id: '1', command: 'crash' },
    { version: 2, id: '1', command: 'inspect', path: '/etc' },
    { version: 2, id: '1', command: 'preview', exclude: ['k'], cmd: 'rm' },
    { version: 2, id: '1', command: 'preview', exclude: [''] },
    { version: 2, id: '1', command: 'preview', exclude: ['x'.repeat(501)] },
    { version: 2, id: '1', command: 'preview', exclude: Array.from({ length: MAX_EXCLUDED + 1 }, (_, i) => `k${i}`) },
    { version: 2, id: '1', command: 'apply' },
    { version: 2, id: '', command: 'inspect' },
  ]) assert.throws(() => decodeRequest(bad), JSON.stringify(bad).slice(0, 80));
});

test('run events carry the machine progress vocabulary plus failed', () => {
  for (const progress of [
    { type: 'started', index: 0, total: 1, step },
    { type: 'finished', index: 0, total: 1, key: 'config:a', outcome: 'ok', note: '' },
    { type: 'done', ok: 1, failed: 0, backups: '/b' },
    { type: 'done', ok: 0, failed: 0 },
    { type: 'cancelled', remaining: ['config:b'] },
    { type: 'failed', message: 'another nortuscc run (pid 1) holds /s/apply.lock' },
  ]) assert.deepEqual(decodeMessage({ version: 2, event: 'progress', runId: 'r', progress }), { version: 2, event: 'progress', runId: 'r', progress });
  assert.throws(() => decodeMessage({ version: 2, event: 'progress', runId: 'r', progress: { type: 'exploded' } }));
  assert.throws(() => decodeMessage({ version: 1, event: 'progress', operationId: 'x', state: 'running', percent: 1, detail: '' }));
});

test('responses are v2 with a bounded error', () => {
  assert.equal(decodeMessage({ version: 2, id: '1', ok: true, result: { any: 1 } }).version, 2);
  assert.throws(() => decodeMessage({ version: 2, id: '1', ok: false, error: { code: 'X', message: 'm'.repeat(501) } }));
});

test('inspect and apply payloads decode strictly', () => {
  const inspected = decodeInspectResult({
    profile: { repo: '/r', revision: null, overrides: '/s/overrides.json', issues: [] },
    items: [{ key: 'config:a', domain: 'config', target: 'claude', label: 'a', group: 'Files', state: 'repo-ahead', disposition: 'apply', from: { layer: 'base', source: 'FILES' } }],
    probeErrors: ['claude was not found'],
  });
  assert.equal(inspected.items[0]!.disposition, 'apply');
  assert.throws(() => decodeInspectResult({ ...inspected, items: [{ ...inspected.items[0], extra: 1 }] }));
  assert.equal(decodeApplyResult({ status: 'stale', planId: 'p', plan: { kind: 'apply', steps: [step], skipped: [] } }).status, 'stale');
  assert.throws(() => decodeApplyResult({ status: 'started' }));
});

test('a shared skill has no target, and update plans carry update-skills steps for chosen agents', () => {
  const inspected = decodeInspectResult({
    profile: { repo: '/r', revision: null, overrides: '/s/overrides.json', issues: [] },
    items: [{ key: 'skill:brainstorming', domain: 'skills', label: 'brainstorming', group: 'obra/superpowers', state: 'ok', disposition: 'in-sync' }],
    probeErrors: [],
  });
  assert.equal(inspected.items[0]!.target, undefined);
  const update = { key: 'skills:update', domain: 'skills', action: 'update-skills', summary: 'update 2 skills', touches: [], interruptible: true, targets: ['claude', 'codex'] };
  const stale = decodeApplyResult({ status: 'stale', planId: 'p', plan: { kind: 'update', steps: [update], skipped: [] } });
  assert.equal(stale.status === 'stale' && stale.plan.steps[0]!.targets?.length, 2);
  assert.throws(() => decodeInspectResult({ ...inspected, items: [{ ...inspected.items[0], target: 'cursor' }] }));
});
