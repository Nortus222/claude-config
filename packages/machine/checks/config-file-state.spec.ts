import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, fileState, hashValue } from '../src/config/file-state.ts';
import { splitProjectTrust } from '../src/config/project-trust.ts';
import { hashText } from '../src/hash.ts';

const A = 'sha256:a';
const B = 'sha256:b';
const C = 'sha256:c';

test('each side moving alone is that side being ahead; both apart is a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: A, local: A }), 'clean');
  assert.equal(fileState({ baseline: A, repo: B, local: A }), 'repo-ahead');
  assert.equal(fileState({ baseline: A, repo: A, local: B }), 'local-ahead');
  assert.equal(fileState({ baseline: A, repo: B, local: C }), 'conflict');
});

test('both sides moving to the same content is clean, not a conflict', () => {
  assert.equal(fileState({ baseline: A, repo: B, local: B }), 'clean');
});

test('no baseline is unmanaged; no repo side is missing-repo regardless of the rest', () => {
  assert.equal(fileState({ repo: A, local: B }), 'unmanaged');
  assert.equal(fileState({ repo: A }), 'unmanaged');
  assert.equal(fileState({ baseline: A, local: A }), 'missing-repo');
  assert.equal(fileState({}), 'missing-repo');
});

test('a local file deleted since its baseline is repo-ahead, even when the repo moved too', () => {
  assert.equal(fileState({ baseline: A, repo: A }), 'repo-ahead');
  assert.equal(fileState({ baseline: A, repo: B }), 'repo-ahead');
});

test('canonical ignores key order and keeps array order', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, 1], c: null } }), canonical({ a: { c: null, d: [2, 1] }, b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
  assert.equal(canonical('x'), '"x"');
  assert.equal(canonical(true), 'true');
});

test('an absent value hashes to undefined, which fileState reads as absent', () => {
  assert.equal(hashValue(undefined), undefined);
  assert.equal(hashValue({ b: 1, a: 2 }), hashText('{"a":2,"b":1}'));
});

test('project tables are split out, and a table after them rejoins the managed part', () => {
  const text = 'model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n\n[other]\nk = 1\n';
  assert.deepEqual(splitProjectTrust(text), {
    managed: 'model = "x"\n\n[other]\nk = 1\n',
    projects: '[projects."/a"]\ntrust_level = "trusted"\n\n',
  });
  assert.deepEqual(splitProjectTrust('a = 1\n\n\n'), { managed: 'a = 1\n', projects: '' });
});

test('project-like headers inside a multiline string or an array stay managed', () => {
  const multiline = 'a = """\n[projects."/x"]\n"""\n';
  assert.deepEqual(splitProjectTrust(multiline), { managed: multiline, projects: '' });
  const array = 'paths = [\n  [ "projects" ],\n]\n';
  assert.deepEqual(splitProjectTrust(array), { managed: array, projects: '' });
});
