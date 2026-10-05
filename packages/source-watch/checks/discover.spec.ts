import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFolders } from '../src/discover.ts';

test('a skill is the shallowest folder holding SKILL.md, named by its basename', () => {
  const folders = skillFolders([
    'README.md',
    'SKILL.md',
    'skills/tdd/SKILL.md',
    'skills/tdd/refs/SKILL.md',
    'skills/tdd/notes.md',
    'skills/tdd-extra/SKILL.md',
    'eng/grill/SKILL.md',
  ]);
  assert.deepEqual([...folders], [
    ['grill', 'eng/grill'],
    ['tdd', 'skills/tdd'],
    ['tdd-extra', 'skills/tdd-extra'],
  ]);
});

test('when two folders share a name, the first in path order wins', () => {
  assert.deepEqual([...skillFolders(['b/x/SKILL.md', 'a/x/SKILL.md'])], [['x', 'a/x']]);
});

test('no SKILL.md means no skills', () => {
  assert.deepEqual([...skillFolders(['README.md', 'skills/tdd/notes.md'])], []);
});
