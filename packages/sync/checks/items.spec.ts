import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffItems, itemValues, parseItemId } from '../src/index.ts';
import { BASE, json, withDocuments } from './support/repo.ts';

test('every kind of item in a setup has a value', () => {
  assert.deepEqual([...itemValues(BASE).keys()].sort(), [
    'file:claude:CLAUDE.md',
    'integration:hk', 'integration:sp',
    'setting:claude:settings.json#effortLevel', 'setting:claude:settings.json#theme',
    'skill:anthropics/skills/pdf', 'skill:mattpocock/skills/diagnose', 'skill:mattpocock/skills/tdd',
  ]);
  assert.equal(itemValues(BASE).get('setting:claude:settings.json#theme'), '"auto"');
  assert.match(itemValues(BASE).get('file:claude:CLAUDE.md')!, /^sha256:[0-9a-f]{64}$/);
});

const sp = (plugin: string) => json({
  version: 1,
  integrations: [
    { id: 'hk', label: 'session hook', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/hk.mjs' },
    { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin },
  ],
});

const rows: ReadonlyArray<readonly [string, Readonly<Record<string, string | null>>, ReadonlyArray<string>]> = [
  ['a settings value', { 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'high' }) }, ['setting:claude:settings.json#theme']],
  ['a settings key', { 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high', model: 'opus' }) }, ['setting:claude:settings.json#model']],
  ['an instruction file', { 'claude/CLAUDE.md': '# new rules\n' }, ['file:claude:CLAUDE.md']],
  ['a copied file', { 'codex/AGENTS.md': '# codex\n' }, ['file:codex:AGENTS.md']],
  ['a skill', { 'skills-manifest.txt': '[mattpocock/skills]\ntdd\ndiagnose\ngrill\n\n[anthropics/skills] optional\npdf\n' }, ['skill:mattpocock/skills/grill']],
  ['a group marker', { 'skills-manifest.txt': '[mattpocock/skills]\ntdd\ndiagnose\n\n[anthropics/skills]\npdf\n' }, ['skill:anthropics/skills/pdf']],
  ['a pin, which moves every skill of its source', { 'skill-pins.json': json({ version: 1, pins: { 'mattpocock/skills': 'b'.repeat(40) } }) },
    ['skill:mattpocock/skills/diagnose', 'skill:mattpocock/skills/tdd']],
  ['an integration', { 'integrations.json': sp('superpowers@other') }, ['integration:sp']],
];

for (const [what, changes, ids] of rows) {
  test(`diffItems lists ${what}, in both directions`, () => {
    const after = withDocuments(BASE, changes);
    const forward = diffItems(itemValues(BASE), itemValues(after));
    const backward = diffItems(itemValues(after), itemValues(BASE));
    assert.deepEqual(forward.map((c) => c.itemId), ids);
    assert.deepEqual(backward.map((c) => c.itemId), ids);
    forward.forEach((change, i) => {
      assert.equal(change.before, backward[i]!.after);
      assert.equal(change.after, backward[i]!.before);
      assert.equal(change.kind, parseItemId(change.itemId)!.kind);
    });
  });
}

test('an added item has no before value and a removed one no after value', () => {
  const after = withDocuments(BASE, { 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'high', model: 'opus' }) });
  assert.deepEqual(diffItems(itemValues(BASE), itemValues(after)), [
    { itemId: 'setting:claude:settings.json#model', kind: 'setting', before: undefined, after: '"opus"' },
  ]);
  assert.equal(diffItems(itemValues(after), itemValues(BASE))[0]!.after, undefined);
});

test('an unchanged setup has no items', () => {
  assert.deepEqual(diffItems(itemValues(BASE), itemValues(BASE)), []);
});

test('a refused settings document owns no keys, so its keys read as removed', () => {
  const refused = withDocuments(BASE, { 'claude/settings.keys.json': '{ broken' });
  assert.deepEqual(diffItems(itemValues(BASE), itemValues(refused)).map((c) => [c.itemId, c.after]), [
    ['setting:claude:settings.json#effortLevel', undefined],
    ['setting:claude:settings.json#theme', undefined],
  ]);
});

const ids: ReadonlyArray<readonly [string, unknown]> = [
  ['setting:claude:settings.json#effortLevel', { kind: 'setting', fileId: 'claude:settings.json', key: 'effortLevel' }],
  ['file:claude:CLAUDE.md', { kind: 'file', fileId: 'claude:CLAUDE.md' }],
  ['skill:mattpocock/skills/tdd', { kind: 'skill', source: 'mattpocock/skills', name: 'tdd' }],
  ['integration:hk', { kind: 'integration', id: 'hk' }],
  ['setting:claude:settings.json', undefined],
  ['skill:tdd', undefined],
  ['file:', undefined],
  ['undeclared:claude:hooks:x', undefined],
];

for (const [id, ref] of ids) {
  test(`parseItemId reads ${id}`, () => {
    assert.deepEqual(parseItemId(id), ref);
  });
}
