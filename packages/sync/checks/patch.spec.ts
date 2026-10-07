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

// A skill's value without its source's pin.
const withoutPin = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const { pin: _pin, ...rest } = JSON.parse(value) as Record<string, unknown>;
  return rest;
};

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
      if (ref.kind === 'skill' && id.startsWith(`skill:${ref.source}/`)) {
        assert.deepEqual(withoutPin(patched.get(id)), withoutPin(value), id);
        continue;
      }
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
  // readDocuments never reads '../out.mjs', so the held commit's document is refused and declares nothing.
  const hook = { id: 'out', label: 'out', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: '../out.mjs' };
  const held = withDocuments(BASE, { 'integrations.json': json({ version: 1, integrations: [hook] }) });
  const patched = patchItem(BASE, 'integration:out', held);
  assert.equal(Object.hasOwn(patched, '../out.mjs'), false);
  const values = itemValues(patched);
  const base = itemValues(BASE);
  assert.equal(values.get('integration:hk'), base.get('integration:hk'));
  assert.equal(values.get('integration:sp'), base.get('integration:sp'));
});

test('an integration held at a commit whose integrations.json was refused is removed, and the rest keep their values', () => {
  const held = withDocuments(BASE, {
    'integrations.json': json({
      version: 1,
      integrations: [
        { id: 'sp', label: 'superpowers', target: 'claude', type: 'plugin', default: true, plugin: 'superpowers@other' },
        { id: 'bad', target: 'claude', type: 'plugin', default: true, plugin: 'bad@official' },
      ],
    }),
  });
  assert.notDeepEqual(desiredOfDocuments(held).issues, []);
  const patched = patchItem(BASE, 'integration:sp', held);
  const values = itemValues(patched);
  assert.equal(values.has('integration:sp'), false);
  assert.equal(values.get('integration:hk'), itemValues(BASE).get('integration:hk'));
  assert.deepEqual(desiredOfDocuments(patched).issues, []);
});

test('a setting held at a commit whose settings document was refused is deleted', () => {
  const held = withDocuments(BASE, { 'claude/settings.keys.json': json({ theme: 'dark', effortLevel: 'high', apiKey: 'sk-ant-api03-' + 'x'.repeat(40) }) });
  assert.notDeepEqual(desiredOfDocuments(held).issues, []);
  const patched = patchItem(BASE, 'setting:claude:settings.json#theme', held);
  const values = itemValues(patched);
  assert.equal(values.has('setting:claude:settings.json#theme'), false);
  assert.equal(values.get('setting:claude:settings.json#effortLevel'), itemValues(BASE).get('setting:claude:settings.json#effortLevel'));
});
