import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choices, actionsFrom, seedKeys } from '../src/skill-actions.mjs';

const PLAN = {
  current: ['fine'],
  outdated: [{ name: 'tdd', source: 'o/r', from: 'aaaaaaa1', to: 'bbbbbbb2' }],
  gone: [{ name: 'to-issues', source: 'o/r', path: 's/to-issues' }],
  unknown: [],
  local: ['mine'],
  available: [{ name: 'wizard', source: 'o/r' }],
};

test('choices offers one row per actionable skill and nothing for current or local', () => {
  const rows = choices(PLAN, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.key), ['update:tdd', 'remove:to-issues', 'add:wizard']);
});

test('choices groups rows as update, remove and add in that order', () => {
  assert.deepEqual(choices(PLAN, { seeded: new Set() }).map((r) => r.group), ['update', 'remove', 'add']);
});

test('choices checks outdated by default and leaves remove and add clear', () => {
  const rows = choices(PLAN, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.checked), [true, false, false]);
});

test('choices checks a seeded row', () => {
  const rows = choices(PLAN, { seeded: new Set(['add:wizard']) });
  assert.equal(rows.find((r) => r.key === 'add:wizard').checked, true);
});

test('choices shows the SHA transition on an update row', () => {
  const row = choices(PLAN, { seeded: new Set() }).find((r) => r.key === 'update:tdd');
  assert.match(row.note, /aaaaaaa/);
  assert.match(row.note, /bbbbbbb/);
});

test('choices labels rows with the bare skill name', () => {
  assert.deepEqual(choices(PLAN, { seeded: new Set() }).map((r) => r.label), ['tdd', 'to-issues', 'wizard']);
});

test('choices on a plan with nothing actionable is empty', () => {
  const rows = choices(
    { current: ['a'], outdated: [], gone: [], unknown: [], local: ['b'], available: [] },
    { seeded: new Set() },
  );
  assert.deepEqual(rows, []);
});

test('choices tolerates a plan with no available key', () => {
  // planUpdates does not produce `available`; update.mjs merges it in. A plan
  // that lost it must not throw.
  const rows = choices({ ...PLAN, available: undefined }, { seeded: new Set() });
  assert.deepEqual(rows.map((r) => r.key), ['update:tdd', 'remove:to-issues']);
});

test('actionsFrom routes each selected key to its action', () => {
  const actions = actionsFrom(PLAN, ['update:tdd', 'remove:to-issues', 'add:wizard']);
  assert.deepEqual(actions.update, ['tdd']);
  assert.deepEqual(actions.remove, ['to-issues']);
  assert.deepEqual(actions.add, [{ name: 'wizard', source: 'o/r' }]);
});

test('actionsFrom on an empty selection is a no-op', () => {
  assert.deepEqual(actionsFrom(PLAN, []), { update: [], remove: [], add: [] });
});

test('actionsFrom ignores a key naming a skill not in the plan', () => {
  assert.deepEqual(actionsFrom(PLAN, ['update:ghost']).update, [], 'a stale key must not invent work');
});

test('actionsFrom keeps the source with each added skill', () => {
  // installGroups needs the source; losing it here would make the add
  // uninstallable with no obvious symptom.
  assert.equal(actionsFrom(PLAN, ['add:wizard']).add[0].source, 'o/r');
});

test('actionsFrom tolerates a plan with no available key', () => {
  // Same guard as choices() above, for actionsFrom's own `plan.available ??
  // []` — a plan that lost `available` must not throw.
  const actions = actionsFrom({ ...PLAN, available: undefined }, ['update:tdd']);
  assert.deepEqual(actions, { update: ['tdd'], remove: [], add: [] });
});

test('seedKeys with --prune checks every gone skill', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: [], prune: true })], ['remove:to-issues']);
});

test('seedKeys with named adds checks only those', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: ['wizard'], prune: false })], ['add:wizard']);
});

test('seedKeys ignores a named add that is not available', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: ['nope'], prune: false })], []);
});

test('seedKeys with neither flag seeds nothing', () => {
  assert.deepEqual([...seedKeys(PLAN, { add: [], prune: false })], []);
});

test('seedKeys tolerates a plan with no available key', () => {
  // Same guard as choices()/actionsFrom above, for seedKeys' own
  // `plan.available ?? []` — a --prune-only call must still work fine even
  // when `available` is missing from the plan entirely.
  assert.deepEqual([...seedKeys({ ...PLAN, available: undefined }, { add: [], prune: true })], ['remove:to-issues']);
});
