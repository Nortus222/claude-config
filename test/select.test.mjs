import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, reduce, selectedKeys, groupOf } from '../src/select.mjs';

const ITEMS = [
  { key: 'u:a', group: 'update', label: 'a', note: '', checked: true },
  { key: 'u:b', group: 'update', label: 'b', note: '', checked: true },
  { key: 'r:c', group: 'remove', label: 'c', note: '', checked: false },
  { key: 'a:d', group: 'add', label: 'd', note: '', checked: false },
];

const press = (state, ...keys) => keys.reduce((s, k) => reduce(s, k).state, state);

test('initialState starts on the first item', () => {
  assert.equal(initialState(ITEMS).cursor, 0);
});

test('initialState on no items has no cursor', () => {
  assert.equal(initialState([]).cursor, -1);
});

test('initialState does not mutate the caller\'s items', () => {
  const items = [{ key: 'x', group: 'g', label: 'x', note: '', checked: false }];
  const state = initialState(items);
  reduce(state, 'space');
  assert.equal(items[0].checked, false, 'reduce must not write through to the input');
});

test('down moves one item and up moves back', () => {
  const s = press(initialState(ITEMS), 'down');
  assert.equal(s.cursor, 1);
  assert.equal(press(s, 'up').cursor, 0);
});

test('j and k move like down and up', () => {
  assert.equal(press(initialState(ITEMS), 'j').cursor, 1);
  assert.equal(press(initialState(ITEMS), 'j', 'k').cursor, 0);
});

test('down wraps from the last item to the first', () => {
  assert.equal(press(initialState(ITEMS), 'down', 'down', 'down', 'down').cursor, 0);
});

test('up wraps from the first item to the last', () => {
  assert.equal(press(initialState(ITEMS), 'up').cursor, ITEMS.length - 1);
});

test('space toggles only the item under the cursor', () => {
  const s = press(initialState(ITEMS), 'space');
  assert.equal(s.items[0].checked, false, 'a checked item toggles off');
  assert.equal(s.items[1].checked, true, 'its neighbour is untouched');
});

test('space checks an unchecked item', () => {
  const s = press(initialState(ITEMS), 'down', 'down', 'space');
  assert.equal(s.items[2].checked, true);
});

test('a checks every item in the current group only', () => {
  // Cursor parked in the middle group, so an implementation that ignores the
  // cursor and checks everything cannot pass.
  const s = press(initialState(ITEMS), 'down', 'down', 'a');
  assert.equal(s.items[2].checked, true, 'the current group is checked');
  assert.equal(s.items[3].checked, false, 'a later group must be untouched');
  assert.equal(s.items[0].checked, true, 'an earlier group keeps its own state');
});

test('n clears every item in the current group only', () => {
  const s = press(initialState(ITEMS), 'n');
  assert.equal(s.items[0].checked, false);
  assert.equal(s.items[1].checked, false);
  assert.equal(s.items[2].checked, false, 'remove was already clear');
  const seeded = press(initialState(ITEMS), 'down', 'down', 'space', 'up', 'up', 'n');
  assert.equal(seeded.items[2].checked, true, 'clearing update must not clear remove');
});

test('A checks every item in every group', () => {
  const s = press(initialState(ITEMS), 'A');
  assert.ok(s.items.every((i) => i.checked));
});

test('N clears every item in every group', () => {
  const s = press(initialState(ITEMS), 'N');
  assert.ok(s.items.every((i) => !i.checked));
});

test('enter reports confirm', () => {
  assert.equal(reduce(initialState(ITEMS), 'return').done, 'confirm');
});

test('escape, ctrl-c and q report cancel', () => {
  for (const key of ['escape', 'ctrl-c', 'q']) {
    assert.equal(reduce(initialState(ITEMS), key).done, 'cancel', `${key} should cancel`);
  }
});

test('an unrecognised key changes nothing and does not finish', () => {
  const before = initialState(ITEMS);
  const { state, done } = reduce(before, 'z');
  assert.equal(done, null);
  assert.deepEqual(selectedKeys(state), selectedKeys(before));
  assert.equal(state.cursor, before.cursor);
});

test('selectedKeys returns checked keys in display order', () => {
  assert.deepEqual(selectedKeys(initialState(ITEMS)), ['u:a', 'u:b']);
});

test('selectedKeys on an all-clear state is empty', () => {
  assert.deepEqual(selectedKeys(press(initialState(ITEMS), 'N')), []);
});

test('groupOf names the group under the cursor', () => {
  assert.equal(groupOf(initialState(ITEMS)), 'update');
  assert.equal(groupOf(press(initialState(ITEMS), 'down', 'down')), 'remove');
});

test('keys on an empty list do not throw', () => {
  const empty = initialState([]);
  for (const key of ['down', 'up', 'space', 'a', 'A', 'n', 'N']) {
    assert.doesNotThrow(() => reduce(empty, key), `${key} on an empty list`);
  }
  assert.equal(reduce(empty, 'return').done, 'confirm');
});
