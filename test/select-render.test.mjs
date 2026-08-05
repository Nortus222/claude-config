import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { initialState, render, keyName, select } from '../src/select.mjs';

const ITEMS = [
  { key: 'u:a', group: 'update', label: 'ask-matt', note: 'c7d5778 -> c9c83b1', checked: true },
  { key: 'u:b', group: 'update', label: 'setup-matt-pocock-skills', note: '634cf9b -> abf20c0', checked: true },
  { key: 'r:c', group: 'remove', label: 'to-issues', note: 'gone upstream', checked: false },
];

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('render marks checked and unchecked items differently', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /◉ ask-matt/);
  assert.match(out, /◯ to-issues/);
});

test('render puts the cursor on the current item only', () => {
  const lines = render(initialState(ITEMS), { title: 't' });
  const pointed = lines.filter((l) => l.includes('❯'));
  assert.equal(pointed.length, 1);
  assert.match(pointed[0], /ask-matt/);
});

test('render emits one header per group, in first-appearance order', () => {
  const lines = render(initialState(ITEMS), { title: 't' });
  const headers = lines.filter((l) => /^\s*(update|remove) \(\d+\)/.test(l));
  assert.deepEqual(headers.map((h) => h.trim().split(' ')[0]), ['update', 'remove']);
});

test('render counts the items in each group header', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /update \(2\)/);
  assert.match(out, /remove \(1\)/);
});

test('render aligns notes past the longest label', () => {
  const lines = render(initialState(ITEMS), { title: 't' }).filter((l) => / -> |gone/.test(l));
  const columns = lines.map((l) => l.indexOf(l.match(/(c7d5778|634cf9b|gone)/)[0]));
  assert.equal(new Set(columns).size, 1, 'every note must start at the same column');
});

test('render includes the key legend', () => {
  const out = render(initialState(ITEMS), { title: 't' }).join('\n');
  assert.match(out, /space/);
  assert.match(out, /enter/);
  assert.match(out, /esc/);
});

test('render shows the title', () => {
  assert.match(render(initialState(ITEMS), { title: 'pick some' }).join('\n'), /pick some/);
});

test('keyName maps arrows, space, enter and escape', () => {
  assert.equal(keyName('', { name: 'up' }), 'up');
  assert.equal(keyName('', { name: 'down' }), 'down');
  assert.equal(keyName(' ', { name: 'space' }), 'space');
  assert.equal(keyName('', { name: 'return' }), 'return');
  assert.equal(keyName('', { name: 'escape' }), 'escape');
});

test('keyName maps ctrl-c regardless of the letter case reported', () => {
  assert.equal(keyName('', { name: 'c', ctrl: true }), 'ctrl-c');
});

test('keyName preserves case so a and A stay distinct', () => {
  assert.equal(keyName('a', { name: 'a', shift: false }), 'a');
  assert.equal(keyName('A', { name: 'a', shift: true }), 'A');
});

test('keyName returns null for a key with no meaning', () => {
  assert.equal(keyName('', { name: 'f5' }), null);
});

test('select returns null without a TTY rather than waiting forever', async () => {
  const answer = await select(ITEMS, {
    title: 't', input: Readable.from([]), output: sink(), isTTY: false,
  });
  assert.equal(answer, null);
});

test('select on an empty item list returns an empty selection without a TTY', async () => {
  const answer = await select([], {
    title: 't', input: Readable.from([]), output: sink(), isTTY: false,
  });
  assert.deepEqual(answer, [], 'nothing to choose is not the same as refusing to ask');
});

test('a throw while processing a keypress rejects instead of hanging', { timeout: 2000 }, async () => {
  // isTTY: true drives select() into the real keypress loop, but the input
  // stream has no setRawMode, so the "don't enter raw mode in a test" rule
  // still holds — only the state machine and the render loop actually run.
  const input = Readable.from([]);
  let calls = 0;
  const output = sink();
  // Own-property override shadows Writable.prototype.write, so the throw
  // happens synchronously at the exact call site select() uses, not buried
  // in stream internals. Call 1 is the hide-cursor write, call 2 is the
  // initial draw, call 3 is the draw triggered by the keypress below.
  output.write = () => {
    calls += 1;
    if (calls === 3) throw new Error('boom');
    return true;
  };

  const promise = select(ITEMS, { title: 't', input, output, isTTY: true });
  input.emit('keypress', '', { name: 'down' });

  await assert.rejects(promise, /boom/);
});

// A single group of many short, uniquely-labelled items — long enough that
// no reasonable maxRows fits it all, and plain enough that the window edges
// and the cursor's row are easy to pick out by label.
const manyItems = (count) => Array.from({ length: count }, (_, i) => ({
  key: `k:${i}`, group: 'g', label: `item-${i}`, note: 'note', checked: false,
}));

test('a list longer than maxRows renders no more than maxRows lines', () => {
  const state = initialState(manyItems(40));
  const lines = render(state, { title: 't', maxRows: 12 });
  assert.ok(lines.length <= 12, `expected <= 12 lines, got ${lines.length}`);
});

test("the cursor's row is always within the window", () => {
  const items = manyItems(40);
  for (const cursor of [0, 20, 39]) {
    const state = { ...initialState(items), cursor };
    const lines = render(state, { title: 't', maxRows: 12 });
    const pointed = lines.filter((l) => l.includes('❯'));
    assert.equal(pointed.length, 1, `cursor ${cursor}: expected exactly one pointer line`);
    assert.match(pointed[0], new RegExp(`item-${cursor}\\b`), `cursor ${cursor}: pointer is on the wrong row`);
  }
});

test('the above/below markers appear only when rows are actually hidden', () => {
  // Everything fits: no marker in either direction.
  const short = render(initialState(manyItems(3)), { title: 't', maxRows: 12 });
  assert.doesNotMatch(short.join('\n'), /more above|more below/);

  // Cursor at the top of a long list: only "below" is hidden.
  const atStart = render({ ...initialState(manyItems(40)), cursor: 0 }, { title: 't', maxRows: 12 });
  assert.doesNotMatch(atStart.join('\n'), /more above/);
  assert.match(atStart.join('\n'), /more below/);

  // Cursor at the bottom of a long list: only "above" is hidden.
  const atEnd = render({ ...initialState(manyItems(40)), cursor: 39 }, { title: 't', maxRows: 12 });
  assert.match(atEnd.join('\n'), /more above/);
  assert.doesNotMatch(atEnd.join('\n'), /more below/);
});

test('a label longer than width is truncated rather than wrapped', () => {
  const items = [
    { key: 'k:1', group: 'g', label: 'x'.repeat(200), note: 'note', checked: false },
  ];
  const lines = render(initialState(items), { title: 't', width: 40 });
  for (const line of lines) {
    assert.ok(line.length <= 40, `line exceeds width 40: ${JSON.stringify(line)}`);
  }
  assert.ok(!lines.some((l) => l.includes('x'.repeat(200))), 'the full label must not appear whole');
});
