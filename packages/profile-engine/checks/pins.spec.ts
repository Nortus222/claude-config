import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCommitSha, parsePins } from '../src/pins.ts';

test('an absent pin file pins nothing', () => {
  assert.deepEqual(parsePins(undefined), { value: {}, source: 'skill-pins.json', issues: [] });
});

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('reads a commit sha per source', () => {
  const text = JSON.stringify({ version: 1, pins: { 'mattpocock/skills': SHA } });
  assert.deepEqual(parsePins(text), { value: { 'mattpocock/skills': SHA }, source: 'skill-pins.json', issues: [] });
});

test('a pin that is not a full lowercase commit sha refuses the file', () => {
  for (const ref of ['main', 'v1.2.0', 'HEAD', SHA.slice(0, 12), SHA.toUpperCase(), `${SHA}${SHA.slice(0, 24)}`, `-${SHA.slice(1)}`]) {
    const parsed = parsePins(JSON.stringify({ version: 1, pins: { 'a/b': ref } }));
    assert.deepEqual(parsed.value, {}, ref);
    assert.equal(parsed.issues.length, 1, ref);
  }
});

test('isCommitSha accepts only 40 lowercase hex characters', () => {
  assert.equal(isCommitSha(SHA), true);
  for (const ref of ['', 'main', SHA.slice(1), SHA.toUpperCase(), `${SHA}0`]) assert.equal(isCommitSha(ref), false, ref);
});

test('refuses the whole file when anything is wrong', () => {
  for (const text of [
    '{',
    JSON.stringify({ version: 2, pins: {} }),
    JSON.stringify({ version: 1, pins: { a: '' } }),
    JSON.stringify({ version: 1, pins: {}, extra: 1 }),
    JSON.stringify({ version: 1 }),
  ]) {
    const parsed = parsePins(text);
    assert.deepEqual(parsed.value, {}, text);
    assert.equal(parsed.issues.length, 1, text);
    assert.equal(parsed.issues[0]!.layer, 'pin', text);
    assert.equal(parsed.issues[0]!.source, 'skill-pins.json', text);
  }
});
