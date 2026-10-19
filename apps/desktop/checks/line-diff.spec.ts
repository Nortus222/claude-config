import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, type Hunk } from '../src/line-diff.ts';

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`);
const text = (rows: readonly string[]) => rows.join('\n') + '\n';
// Renders hunks as unified-diff rows so expectations read like a patch.
const show = (hunks: readonly Hunk[]) => hunks.map(h => [`@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@`,
  ...h.lines.map(l => `${l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' '}${l.text}`)]);

test('identical text has no hunks', () => {
  assert.deepEqual(lineDiff(text(lines(5)), text(lines(5))), []);
  assert.deepEqual(lineDiff('', ''), []);
});

test('an insertion shows three context lines on each side', () => {
  const before = lines(10), after = [...before.slice(0, 5), 'new', ...before.slice(5)];
  assert.deepEqual(show(lineDiff(text(before), text(after))), [[
    '@@ -3,6 +3,7 @@', ' line 3', ' line 4', ' line 5', '+new', ' line 6', ' line 7', ' line 8',
  ]]);
});

test('a deletion at the start has only trailing context', () => {
  assert.deepEqual(show(lineDiff(text(lines(6)), text(lines(5, 2)))), [[
    '@@ -1,4 +1,3 @@', '-line 1', ' line 2', ' line 3', ' line 4',
  ]]);
});

test('a replacement lists removed lines before added ones', () => {
  const before = lines(3), after = ['line 1', 'changed', 'line 3'];
  assert.deepEqual(show(lineDiff(text(before), text(after))), [[
    '@@ -1,3 +1,3 @@', ' line 1', '-line 2', '+changed', ' line 3',
  ]]);
});

test('distant changes form separate hunks and near ones merge', () => {
  const before = lines(30);
  const far = before.map(l => l === 'line 2' || l === 'line 28' ? `${l}!` : l);
  assert.equal(lineDiff(text(before), text(far)).length, 2);
  const near = before.map(l => l === 'line 10' || l === 'line 16' ? `${l}!` : l);
  assert.equal(lineDiff(text(before), text(near)).length, 1);
});

test('an added file is one hunk of additions', () => {
  assert.deepEqual(show(lineDiff(null, 'a\nb\n')), [['@@ -0,0 +1,2 @@', '+a', '+b']]);
});

test('a removed file is one hunk of removals', () => {
  assert.deepEqual(show(lineDiff('a\nb', null)), [['@@ -1,2 +0,0 @@', '-a', '-b']]);
});

test('a missing final newline still compares line by line', () => {
  assert.deepEqual(show(lineDiff('a\nb', 'a\nb\n')), []);
});

test('inputs too large to compare in full still list every changed line', () => {
  const before = lines(2000), after = lines(2000, 5000);
  const [hunk, ...rest] = lineDiff(text(before), text(after));
  assert.equal(rest.length, 0);
  assert.equal(hunk!.lines.filter(l => l.kind === 'remove').length, 2000);
  assert.equal(hunk!.lines.filter(l => l.kind === 'add').length, 2000);
});
