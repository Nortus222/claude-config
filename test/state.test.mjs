import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileState, NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../src/state.mjs';
// Namespace import, not a named one: a named import of a removed export is a
// hard ESM error, which would fail this file before any assertion could run.
import * as stateModule from '../src/state.mjs';

const A = 'sha256:aaa', B = 'sha256:bbb', C = 'sha256:ccc';

test('unchanged on both sides is clean', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: A }), 'clean');
});

test('only the repo moved is repo-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: A }), 'repo-ahead');
});

test('only the local moved is local-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: B }), 'local-ahead');
});

test('both moved apart is a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: C }), 'conflict');
});

test('both moved to the SAME content is clean, not a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: B }), 'clean');
});

test('no baseline is unmanaged', () => {
  assert.equal(fileState({ baseline: null, repo: A, local: A }), 'unmanaged');
});

test('missing from the repo is missing-repo regardless of the rest', () => {
  assert.equal(fileState({ baseline: A, repo: null, local: A }), 'missing-repo');
  assert.equal(fileState({ baseline: null, repo: null, local: null }), 'missing-repo');
});

test('local deleted since baseline is repo-ahead, so apply restores it', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: null }), 'repo-ahead');
});

test('local deleted while the repo also moved is still repo-ahead', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: null }), 'repo-ahead');
});

// The link state machine is retired along with the directory links it served:
// no managed path is a directory any more, so 'linked', 'clobbered',
// 'wrong-target' and 'broken-link' had no producer left.
test('the link state machine is gone, not merely unused', () => {
  assert.ok(!('linkState' in stateModule), 'linkState must not survive as dead exported code');
});

test('the retired link states are absent from every grouping', () => {
  for (const state of ['linked', 'clobbered', 'wrong-target', 'broken-link']) {
    assert.ok(!NEEDS_APPLY.has(state), `${state} must not be actionable`);
    assert.ok(!NEEDS_CAPTURE.has(state), `${state} must not need capture`);
    assert.ok(!BLOCKED.has(state), `${state} must not be blocked`);
  }
});

test('state groupings partition the actionable states', () => {
  // NEEDS_APPLY: 3 states for apply to handle
  assert.ok(NEEDS_APPLY.has('repo-ahead'));
  assert.ok(NEEDS_APPLY.has('unmanaged'));
  assert.ok(NEEDS_APPLY.has('missing'));
  assert.equal(NEEDS_APPLY.size, 3, 'NEEDS_APPLY must contain exactly 3 states');

  // NEEDS_CAPTURE: 1 state for capture to handle
  assert.ok(NEEDS_CAPTURE.has('local-ahead'));
  assert.equal(NEEDS_CAPTURE.size, 1, 'NEEDS_CAPTURE must contain exactly 1 state');

  // BLOCKED: 4 states that block all operations
  assert.ok(BLOCKED.has('conflict'), 'conflict must be BLOCKED (divergent changes)');
  assert.ok(BLOCKED.has('missing-repo'), 'missing-repo must be BLOCKED (data-loss case)');
  assert.ok(BLOCKED.has('unknown-mode'), 'unknown-mode must be BLOCKED (configuration error)');
  assert.ok(BLOCKED.has('unparseable-local'), 'unparseable-local must be BLOCKED (unreadable local file)');
  assert.equal(BLOCKED.size, 4, 'BLOCKED must contain exactly 4 states');

  // No state is in multiple sets
  assert.ok(!NEEDS_APPLY.has('local-ahead'), 'local-ahead not in NEEDS_APPLY');
  assert.ok(!NEEDS_APPLY.has('conflict'), 'conflict not in NEEDS_APPLY');
  assert.ok(!NEEDS_APPLY.has('missing-repo'), 'missing-repo not in NEEDS_APPLY (data-loss case)');
  assert.ok(!NEEDS_APPLY.has('unknown-mode'), 'unknown-mode not in NEEDS_APPLY (configuration error)');
  assert.ok(!NEEDS_CAPTURE.has('repo-ahead'), 'repo-ahead not in NEEDS_CAPTURE');
  assert.ok(!NEEDS_CAPTURE.has('conflict'), 'conflict not in NEEDS_CAPTURE');
  assert.ok(!NEEDS_CAPTURE.has('unknown-mode'), 'unknown-mode not in NEEDS_CAPTURE');
  assert.ok(!BLOCKED.has('local-ahead'), 'local-ahead not in BLOCKED');
  assert.ok(!BLOCKED.has('repo-ahead'), 'repo-ahead not in BLOCKED');
  // Clean is not actionable (in no sets)
  assert.ok(!NEEDS_APPLY.has('clean'), 'clean not in NEEDS_APPLY');
  assert.ok(!NEEDS_CAPTURE.has('clean'), 'clean not in NEEDS_CAPTURE');
  assert.ok(!BLOCKED.has('clean'), 'clean not in BLOCKED');
});
