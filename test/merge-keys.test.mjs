import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDocument, inspectMerge } from '../src/merge-keys.mjs';
import { hashValue, baselineKey } from '../src/settings-keys.mjs';

const PREFIX = 'claude:settings.json';

function fixture({ repo, local }) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-merge-'));
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const src = join(dir, 'repo', 'settings.keys.json');
  const dest = join(dir, 'home', 'settings.json');
  if (repo !== undefined) writeFileSync(src, typeof repo === 'string' ? repo : JSON.stringify(repo));
  if (local !== undefined) writeFileSync(dest, typeof local === 'string' ? local : JSON.stringify(local));
  return { src, dest };
}

const lockWith = (entries = {}) => ({ files: entries });

test('readDocument distinguishes absent from unparseable', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: '{ not json' });
  assert.deepEqual(readDocument(src), { value: { theme: 'auto' }, existed: true, corrupt: false });
  assert.deepEqual(readDocument(dest), { value: null, existed: true, corrupt: true });
  assert.deepEqual(readDocument(join(dest, 'nope')), { value: null, existed: false, corrupt: false });
});

// A JSON array or scalar where an object belongs is not a settings document.
test('readDocument treats a non-object document as corrupt', () => {
  const { src } = fixture({ repo: '["theme"]' });
  assert.equal(readDocument(src).corrupt, true);
});

test('a matching pair with a current baseline is clean', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: { theme: 'auto', permissions: {} } });
  const lock = lockWith({ [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') } });

  const result = inspectMerge(src, dest, PREFIX, lock);
  assert.equal(result.state, 'clean');
  assert.deepEqual(result.keys, [{ key: 'theme', state: 'clean' }]);
  assert.deepEqual(result.owned, ['theme']);
});

// The worst state wins, so one conflicting key cannot hide behind three clean
// ones — the caller decides what to do from a single answer.
test('the rolled-up state is the most severe of the keys', () => {
  const { src, dest } = fixture({
    repo: { theme: 'dark', tui: 'fullscreen' },
    local: { theme: 'light', tui: 'fullscreen' },
  });
  const lock = lockWith({
    [baselineKey('claude', 'settings.json', 'theme')]: { hash: hashValue('auto') },
    [baselineKey('claude', 'settings.json', 'tui')]: { hash: hashValue('fullscreen') },
  });

  const result = inspectMerge(src, dest, PREFIX, lock);
  assert.equal(result.state, 'conflict');
});

test('an absent repo file is missing-repo and nothing else is read', () => {
  const { src, dest } = fixture({ local: { theme: 'auto' } });
  assert.equal(inspectMerge(src, dest, PREFIX, lockWith()).state, 'missing-repo');
});

test('an invalid repo file is missing-repo, carrying its complaints', () => {
  const { src, dest } = fixture({ repo: { apiKey: 'x' }, local: { theme: 'auto' } });
  const result = inspectMerge(src, dest, PREFIX, lockWith());
  assert.equal(result.state, 'missing-repo');
  assert.ok(result.errors.some((e) => /looks like a secret/.test(e)));
});

// The user's own file, mid-edit or hand-broken, is never ours to replace.
test('an unparseable local file is blocked, not overwritten', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto' }, local: '{ not json' });
  assert.equal(inspectMerge(src, dest, PREFIX, lockWith()).state, 'unparseable-local');
});

test('an absent local file makes every owned key unmanaged', () => {
  const { src, dest } = fixture({ repo: { theme: 'auto', tui: 'fullscreen' } });
  const result = inspectMerge(src, dest, PREFIX, lockWith());
  assert.deepEqual(result.keys.map((k) => k.state), ['unmanaged', 'unmanaged']);
});
