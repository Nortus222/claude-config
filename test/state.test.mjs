import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileState, linkState, NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../src/state.mjs';

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

test('a correct symlink whose target resolves is linked', () => {
  assert.equal(
    linkState({ exists: true, isSymlink: true, target: '/r/bin', expectedTarget: '/r/bin', targetResolves: true }),
    'linked',
  );
});

test('a correct symlink whose target no longer resolves is broken-link, not linked', () => {
  assert.equal(
    linkState({ exists: true, isSymlink: true, target: '/r/bin', expectedTarget: '/r/bin', targetResolves: false }),
    'broken-link',
  );
});

test('an unstated targetResolves reads as broken rather than as linked', () => {
  // Fail loud, not silent: a caller that forgets to gather the fact must not
  // be handed the reassuring answer.
  assert.equal(
    linkState({ exists: true, isSymlink: true, target: '/r/bin', expectedTarget: '/r/bin' }),
    'broken-link',
  );
});

test('a real directory where a link belongs is clobbered', () => {
  assert.equal(linkState({ exists: true, isSymlink: false, target: null, expectedTarget: '/r/bin' }), 'clobbered');
});

test('a symlink pointing elsewhere is wrong-target', () => {
  assert.equal(linkState({ exists: true, isSymlink: true, target: '/old/bin', expectedTarget: '/r/bin' }), 'wrong-target');
});

test('nothing there is missing', () => {
  assert.equal(linkState({ exists: false, isSymlink: false, target: null, expectedTarget: '/r/bin' }), 'missing');
});

test('state groupings partition the actionable states', () => {
  // NEEDS_APPLY: 6 states for apply to handle
  assert.ok(NEEDS_APPLY.has('repo-ahead'));
  assert.ok(NEEDS_APPLY.has('unmanaged'));
  assert.ok(NEEDS_APPLY.has('missing'));
  assert.ok(NEEDS_APPLY.has('clobbered'));
  assert.ok(NEEDS_APPLY.has('wrong-target'));
  assert.ok(NEEDS_APPLY.has('broken-link'), 'broken-link is repairable by apply, so it must be actionable');
  assert.equal(NEEDS_APPLY.size, 6, 'NEEDS_APPLY must contain exactly 6 states');

  // NEEDS_CAPTURE: 1 state for capture to handle
  assert.ok(NEEDS_CAPTURE.has('local-ahead'));
  assert.equal(NEEDS_CAPTURE.size, 1, 'NEEDS_CAPTURE must contain exactly 1 state');

  // BLOCKED: 3 states that block all operations
  assert.ok(BLOCKED.has('conflict'), 'conflict must be BLOCKED (divergent changes)');
  assert.ok(BLOCKED.has('missing-repo'), 'missing-repo must be BLOCKED (data-loss case)');
  assert.ok(BLOCKED.has('unknown-mode'), 'unknown-mode must be BLOCKED (configuration error)');
  assert.equal(BLOCKED.size, 3, 'BLOCKED must contain exactly 3 states');

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
  assert.ok(!BLOCKED.has('broken-link'), 'broken-link not in BLOCKED (apply can rebuild it)');
  assert.ok(!NEEDS_CAPTURE.has('broken-link'), 'broken-link not in NEEDS_CAPTURE');

  // Clean and linked are not actionable (in no sets)
  assert.ok(!NEEDS_APPLY.has('clean'), 'clean not in NEEDS_APPLY');
  assert.ok(!NEEDS_CAPTURE.has('clean'), 'clean not in NEEDS_CAPTURE');
  assert.ok(!BLOCKED.has('clean'), 'clean not in BLOCKED');
  assert.ok(!NEEDS_APPLY.has('linked'), 'linked not in NEEDS_APPLY');
  assert.ok(!NEEDS_CAPTURE.has('linked'), 'linked not in NEEDS_CAPTURE');
  assert.ok(!BLOCKED.has('linked'), 'linked not in BLOCKED');
});
