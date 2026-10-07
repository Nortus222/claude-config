import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Decision } from '@nortuscc/machine';
import type { ItemChange } from '@nortuscc/sync';
import { choiceRows, chosenFrom, parseSyncFlags, previewLines } from '../src/commands/sync.ts';

const EFFORT = 'setting:claude:settings.json#effortLevel';
const THEME = 'setting:claude:settings.json#theme';
const HEAD = 'b'.repeat(40);
const effort: ItemChange = { itemId: EFFORT, kind: 'setting', before: '"high"', after: '"medium"' };
const theme: ItemChange = { itemId: THEME, kind: 'setting', before: '"auto"', after: '"light"' };
const file: ItemChange = { itemId: 'file:claude:CLAUDE.md', kind: 'file', before: 'sha256:' + '1'.repeat(64), after: undefined };
const conflict = { itemId: THEME, override: 'settings.claude:settings.json.theme' };

test('sync flags: its own are taken out, the rest reach apply', () => {
  assert.deepEqual(parseSyncFlags(['--check']), { check: true, yes: false, release: undefined, skip: [], takeTheirs: [], rest: [], error: null });
  const parsed = parseSyncFlags(['--yes', '--skip', `${EFFORT},${THEME}`, '--take-theirs=x', '--take-repo', '--install']);
  assert.deepEqual(parsed.skip, [EFFORT, THEME]);
  assert.deepEqual(parsed.takeTheirs, ['x']);
  assert.deepEqual(parsed.rest, ['--yes', '--take-repo', '--install']);
  assert.equal(parsed.yes, true);
  assert.equal(parseSyncFlags(['--release', EFFORT]).release, EFFORT);
});

test('sync flags: a missing id or a contradictory combination is an error', () => {
  assert.match(parseSyncFlags(['--skip']).error ?? '', /--skip needs an item id/);
  assert.match(parseSyncFlags(['--skip', '--yes']).error ?? '', /--skip needs an item id/);
  assert.match(parseSyncFlags(['--check', '--skip', EFFORT]).error ?? '', /--check reports only/);
  assert.match(parseSyncFlags(['--release', EFFORT, '--skip', THEME]).error ?? '', /--release takes no/);
});

test('the preview shows one row per item, old → new, then the conflicts', () => {
  const lines = previewLines([effort, file], [conflict]);
  assert.match(lines[0]!, /^ {2}setting:claude:settings\.json#effortLevel\s+changed\s+"high" → "medium"$/);
  assert.match(lines[1]!, /^ {2}file:claude:CLAUDE\.md\s+removed\s+sha256:1111111 → \(absent\)$/);
  assert.match(lines.join('\n'), /setting:claude:settings\.json#theme\s+conflict\s+overridden by settings\.claude:settings\.json\.theme/);
  assert.deepEqual(previewLines([], []), ['  setup            current      nothing new since the last sync']);
});

test('every item is ticked unless skipped by flag or at this head before; conflicts keep the override unless taken', () => {
  const skipped: Decision = {
    setupId: 'local', itemId: THEME, revision: null, commit: HEAD, decision: 'skip', decidedAt: '2026-10-07T00:00:00.000Z', machineId: null, source: 'local',
  };
  const rows = choiceRows([effort, theme, file], [conflict], [skipped], HEAD, { skip: ['file:claude:CLAUDE.md'], takeTheirs: [] });
  assert.deepEqual(rows.map((r) => [r.key, r.checked]), [
    [`item:${EFFORT}`, true], [`item:${THEME}`, false], ['item:file:claude:CLAUDE.md', false], [`theirs:${THEME}`, false],
  ]);
  const taking = choiceRows([theme], [conflict], [], HEAD, { skip: [], takeTheirs: [THEME] });
  assert.equal(taking.find((r) => r.key === `theirs:${THEME}`)!.checked, true);
});

test('taking theirs also accepts the item', () => {
  const chosen = chosenFrom([`item:${EFFORT}`, `theirs:${THEME}`]);
  assert.deepEqual([...chosen.accepted].sort(), [EFFORT, THEME]);
  assert.deepEqual([...chosen.takeTheirs], [THEME]);
});
