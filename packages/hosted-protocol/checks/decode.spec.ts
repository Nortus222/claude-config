import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';
import { decodeHosted, decodeRequestBody, utf8ByteLength, jsonByteLength, MAX_REQUEST_BODY_BYTES } from '../src/decode.ts';

const Body = Schema.Struct({ entries: Schema.Array(Schema.Struct({ name: Schema.String })) });

test('decoding rejects unknown fields recursively, including union branches', () => {
  const value = { entries: [{ name: 'one' }] };
  assert.deepEqual(decodeHosted(Body, JSON.parse(JSON.stringify(value))), value);
  for (const invalid of [{ ...value, extra: true }, { entries: [{ name: 'one', secret: 'TOKEN' }] }]) assert.throws(() => decodeHosted(Body, invalid));
  const Union = Schema.Union([Schema.Struct({ kind: Schema.Literal('a'), body: Body }), Schema.Struct({ kind: Schema.Literal('b') })]);
  assert.throws(() => decodeHosted(Union, { kind: 'a', body: { entries: [{ name: 'one', token: 'TOKEN' }] } }));
});

test('rejections carry generic errors without values, credentials or causes', () => {
  const secret = 'https://username:TOP_SECRET@host/repo';
  let error: unknown;
  try { decodeHosted(Schema.Number, secret); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error);
  assert.equal(error.message, 'Invalid hosted payload');
  assert.equal(error.cause, undefined);
  assert.ok(!String(error).includes(secret));
  assert.ok(!JSON.stringify(error).includes('TOP_SECRET'));
});

test('request limits measure UTF-8 JSON bytes and do not cap response decoding', () => {
  assert.equal(utf8ByteLength('😀é'), 6);
  assert.equal(jsonByteLength('😀é'), 8);
  const exact = 'a'.repeat(MAX_REQUEST_BODY_BYTES - 2);
  assert.equal(jsonByteLength(exact), MAX_REQUEST_BODY_BYTES);
  assert.equal(decodeRequestBody(Schema.String, exact), exact);
  assert.throws(() => decodeRequestBody(Schema.String, exact + 'a'));
  const multibyte = '😀'.repeat(MAX_REQUEST_BODY_BYTES / 4);
  assert.throws(() => decodeRequestBody(Schema.String, multibyte));
  assert.equal(decodeHosted(Schema.String, multibyte), multibyte);
  assert.throws(() => decodeRequestBody(Schema.Unknown, 1n));
  assert.throws(() => decodeRequestBody(Schema.Unknown, undefined));
  const cycle: { self?: unknown } = {}; cycle.self = cycle;
  assert.throws(() => decodeRequestBody(Schema.Unknown, cycle));
});
