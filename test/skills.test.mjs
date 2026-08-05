import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, emitManifest, groupsFromLock, reconcile, installArgs } from '../src/skills.mjs';

const SAMPLE = `# a comment
[Nortus222/agent-skills]
explain

[mattpocock/skills]
teach
grill-me
`;

test('parseManifest groups skills under their source', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(g, [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['teach', 'grill-me'] },
  ]);
});

test('parseManifest ignores comments and blank lines', () => {
  assert.deepEqual(parseManifest('\n# nothing\n\n'), []);
});

test('parseManifest drops names that precede any source header', () => {
  assert.deepEqual(parseManifest('orphan\n[a/b]\nreal\n'), [{ source: 'a/b', skills: ['real'] }]);
});

test('emit then parse round-trips', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(parseManifest(emitManifest(g)), g);
});

test('groupsFromLock derives sources and sorts deterministically', () => {
  const lock = {
    skills: {
      teach: { source: 'mattpocock/skills' },
      explain: { source: 'Nortus222/agent-skills' },
      'grill-me': { source: 'mattpocock/skills' },
      scratch: {},
    },
  };
  assert.deepEqual(groupsFromLock(lock), [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['grill-me', 'teach'] },
  ]);
});

test('reconcile splits into ok, missing, extra, and local', () => {
  const groups = [{ source: 'a/b', skills: ['have', 'want'] }];
  const lock = { skills: { have: { source: 'a/b' }, spare: { source: 'c/d' }, mine: {} } };
  const r = reconcile({ groups, lock, installedNames: ['have', 'spare', 'mine'] });

  assert.deepEqual(r.ok, ['have']);
  assert.deepEqual(r.missing, [{ name: 'want', source: 'a/b' }]);
  assert.deepEqual(r.extra, ['spare']);
  assert.deepEqual(r.local, ['mine']);
});

test('a manifest skill installed from a different source still counts as present', () => {
  const groups = [{ source: 'a/b', skills: ['thing'] }];
  const lock = { skills: { thing: { source: 'z/z' } } };
  const r = reconcile({ groups, lock, installedNames: ['thing'] });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.ok, ['thing']);
});

test('installArgs groups missing skills into one call per source', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'a/b' },
    { name: 'three', source: 'c/d' },
  ];
  assert.deepEqual(installArgs(missing), [
    { source: 'a/b', skills: ['one', 'two'] },
    { source: 'c/d', skills: ['three'] },
  ]);
});
