import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePins } from '../src/pins.ts';

test('an absent pin file pins nothing', () => {
  assert.deepEqual(parsePins(undefined), { value: {}, source: 'skill-pins.json', issues: [] });
});

test('reads a ref per source', () => {
  const text = JSON.stringify({ version: 1, pins: { 'mattpocock/skills': 'abc123' } });
  assert.deepEqual(parsePins(text), { value: { 'mattpocock/skills': 'abc123' }, source: 'skill-pins.json', issues: [] });
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
