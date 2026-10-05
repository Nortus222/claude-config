import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentInvalid, editEntry } from '../src/documents.ts';

const pins = (entries: object, indent: string | number = 2) =>
  JSON.stringify({ version: 1, pins: entries }, null, indent) + '\n';
const crlf = (text: string) => text.replace(/\n/g, '\r\n');

test('an absent file becomes a new document holding the entry', () => {
  assert.deepEqual(editEntry(undefined, 'pins', 'ada/skills', 'v1'), { text: pins({ 'ada/skills': 'v1' }) });
  assert.equal(
    editEntry(undefined, 'ignored', 'ada/skills', 'abc').text,
    JSON.stringify({ version: 1, ignored: { 'ada/skills': 'abc' } }, null, 2) + '\n',
  );
});

test('replacing an entry keeps its position and reports the old value', () => {
  assert.deepEqual(editEntry(pins({ a: '1', b: '2', c: '3' }), 'pins', 'b', '9'), {
    text: pins({ a: '1', b: '9', c: '3' }),
    previous: '2',
  });
});

test('a new entry is appended', () => {
  assert.deepEqual(editEntry(pins({ a: '1' }), 'pins', 'z', '2'), { text: pins({ a: '1', z: '2' }) });
});

test('removing an entry deletes only that key', () => {
  assert.deepEqual(editEntry(pins({ a: '1', b: '2' }), 'pins', 'a', undefined), { text: pins({ b: '2' }), previous: '1' });
  assert.deepEqual(editEntry(pins({ a: '1' }), 'pins', 'a', undefined), { text: pins({}), previous: '1' });
});

test('removing an absent entry or setting the same value returns the text unchanged', () => {
  const text = '{"version":1,"pins":{"a":"1"}}';
  assert.deepEqual(editEntry(text, 'pins', 'b', undefined), { text });
  assert.deepEqual(editEntry(text, 'pins', 'a', '1'), { text, previous: '1' });
});

test('unknown fields and their order are kept, and a missing field is appended', () => {
  const doc = (value: string) => JSON.stringify({ note: 'hi', version: 1, pins: { a: value }, extra: [1] }, null, 2) + '\n';
  assert.equal(editEntry(doc('1'), 'pins', 'a', '2').text, doc('2'));
  assert.equal(editEntry('{\n  "version": 1\n}\n', 'pins', 'a', '1').text, pins({ a: '1' }));
});

test('indentation, CRLF and a missing final newline are kept', () => {
  for (const indent of ['\t', '    ']) {
    assert.equal(editEntry(pins({ a: '1' }, indent), 'pins', 'a', '2').text, pins({ a: '2' }, indent));
  }
  assert.equal(editEntry(crlf(pins({ a: '1' })), 'pins', 'b', '2').text, crlf(pins({ a: '1', b: '2' })));
  assert.equal(editEntry(pins({ a: '1' }).trimEnd(), 'pins', 'a', '2').text, pins({ a: '2' }).trimEnd());
});

test('a compact document comes back with two-space indentation', () => {
  assert.equal(editEntry('{"version":1,"pins":{"a":"1"}}', 'pins', 'b', '2').text, pins({ a: '1', b: '2' }).trimEnd());
});

for (const [label, text, reason] of [
  ['text that is not JSON', '{', /^skill-pins\.json is not JSON/],
  ['an array', '[]', /^skill-pins\.json is not a JSON object$/],
  ['another version', '{"version":2,"pins":{}}', /^skill-pins\.json has a version other than 1$/],
  ['a field that is not an object', '{"version":1,"pins":[]}', /^skill-pins\.json pins is not an object$/],
  ['a value that is not a string', '{"version":1,"pins":{"a":1}}', /non-empty string keys and values$/],
  ['an empty value', '{"version":1,"pins":{"a":""}}', /non-empty string keys and values$/],
  ['an empty key', '{"version":1,"pins":{"":"v1"}}', /non-empty string keys and values$/],
] as const) {
  test(`a document with ${label} is refused`, () => {
    assert.throws(
      () => editEntry(text, 'pins', 'a', '1'),
      (error) => error instanceof DocumentInvalid && reason.test(error.reason),
    );
  });
}

test('an invalid ignores document names its own file', () => {
  assert.throws(
    () => editEntry('{', 'ignored', 'a', '1'),
    (error) => error instanceof DocumentInvalid && /^source-ignores\.json is not JSON/.test(error.reason),
  );
});

test('an empty source or value is refused rather than written', () => {
  for (const [source, value] of [['', 'v1'], ['a', '']] as const) {
    assert.throws(
      () => editEntry(undefined, 'pins', source, value),
      (error) => error instanceof DocumentInvalid && /non-empty string keys and values$/.test(error.reason),
    );
  }
});
