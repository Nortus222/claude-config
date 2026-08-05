import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillFolder, updatableSkills, sourcesOf, planUpdates } from '../src/skill-updates.mjs';

const lockOf = (skills) => ({ skills });

const ENTRY = {
  source: 'mattpocock/skills',
  sourceType: 'github',
  sourceUrl: 'https://github.com/mattpocock/skills.git',
  skillPath: 'skills/engineering/tdd/SKILL.md',
  skillFolderHash: 'aaa',
};

test('skillFolder strips the SKILL.md filename', () => {
  assert.equal(skillFolder('skills/engineering/tdd/SKILL.md'), 'skills/engineering/tdd');
});

test('skillFolder maps a root SKILL.md to the root tree', () => {
  assert.equal(skillFolder('SKILL.md'), '.');
});

test('updatableSkills keeps only skills that are installed', () => {
  const entries = updatableSkills(lockOf({ tdd: ENTRY, absent: ENTRY }), ['tdd']);
  assert.deepEqual(entries.map((e) => e.name), ['tdd']);
  assert.equal(entries[0].path, 'skills/engineering/tdd');
  assert.equal(entries[0].hash, 'aaa');
});

test('updatableSkills skips entries with no recorded source', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  assert.deepEqual(updatableSkills(lock, ['mine']), []);
});

test('updatableSkills survives a malformed lock without throwing', () => {
  assert.deepEqual(updatableSkills(null, ['x']), []);
  assert.deepEqual(updatableSkills({ skills: 'nope' }, ['x']), []);
  assert.deepEqual(updatableSkills(lockOf({ x: 5 }), ['x']), []);
});

test('sourcesOf dedupes by sourceUrl and collects every path', () => {
  const entries = [
    { name: 'a', source: 's/one', sourceUrl: 'u1', path: 'p/a', hash: 'x' },
    { name: 'b', source: 's/one', sourceUrl: 'u1', path: 'p/b', hash: 'y' },
    { name: 'c', source: 's/two', sourceUrl: 'u2', path: 'p/c', hash: 'z' },
  ];
  assert.deepEqual(sourcesOf(entries), [
    { source: 's/one', sourceUrl: 'u1', paths: ['p/a', 'p/b'] },
    { source: 's/two', sourceUrl: 'u2', paths: ['p/c'] },
  ]);
});

test('planUpdates calls a matching tree SHA current', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'aaa']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['tdd']);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates reports a differing tree SHA as outdated, with both SHAs', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [
    { name: 'tdd', source: 'mattpocock/skills', from: 'aaa', to: 'bbb' },
  ]);
});

test('planUpdates treats a path missing upstream as gone, never as outdated', () => {
  const remote = new Map([['u', new Map([['p/tdd', null]])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.gone, [{ name: 'tdd', source: 'mattpocock/skills', path: 'p/tdd' }]);
  assert.deepEqual(plan.outdated, []);
});

test('planUpdates marks every skill of an unreachable source unknown', () => {
  const lock = lockOf({
    tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
    review: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/review/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['tdd', 'review'], remoteTrees: new Map() });
  assert.deepEqual(plan.unknown.map((u) => u.name), ['review', 'tdd']);
  assert.deepEqual(plan.current, []);
});

test('planUpdates isolates an unreachable source from a reachable one', () => {
  const remote = new Map([['ok', new Map([['p/a', 'same']])]]);
  const lock = lockOf({
    a: { ...ENTRY, sourceUrl: 'ok', skillPath: 'p/a/SKILL.md', skillFolderHash: 'same' },
    b: { ...ENTRY, sourceUrl: 'down', skillPath: 'p/b/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['a', 'b'], remoteTrees: remote });
  assert.deepEqual(plan.current, ['a']);
  assert.deepEqual(plan.unknown.map((u) => u.name), ['b']);
});

test('planUpdates lists an installed skill with no source as local', () => {
  const lock = lockOf({ mine: { skillPath: 'SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: ['mine'], remoteTrees: new Map() });
  assert.deepEqual(plan.local, ['mine']);
  assert.deepEqual(plan.unknown, []);
});

test('planUpdates treats a sourced entry with no recorded hash as outdated from null', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({
    tdd: { source: 's/one', sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' },
  });
  const plan = planUpdates({ lock, installedNames: ['tdd'], remoteTrees: remote });
  assert.deepEqual(plan.outdated, [{ name: 'tdd', source: 's/one', from: null, to: 'bbb' }]);
});

test('planUpdates ignores lock entries for skills that are not installed', () => {
  const remote = new Map([['u', new Map([['p/tdd', 'bbb']])]]);
  const lock = lockOf({ tdd: { ...ENTRY, sourceUrl: 'u', skillPath: 'p/tdd/SKILL.md' } });
  const plan = planUpdates({ lock, installedNames: [], remoteTrees: remote });
  assert.deepEqual(plan, { current: [], outdated: [], gone: [], unknown: [], local: [] });
});
