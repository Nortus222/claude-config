import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'effect';
import { decode, isPlainObject, issue, parseJson } from '../src/issues.ts';

test('parseJson returns the value or an issue naming the document', () => {
  assert.deepEqual(parseJson('{"a":1}', 'base', 'x.json'), { ok: true, value: { a: 1 } });
  const bad = parseJson('{', 'pin', 'x.json');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.issue.layer, 'pin');
    assert.equal(bad.issue.source, 'x.json');
    assert.match(bad.issue.message, /^not valid JSON: /);
  }
});

test('decode reports every problem and refuses unknown fields', () => {
  const S = Schema.Struct({ version: Schema.Literal(1), name: Schema.String });
  assert.deepEqual(decode(S, { version: 1, name: 'a' }, 'machine', 'o'), { ok: true, value: { version: 1, name: 'a' } });
  const bad = decode(S, { version: 2, extra: true }, 'machine', 'o');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.match(bad.issue.message, /version/);
    assert.match(bad.issue.message, /name/);
    assert.match(bad.issue.message, /extra/);
  }
});

test('issue and isPlainObject', () => {
  assert.deepEqual(issue('base', 's', 'p', 'm'), { layer: 'base', source: 's', path: 'p', message: 'm' });
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});
