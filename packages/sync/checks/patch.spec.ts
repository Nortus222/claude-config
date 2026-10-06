import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desiredOfDocuments, diffItems, itemValues, parseItemId, patchItem, writeDocuments } from '../src/index.ts';
import { BASE, json, load, runSync, withDocuments } from './support/repo.ts';

// Every kind changed from BASE: two settings values and a new key, the instruction file, a removed,
// an added and a re-pinned skill, a group made required and pinned, a removed hook (and its file),
// a changed and an added integration.
const HEAD = withDocuments(BASE, {
  'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium', model: 'opus' }),
  'claude/CLAUDE.md': '# new rules\n',
  'skills-manifest.txt': '[mattpocock/skills]\ntdd\ngrill\n\n[anthropics/skills]\npdf\n',
  'skill-pins.json': json({ version: 1, pins: { 'mattpocock/skills': 'b'.repeat(40), 'anthropics/skills': 'c'.repeat(40) } }),
  'integrations.json': json({
    version: 1,
    integrations: [
      { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin: 'superpowers@other' },
      { id: 'nx', label: 'next', target: 'claude', type: 'plugin', default: true, plugin: 'next@official' },
    ],
  }),
  'claude/hooks/hk.mjs': null,
});

const CHANGES = diffItems(itemValues(BASE), itemValues(HEAD));

test('the fixture changes every kind of item', () => {
  assert.deepEqual(new Set(CHANGES.map((c) => c.kind)), new Set(['setting', 'file', 'skill', 'integration']));
});

for (const change of CHANGES) {
  test(`holding ${change.itemId} restores its value and leaves the rest at head`, () => {
    const patched = itemValues(patchItem(HEAD, change.itemId, BASE));
    const head = itemValues(HEAD);
    assert.equal(patched.get(change.itemId), change.before);
    const ref = parseItemId(change.itemId)!;
    for (const [id, value] of head) {
      if (id === change.itemId) continue;
      // Ruling 3: a pin belongs to a source, so a held skill moves its siblings' pin with it.
      if (ref.kind === 'skill' && id.startsWith(`skill:${ref.source}/`)) continue;
      assert.equal(patched.get(id), value, id);
    }
    for (const id of patched.keys()) assert.ok(id === change.itemId || head.has(id), `no other item appears: ${id}`);
  });
}

test('holding everything gives back the held setup, and it resolves through loadProfile', async () => {
  let documents = HEAD;
  for (const change of CHANGES) documents = patchItem(documents, change.itemId, BASE);
  assert.deepEqual(itemValues(documents), itemValues(BASE));
  const dir = mkdtempSync(join(tmpdir(), 'sync-patch-'));
  await runSync(writeDocuments(dir, documents));
  const loaded = await load(dir);
  assert.deepEqual(loaded, desiredOfDocuments(documents));
  assert.deepEqual(loaded.issues, []);
});

test('a held skill lands under the head group with the same source and markers', () => {
  const head = withDocuments(BASE, { 'skills-manifest.txt': '[mattpocock/skills]\ntdd\n\n[anthropics/skills] optional\npdf\n' });
  const patched = patchItem(head, 'skill:mattpocock/skills/diagnose', BASE);
  assert.equal(patched['skills-manifest.txt'], '[mattpocock/skills]\ntdd\ndiagnose\n\n[anthropics/skills] optional\npdf\n');
});

test('a held hook brings back the file it ships when head dropped it', () => {
  const patched = patchItem(HEAD, 'integration:hk', BASE);
  assert.equal(patched['claude/hooks/hk.mjs'], BASE['claude/hooks/hk.mjs']);
});

test('removing the last owned key removes the settings document', () => {
  const head = withDocuments(BASE, { 'claude/settings.keys.json': json({ model: 'opus' }) });
  const patched = patchItem(head, 'setting:claude:settings.json#model', BASE);
  assert.equal(Object.hasOwn(patched, 'claude/settings.keys.json'), false);
});

test('a hold cannot repair an unparseable head document, so it is left as it is', () => {
  const head = withDocuments(BASE, { 'claude/settings.keys.json': '{ broken', 'integrations.json': '{ broken' });
  assert.deepEqual(patchItem(head, 'setting:claude:settings.json#theme', BASE), head);
  assert.deepEqual(patchItem(head, 'integration:hk', BASE), head);
});

test('an id that is not an item changes nothing', () => {
  assert.equal(patchItem(HEAD, 'undeclared:claude:hooks:x', BASE), HEAD);
});

test('a held hook never brings back a file outside the repository (ruling 30)', () => {
  const hook = { id: 'out', label: 'out', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: '../out.mjs' };
  const held = withDocuments(BASE, {
    'integrations.json': json({ version: 1, integrations: [hook] }),
    '../out.mjs': 'console.log("out");\n',
  });
  assert.equal(Object.hasOwn(patchItem(BASE, 'integration:out', held), '../out.mjs'), false);
});
