import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Schema } from 'effect';
import * as P from '../src/primitives.ts';
import { decodeHosted } from '../src/decode.ts';

const cases = (schema: Schema.ConstraintDecoder<unknown>, valid: readonly unknown[], invalid: readonly unknown[]) => {
  for (const value of valid) assert.equal(decodeHosted(schema, value), value);
  for (const value of invalid) assert.throws(() => decodeHosted(schema, value), Error, String(value));
};

test('opaque IDs and safe integer counters enforce their distinct ranges', () => {
  cases(P.IdSchema, ['A-23', 'x'.repeat(100)], ['', 'local', 'a_b', 'a:b', 'a'.repeat(101)]);
  cases(P.RevisionNumberSchema, [1, Number.MAX_SAFE_INTEGER], [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1']);
  for (const schema of [P.RevisionCursorSchema, P.SequenceSchema, P.CountSchema]) {
    cases(schema, [0, 1, Number.MAX_SAFE_INTEGER], [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]);
  }
});

test('timestamps require a timezone and a valid calendar date', () => {
  cases(P.IsoTimeSchema,
    ['2024-02-29T23:59:59Z', '2026-10-07T01:02:03.123+05:30', '2026-10-07T01:02:03-08:00'],
    ['2025-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-00T00:00:00Z',
      '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00', '2026-01-01', '2026-01-01T00:00:00Z extra']);
});

test('commit hashes, tags and environment names contain only their supported syntax', () => {
  cases(P.CommitShaSchema, ['a'.repeat(40), '0123456789abcdef'.repeat(4)], ['A'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]);
  cases(P.TagSchema, ['v1.0.0', 'release/v2', 'release-1'],
    ['', '-v1', 'refs/tags/v1', 'v..1', '.v1', 'x/.v1', 'v1.lock', 'x.lock/v1', 'x@{y', '@', 'v1.', 'v1/', '/v1',
      'v 1', 'v\n1', 'x//y', 'v~1', 'v^1', 'v:1', 'v?1', 'v*1', 'v[1', 'v\\1']);
  cases(P.EnvNameSchema, ['API_KEY', '_KEY', 'x1'], ['', '1KEY', 'API-KEY', 'KEY=value', 'key\n']);
});

test('names and enumerations are bounded user metadata', () => {
  cases(P.DisplayNameSchema, ['Work Mac', '机器', '😀'.repeat(100)], ['', ' ', ' name', 'name ', 'a'.repeat(101), 'x\n', 'x\u0000y', 'x\u200by']);
  cases(P.PolicySchema, [...P.POLICIES], ['automatic', 'local']);
  cases(P.AgentKindSchema, ['claude', 'codex'], ['other']);
  cases(P.OsSchema, ['macos', 'linux', 'windows'], ['darwin']);
});
