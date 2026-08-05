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

test('a correct symlink is linked', () => {
  assert.equal(linkState({ exists: true, isSymlink: true, target: '/r/bin', expectedTarget: '/r/bin' }), 'linked');
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
  assert.ok(NEEDS_APPLY.has('repo-ahead'));
  assert.ok(NEEDS_APPLY.has('unmanaged'));
  assert.ok(NEEDS_APPLY.has('missing'));
  assert.ok(NEEDS_APPLY.has('clobbered'));
  assert.ok(NEEDS_APPLY.has('wrong-target'));
  assert.ok(NEEDS_CAPTURE.has('local-ahead'));
  assert.ok(BLOCKED.has('conflict'));
  assert.ok(!NEEDS_APPLY.has('clean'));
  assert.ok(!NEEDS_APPLY.has('conflict'));
});
