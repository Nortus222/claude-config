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
