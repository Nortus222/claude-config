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

test('decode refuses invalid documents and unknown fields with safe document context', () => {
  const S = Schema.Struct({ version: Schema.Literal(1), name: Schema.String });
  assert.deepEqual(decode(S, { version: 1, name: 'a' }, 'machine', 'o'), { ok: true, value: { version: 1, name: 'a' } });
  const bad = decode(S, { version: 2, extra: true }, 'machine', 'o');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.issue.source, 'o');
    assert.match(bad.issue.message, /check.*fields/);
  }
});

test('issue and isPlainObject', () => {
  assert.deepEqual(issue('base', 's', 'p', 'm'), { layer: 'base', source: 's', path: 'p', message: 'm' });
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
});

test('malformed JSON issues retain document context without parser excerpts', () => {
  const result = parseJson('FAKE_TOKEN', 'base', 'settings.keys.json');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.issue.source, 'settings.keys.json');
    assert.ok(!result.issue.message.includes('FAKE_TOKEN'));
    assert.match(result.issue.message, /check.*JSON/i);
  }
});

test('schema diagnostic issues omit rejected field values and unknown keys', () => {
  const schema = Schema.Struct({ version: Schema.Literal(1) });
  for (const value of [{ version: 'FAKE_TOKEN' }, { version: 1, FAKE_TOKEN: 'private' }]) {
    const result = decode(schema, value, 'pin', 'skill-pins.json');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issue.source, 'skill-pins.json');
      assert.ok(!result.issue.message.includes('FAKE_TOKEN'));
    }
  }
});
