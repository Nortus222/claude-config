import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemId, ItemIdSchema } from '../src/items.ts';
import { decodeHosted } from '../src/decode.ts';

test('item parsing preserves the existing local structure and permissiveness', () => {
  assert.deepEqual(parseItemId('setting:claude:settings.json#effortLevel'), { kind: 'setting', fileId: 'claude:settings.json', key: 'effortLevel' });
  assert.deepEqual(parseItemId('setting:a#b#c'), { kind: 'setting', fileId: 'a', key: 'b#c' });
  assert.deepEqual(parseItemId('skill:Nortus222/agent-skills/explain'), { kind: 'skill', source: 'Nortus222/agent-skills', name: 'explain' });
  assert.deepEqual(parseItemId('file:local path'), { kind: 'file', fileId: 'local path' });
  assert.deepEqual(parseItemId('integration:x'), { kind: 'integration', id: 'x' });
  for (const id of ['setting:#x', 'setting:x#', 'setting:x', 'skill:x', 'skill:/x', 'skill:x/', 'file:', 'integration:', 'unknown:x']) assert.equal(parseItemId(id), undefined);
});

test('wire item IDs check allowed syntax as well as logical structure', () => {
  for (const id of ['setting:claude:settings.json#effortLevel', 'skill:Nortus222/agent-skills/explain', 'integration:superpowers-codex', 'file:claude:CLAUDE.md', `file:${'a'.repeat(200)}`]) assert.equal(decodeHosted(ItemIdSchema, id), id);
  for (const id of ['setting:x', 'setting:#x', 'setting:x#', 'skill:x', 'skill:/x', 'file:local path', 'file:😀', `file:${'a'.repeat(201)}`, 'file:', 'unknown:x']) assert.throws(() => decodeHosted(ItemIdSchema, id));
});
