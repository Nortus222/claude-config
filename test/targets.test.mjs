import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, parseTarget, selectedTargets, entriesForTarget } from '../src/targets.mjs';

test('target defaults to all and is removed from remaining args', () => {
  assert.deepEqual(parseTarget(['--skills']), { target: 'all', rest: ['--skills'], error: null });
});

test('target accepts both supported agents', () => {
  assert.deepEqual(parseTarget(['--target', 'codex']), { target: 'codex', rest: [], error: null });
  assert.deepEqual(selectedTargets('all'), ['claude', 'codex']);
});

test('target rejects missing, unknown, and repeated values', () => {
  assert.match(parseTarget(['--target']).error, /requires/);
  assert.match(parseTarget(['--target', 'cursor']).error, /claude\|codex\|all/);
  assert.match(parseTarget(['--target', 'claude', '--target', 'codex']).error, /once/);
});

test('entriesForTarget includes both entries for all', () => {
  const entries = [
    { target: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
    { target: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy' },
  ];
  assert.deepEqual(entriesForTarget(entries, 'codex'), [entries[1]]);
  assert.deepEqual(entriesForTarget(entries, 'all'), entries);
});

// The two supported agents, and only those two. A third name silently joining
// TARGETS would widen every --target check at once, including the validation
// that keeps an unknown agent from ever reaching a filesystem path.
test('TARGETS names exactly claude and codex', () => {
  assert.deepEqual([...TARGETS].sort(), ['claude', 'codex']);
});

test('selectedTargets narrows to the one named agent', () => {
  assert.deepEqual(selectedTargets('claude'), ['claude']);
  assert.deepEqual(selectedTargets('codex'), ['codex']);
});

// selectedTargets('all') hands out the expansion of a module-level constant.
// Returning TARGETS itself would let one caller's sort() or push() rewrite
// every later caller's answer.
test('selectedTargets never hands back the shared TARGETS array', () => {
  const first = selectedTargets('all');
  first.push('cursor');
  assert.deepEqual(selectedTargets('all'), ['claude', 'codex']);
  assert.deepEqual([...TARGETS].sort(), ['claude', 'codex']);
});

// A flag-shaped value is a missing argument, not a target named "--skills":
// swallowing the next flag would drop it from `rest` and silently disable it.
test('a following flag is a missing --target value, not the value itself', () => {
  const result = parseTarget(['--target', '--skills']);
  assert.match(result.error, /requires/);
});

test('args before and after --target both survive into rest', () => {
  assert.deepEqual(parseTarget(['--yes', '--target', 'claude', '--no-skills']), {
    target: 'claude',
    rest: ['--yes', '--no-skills'],
    error: null,
  });
});

// Repeating the same value is still a repeat. Accepting `--target claude
// --target claude` would mean the "only once" rule is really an "only one
// distinct value" rule, and the next reader would have to guess which.
test('--target is rejected on the second occurrence even when the values agree', () => {
  assert.match(parseTarget(['--target', 'claude', '--target', 'claude']).error, /once/);
});

// An error is a refusal, and a refusal must not also look like an answer:
// every caller returns 2 on `error`, so a target smuggled out alongside it
// would only matter if some caller forgot to check.
test('a rejected target reports the default rather than a half-parsed value', () => {
  assert.equal(parseTarget(['--target', 'cursor']).target, 'all');
});
