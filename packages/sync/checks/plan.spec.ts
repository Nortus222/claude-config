import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflictsOf, incoming, incomingChanges, nextHolds, withoutOverride, type ItemChange } from '../src/index.ts';
import { json, runSync, tempRepo } from './support/repo.ts';

const THEME = 'setting:claude:settings.json#theme';
const EFFORT = 'setting:claude:settings.json#effortLevel';
const MODEL = 'setting:claude:settings.json#model';
const OLD = '1'.repeat(40);
const APPLIED = '2'.repeat(40);
const values = (entries: Record<string, string>) => new Map(Object.entries(entries));
const change = (itemId: string, kind: ItemChange['kind'] = 'setting'): ItemChange => ({ itemId, kind, before: '"a"', after: '"b"' });

test('an item counts when upstream moved it, measured from what this machine holds now', () => {
  const changes = incomingChanges({
    rawApplied: values({ [THEME]: '"auto"', [EFFORT]: '"high"', [MODEL]: '"opus"' }),
    current: values({ [THEME]: '"auto"', [EFFORT]: '"low"', [MODEL]: '"opus"' }),
    head: values({ [THEME]: '"light"', [EFFORT]: '"high"', [MODEL]: '"opus"' }),
  });
  // effortLevel is held at "low" and upstream did not move it, so it is not offered again.
  assert.deepEqual(changes, [{ itemId: THEME, kind: 'setting', before: '"auto"', after: '"light"' }]);
});

test('a held item that upstream changes again comes back, from its held value', () => {
  const changes = incomingChanges({
    rawApplied: values({ [EFFORT]: '"high"' }),
    current: values({ [EFFORT]: '"low"' }),
    head: values({ [EFFORT]: '"max"' }),
  });
  assert.deepEqual(changes, [{ itemId: EFFORT, kind: 'setting', before: '"low"', after: '"max"' }]);
});

test('an item already at its head value is not offered', () => {
  assert.deepEqual(incomingChanges({
    rawApplied: values({ [THEME]: '"auto"' }),
    current: values({ [THEME]: '"light"' }),
    head: values({ [THEME]: '"light"' }),
  }), []);
});

test('conflicts are the incoming items an override shadows; files never conflict', () => {
  const overrides = { settings: { 'claude:settings.json': { theme: 'dark' } }, skills: { tdd: false }, integrations: { hk: false } };
  const changes = [
    change(THEME), change(EFFORT), change('skill:mattpocock/skills/tdd', 'skill'), change('integration:hk', 'integration'),
    change('file:claude:CLAUDE.md', 'file'),
  ];
  assert.deepEqual(conflictsOf(changes, overrides), [
    { itemId: THEME, override: 'settings.claude:settings.json.theme' },
    { itemId: 'skill:mattpocock/skills/tdd', override: 'skills.tdd' },
    { itemId: 'integration:hk', override: 'integrations.hk' },
  ]);
});

test('withoutOverride drops only the entry an item conflicts with, and containers it empties', () => {
  const overrides = { manageConfig: true, settings: { 'claude:settings.json': { theme: 'dark', model: 'x' } }, skills: { tdd: false } };
  assert.deepEqual(withoutOverride(overrides, THEME), { manageConfig: true, settings: { 'claude:settings.json': { model: 'x' } }, skills: { tdd: false } });
  assert.deepEqual(withoutOverride(overrides, 'skill:mattpocock/skills/tdd'), { manageConfig: true, settings: overrides.settings });
  assert.deepEqual(withoutOverride({ settings: { 'claude:settings.json': { theme: 'dark' } } }, THEME), {});
  assert.equal(withoutOverride(overrides, 'file:claude:CLAUDE.md'), overrides);
  assert.equal(withoutOverride(overrides, 'integration:hk'), overrides);
});

test('nextHolds releases accepted items, holds skipped ones where they were, and keeps the rest', () => {
  const held = nextHolds({
    holds: { [EFFORT]: OLD, 'file:claude:CLAUDE.md': OLD, [MODEL]: OLD },
    changes: [change(EFFORT), change(THEME), change(MODEL)],
    accepted: new Set([MODEL]),
    applied: APPLIED,
  });
  assert.deepEqual(held, { [EFFORT]: OLD, 'file:claude:CLAUDE.md': OLD, [THEME]: APPLIED });
});

test('incoming reads the applied and head commits and the holds from git', async () => {
  const repo = tempRepo();
  const head = repo.commit({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  const result = await runSync(incoming({
    repo: repo.dir, applied: repo.first, head, holds: { [EFFORT]: repo.first },
    overrides: { settings: { 'claude:settings.json': { theme: 'dark' } } },
  }));
  assert.deepEqual(result.changes.map((c) => [c.itemId, c.before, c.after]), [[EFFORT, '"high"', '"medium"'], [THEME, '"auto"', '"light"']]);
  assert.deepEqual(result.conflicts, [{ itemId: THEME, override: 'settings.claude:settings.json.theme' }]);
});

test('incoming at the applied commit itself has nothing', async () => {
  const repo = tempRepo();
  assert.deepEqual(await runSync(incoming({ repo: repo.dir, applied: repo.first, head: repo.first, holds: {}, overrides: {} })), { changes: [], conflicts: [] });
});
