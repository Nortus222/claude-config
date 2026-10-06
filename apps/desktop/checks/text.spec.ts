import test from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../backend/text.ts';

test('text within the limit is unchanged', () => {
  assert.equal(truncate('ab😀', 4), 'ab😀');
  assert.equal(truncate('', 10), '');
});

test('a cut through a surrogate pair drops the whole pair', () => {
  // '😀' is two UTF-16 units; a cut at 3 would keep only its high half.
  assert.equal(truncate('ab😀c', 3), 'ab');
});

test('a cut after a whole pair keeps it', () => {
  assert.equal(truncate('ab😀c', 4), 'ab😀');
});

test('a plain cut counts UTF-16 units', () => {
  assert.equal(truncate('abcdef', 3), 'abc');
});
