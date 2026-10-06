import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DocumentInvalid, editEntry } from '../src/documents.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const pins = (entries: object, indent: string | number = 2) =>
  JSON.stringify({ version: 1, pins: entries }, null, indent) + '\n';
const crlf = (text: string) => text.replace(/\n/g, '\r\n');

test('an absent file becomes a new document holding the entry', () => {
  assert.deepEqual(editEntry(undefined, 'pins', 'ada/skills', A), { text: pins({ 'ada/skills': A }) });
  assert.equal(
    editEntry(undefined, 'ignored', 'ada/skills', 'abc').text,
    JSON.stringify({ version: 1, ignored: { 'ada/skills': 'abc' } }, null, 2) + '\n',
  );
});

test('replacing an entry keeps its position and reports the old value', () => {
  assert.deepEqual(editEntry(pins({ a: A, b: B, c: C }), 'pins', 'b', D), {
    text: pins({ a: A, b: D, c: C }),
    previous: B,
  });
});

test('a new entry is appended', () => {
  assert.deepEqual(editEntry(pins({ a: A }), 'pins', 'z', B), { text: pins({ a: A, z: B }) });
});

test('removing an entry deletes only that key', () => {
  assert.deepEqual(editEntry(pins({ a: A, b: B }), 'pins', 'a', undefined), { text: pins({ b: B }), previous: A });
  assert.deepEqual(editEntry(pins({ a: A }), 'pins', 'a', undefined), { text: pins({}), previous: A });
});

test('removing an absent entry or setting the same value returns the text unchanged', () => {
  const text = `{"version":1,"pins":{"a":"${A}"}}`;
  assert.deepEqual(editEntry(text, 'pins', 'b', undefined), { text });
  assert.deepEqual(editEntry(text, 'pins', 'a', A), { text, previous: A });
});

test('unknown fields and their order are kept, and a missing field is appended', () => {
  const doc = (value: string) => JSON.stringify({ note: 'hi', version: 1, ignored: { a: value }, extra: [1] }, null, 2) + '\n';
  assert.equal(editEntry(doc(A), 'ignored', 'a', B).text, doc(B));
  assert.equal(editEntry('{\n  "version": 1\n}\n', 'ignored', 'a', A).text, JSON.stringify({ version: 1, ignored: { a: A } }, null, 2) + '\n');
});

test('indentation, CRLF and a missing final newline are kept', () => {
  for (const indent of ['\t', '    ']) {
    assert.equal(editEntry(pins({ a: A }, indent), 'pins', 'a', B).text, pins({ a: B }, indent));
  }
  assert.equal(editEntry(crlf(pins({ a: A })), 'pins', 'b', B).text, crlf(pins({ a: A, b: B })));
  assert.equal(editEntry(pins({ a: A }).trimEnd(), 'pins', 'a', B).text, pins({ a: B }).trimEnd());
});

test('a compact document comes back with two-space indentation', () => {
  assert.equal(editEntry(`{"version":1,"pins":{"a":"${A}"}}`, 'pins', 'b', B).text, pins({ a: A, b: B }).trimEnd());
});

for (const [label, text, reason] of [
  ['text that is not JSON', '{', /^skill-pins\.json /],
  ['an array', '[]', /^skill-pins\.json /],
  ['another version', '{"version":2,"pins":{}}', /^skill-pins\.json /],
  ['a field that is not an object', '{"version":1,"pins":[]}', /^skill-pins\.json /],
  ['a value that is not a string', '{"version":1,"pins":{"a":1}}', /^skill-pins\.json /],
  ['an empty value', '{"version":1,"pins":{"a":""}}', /^skill-pins\.json /],
  ['an empty key', `{"version":1,"pins":{"":"${A}"}}`, /^skill-pins\.json /],
  ['a pin that is a branch', '{"version":1,"pins":{"a":"main"}}', /^skill-pins\.json /],
  ['an unknown field', '{"version":1,"pins":{},"x":1}', /^skill-pins\.json /],
  ['no pins field', '{"version":1}', /^skill-pins\.json /],
] as const) {
  test(`a pins document with ${label} is refused`, () => {
    assert.throws(
      () => editEntry(text, 'pins', 'a', A),
      (error) => error instanceof DocumentInvalid && reason.test(error.reason),
    );
  });
}

for (const [label, text, reason] of [
  ['text that is not JSON', '{', /^source-ignores\.json is not JSON/],
  ['an array', '[]', /^source-ignores\.json is not a JSON object$/],
  ['another version', '{"version":2,"ignored":{}}', /^source-ignores\.json has a version other than 1$/],
  ['a field that is not an object', '{"version":1,"ignored":[]}', /^source-ignores\.json ignored is not an object$/],
  ['a value that is not a string', '{"version":1,"ignored":{"a":1}}', /non-empty string keys and values$/],
  ['an empty value', '{"version":1,"ignored":{"a":""}}', /non-empty string keys and values$/],
  ['an empty key', '{"version":1,"ignored":{"":"v1"}}', /non-empty string keys and values$/],
] as const) {
  test(`an ignores document with ${label} is refused`, () => {
    assert.throws(
      () => editEntry(text, 'ignored', 'a', A),
      (error) => error instanceof DocumentInvalid && reason.test(error.reason),
    );
  });
}

test('setting a pin that is not a commit sha is refused', () => {
  assert.throws(() => editEntry(undefined, 'pins', 'a', 'main'), DocumentInvalid);
});

test('an empty source or value is refused rather than written', () => {
  for (const [source, value] of [['', A], ['a', '']] as const) {
    assert.throws(
      () => editEntry(undefined, 'pins', source, value),
      (error) => error instanceof DocumentInvalid,
    );
  }
});
