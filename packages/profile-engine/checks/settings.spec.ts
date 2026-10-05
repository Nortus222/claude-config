import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILES } from '../src/files.ts';
import { parseSettingsKeys } from '../src/settings.ts';

const SOURCE = 'claude/settings.keys.json';

test('reads owned keys and their values', () => {
  assert.deepEqual(parseSettingsKeys('{"effortLevel":"high","worktree":{"a":[1]}}', SOURCE), {
    value: { effortLevel: 'high', worktree: { a: [1] } },
    issues: [],
  });
});

test('an absent document owns nothing and is not an issue', () => {
  assert.deepEqual(parseSettingsKeys(undefined, SOURCE), { value: undefined, issues: [] });
});

test('refuses unreadable, non-object, empty and secret-bearing documents whole', () => {
  for (const text of ['{', '[]', '"x"', '{}', '{"env":{"API_KEY":"x"}}', '{"a":"ghp_abcdefgh123"}']) {
    const parsed = parseSettingsKeys(text, SOURCE);
    assert.equal(parsed.value, undefined, text);
    assert.ok(parsed.issues.length > 0, text);
    assert.ok(parsed.issues.every((i) => i.layer === 'base' && i.source === SOURCE), text);
  }
});

test('the file table has unique ids and one merge-keys entry for Claude settings', () => {
  assert.equal(new Set(FILES.map((f) => f.id)).size, FILES.length);
  assert.deepEqual(
    FILES.filter((f) => f.mode === 'merge-keys').map((f) => [f.id, f.src]),
    [['claude:settings.json', 'claude/settings.keys.json']],
  );
});
