import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRow, section, labelWidth } from '../src/report.mjs';

// The state column starts wherever the label column ends, so a label longer
// than the pad width shunts every following column right. Callers with
// arbitrary labels (skill names) need to widen the column; callers with fixed
// labels must keep the shared default so existing reports do not shift.

test('formatRow pads to the shared default width when none is given', () => {
  assert.equal(formatRow('short', 'state', 'note'), '  short            state        note');
});

test('formatRow with an explicit width aligns the state column', () => {
  const rows = [
    formatRow('a-very-long-skill-name', 'outdated', 'x', 24),
    formatRow('tdd', 'outdated', 'y', 24),
  ];
  const columns = rows.map((r) => r.indexOf('outdated'));
  assert.equal(columns[0], columns[1], 'both state columns must start at the same offset');
});

test('an over-long label without a widened column pushes the state column right', () => {
  // Pins the defect the width parameter exists to fix, so a regression that
  // dropped the parameter would not look like an improvement.
  const long = formatRow('a-very-long-skill-name', 'outdated', 'x');
  const shortRow = formatRow('tdd', 'outdated', 'y');
  assert.notEqual(long.indexOf('outdated'), shortRow.indexOf('outdated'));
});

test('labelWidth never narrows below the shared default', () => {
  assert.equal(labelWidth(['a', 'bb']), labelWidth([]));
});

test('labelWidth grows to the longest label', () => {
  assert.equal(labelWidth(['setup-matt-pocock-skills']), 'setup-matt-pocock-skills'.length);
});

test('labelWidth on no labels is the default, not -Infinity', () => {
  assert.ok(labelWidth([]) > 0, 'Math.max of an empty spread must not leak -Infinity');
});

test('section still reports emptiness', () => {
  assert.match(section('t', []), /nothing to report/);
});
