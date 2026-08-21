import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonical,
  hashValue,
  baselineKey,
  keyStates,
  staleBaselineKeys,
} from '../src/settings-keys.mjs';

// Key order is how a JSON document gets rewritten without changing meaning.
// Hashing the raw text would report that as drift on every machine.
test('canonical serialization is stable under key order', () => {
  assert.equal(
    canonical({ b: 1, a: { d: 2, c: 3 } }),
    canonical({ a: { c: 3, d: 2 }, b: 1 }),
  );
});

// Arrays are ordered data, not a record: reordering them IS a change.
test('canonical serialization preserves array order', () => {
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']));
});

test('canonical serialization handles the scalar cases', () => {
  assert.equal(canonical('high'), '"high"');
  assert.equal(canonical(3), '3');
  assert.equal(canonical(true), 'true');
  assert.equal(canonical(null), 'null');
});

test('an absent value hashes to null, which is what fileState reads as absent', () => {
  assert.equal(hashValue(undefined), null);
  assert.ok(hashValue('high').startsWith('sha256:'));
  assert.equal(hashValue({ a: 1, b: 2 }), hashValue({ b: 2, a: 1 }));
});

test('a baseline key names its target, its file and its key', () => {
  assert.equal(baselineKey('claude', 'settings.json', 'effortLevel'), 'claude:settings.json#effortLevel');
});

test('a key untouched on both sides is clean', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'auto' }, baselines });
  assert.deepEqual(states, [{ key: 'theme', state: 'clean' }]);
});

test('each side moving alone is reported as that side being ahead', () => {
  const baselines = { theme: hashValue('auto') };
  const repoAhead = keyStates({ owned: ['theme'], repo: { theme: 'dark' }, local: { theme: 'auto' }, baselines });
  assert.equal(repoAhead[0].state, 'repo-ahead');

  const localAhead = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'dark' }, baselines });
  assert.equal(localAhead[0].state, 'local-ahead');
});

test('both sides moving apart is a conflict', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'dark' }, local: { theme: 'light' }, baselines });
  assert.equal(states[0].state, 'conflict');
});

test('a key with no baseline is unmanaged, whether or not it is present locally', () => {
  assert.equal(keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: {} })[0].state, 'unmanaged');
  assert.equal(keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: { theme: 'x' } })[0].state, 'unmanaged');
});

// An absent local file is recoverable from the repo, exactly as a deleted
// managed file is.
test('a whole missing local document reads as the repo being ahead', () => {
  const baselines = { theme: hashValue('auto') };
  const states = keyStates({ owned: ['theme'], repo: { theme: 'auto' }, local: null, baselines });
  assert.equal(states[0].state, 'repo-ahead');
});

test('a key the repo no longer declares is missing-repo, not silently clean', () => {
  const states = keyStates({ owned: ['gone'], repo: {}, local: { gone: 'x' }, baselines: {} });
  assert.equal(states[0].state, 'missing-repo');
});

// A key dropped from the repo file stops being owned; its baseline must not
// linger, or the state file accumulates records nothing will ever reconcile.
test('baselines for keys no longer owned are identified for pruning', () => {
  const files = {
    'claude:CLAUDE.md': { hash: 'x' },
    'claude:settings.json#theme': { hash: 'y' },
    'claude:settings.json#gone': { hash: 'z' },
  };
  assert.deepEqual(
    staleBaselineKeys(files, 'claude:settings.json', ['theme']),
    ['claude:settings.json#gone'],
  );
});

test('pruning never touches a whole-file baseline that merely shares the prefix', () => {
  const files = { 'claude:settings.json': { hash: 'x' } };
  assert.deepEqual(staleBaselineKeys(files, 'claude:settings.json', []), []);
});
