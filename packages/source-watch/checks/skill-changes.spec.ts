import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { SkillChange, WatchedSource } from '../src/model.ts';
import { watchUpstream } from '../src/upstream.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 has six skills. `tune` edits tdd (and a sibling file) and café; `reshape` removes old,
// moves mover, and adds fresh and wanted; a README commit follows.
function history(root: string) {
  const repo = makeRepo(root);
  repo.commit('add skills', {
    'skills/tdd/SKILL.md': 'tdd v1\n',
    'skills/tdd/notes.md': 'n1\n',
    'skills/grill/SKILL.md': 'grill v1\n',
    'skills/old/SKILL.md': 'old\n',
    'skills/mover/SKILL.md': 'move v1\n',
    'skills/café/SKILL.md': 'café v1\n',
  });
  repo.tag('v1');
  const tune = repo.commit('tune', {
    'skills/tdd/SKILL.md': 'tdd v2\n',
    'skills/tdd/notes.md': 'n2\n',
    'skills/café/SKILL.md': 'café v2\n',
  });
  const reshape = repo.commit('reshape', {
    'skills/old': null,
    'skills/mover': null,
    'eng/mover/SKILL.md': 'move v2\n',
    'skills/fresh/SKILL.md': 'fresh\n',
    'skills/wanted/SKILL.md': 'wanted\n',
  });
  repo.commit('readme', { 'README.md': 'hi\n' });
  return { repo, tune, reshape };
}

const watched = (url: string, exact: boolean): WatchedSource => ({
  source: 'ada/skills', url, baseline: 'v1', exact,
  skills: ['tdd', 'grill', 'old', 'mover', 'wanted', 'café', 'ghost'],
});

test('reports each declared skill with its commits, files and SKILL.md diff', async (t) => {
  const root = tempDir(t);
  const { repo, tune, reshape } = history(root);
  const report = await runGit(watchUpstream(watched(repo.url, false), { cacheDir: join(root, 'cache') }));
  const skill = Object.fromEntries(report.skills.map((s) => [s.name, s])) as Record<string, SkillChange>;
  const md = (name: string) => skill[name]!.skillMd ?? '';

  assert.deepEqual(report.skills.map((s) => s.name), ['tdd', 'grill', 'old', 'mover', 'wanted', 'café', 'ghost']);

  assert.deepEqual({ ...skill.tdd, skillMd: undefined }, {
    name: 'tdd', path: 'skills/tdd', status: 'changed', commits: [tune], files: ['skills/tdd/notes.md'], skillMd: undefined,
  });
  assert.match(md('tdd'), /^-tdd v1$/m);
  assert.match(md('tdd'), /^\+tdd v2$/m);

  assert.deepEqual(skill.grill, { name: 'grill', path: 'skills/grill', status: 'unchanged', commits: [], files: [] });
  assert.deepEqual(skill.old, { name: 'old', path: 'skills/old', status: 'removed', commits: [], files: [] });
  assert.deepEqual(skill.ghost, { name: 'ghost', status: 'missing', commits: [], files: [] });

  assert.equal(skill.mover!.status, 'changed');
  assert.equal(skill.mover!.path, 'eng/mover');
  assert.deepEqual(skill.mover!.commits, [reshape]);
  assert.deepEqual(skill.mover!.files, []);
  assert.match(md('mover'), /a\/skills\/mover\/SKILL\.md/);
  assert.match(md('mover'), /b\/eng\/mover\/SKILL\.md/);
  assert.match(md('mover'), /^\+move v2$/m);

  assert.equal(skill.wanted!.status, 'changed');
  assert.deepEqual(skill.wanted!.commits, [reshape]);
  assert.match(md('wanted'), /new file mode/);
  assert.match(md('wanted'), /^\+wanted$/m);

  assert.equal(skill['café']!.path, 'skills/café');
  assert.deepEqual(skill['café']!.commits, [tune]);
  assert.match(md('café'), /^\+café v2$/m);

  assert.deepEqual(report.added, ['fresh']);
});

test('an exact source does not report skills added upstream', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  const report = await runGit(watchUpstream(watched(repo.url, true), { cacheDir: join(root, 'cache') }));
  assert.deepEqual(report.added, []);
  assert.equal(report.skills.find((s) => s.name === 'tdd')!.status, 'changed');
});
