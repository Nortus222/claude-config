import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillsManifest } from '../src/skills.ts';

test('groups skills under their source with exact and optional markers', () => {
  const text = '# comment\n[a/b] optional\nx\ny\n\n[c/d] exact\nz\n[e/f] exact optional bogus\nw\n';
  assert.deepEqual(parseSkillsManifest(text), [
    { source: 'a/b', skills: ['x', 'y'], exact: false, optional: true },
    { source: 'c/d', skills: ['z'], exact: true, optional: false },
    { source: 'e/f', skills: ['w'], exact: true, optional: true },
  ]);
});

test('ignores names before any header and tolerates CRLF and padding', () => {
  assert.deepEqual(parseSkillsManifest('orphan\r\n[ a/b ]\r\n  x  \r\n'), [
    { source: 'a/b', skills: ['x'], exact: false, optional: false },
  ]);
});

test('keeps a header with no skills and repeated sources as written', () => {
  assert.deepEqual(parseSkillsManifest('[a/b]\n[a/b]\nx\n'), [
    { source: 'a/b', skills: [], exact: false, optional: false },
    { source: 'a/b', skills: ['x'], exact: false, optional: false },
  ]);
});

test('an absent manifest declares nothing', () => {
  assert.deepEqual(parseSkillsManifest(undefined), []);
});
