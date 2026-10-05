import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatus, watchCheckout } from '../src/local.ts';
import { commitFiles, gitSync, makeRepo, runGit, tempDir, writeFiles } from './fixtures.ts';

function setup(root: string) {
  const upstream = makeRepo(root);
  upstream.commit('add skills', { 'skills/tdd/SKILL.md': 'tdd v1\n', 'skills/grill/SKILL.md': 'grill v1\n' });
  const local = join(root, 'local');
  gitSync(root, 'clone', '--quiet', upstream.url, local);
  return { upstream, local };
}

test('reports unpushed commits and every kind of uncommitted edit, by skill', async (t) => {
  const root = tempDir(t);
  const { upstream, local } = setup(root);
  commitFiles(local, 'tune tdd locally', { 'skills/tdd/SKILL.md': 'tdd local\n' });
  // Upstream moves on and the checkout fetches it; that must not read as a local edit.
  upstream.commit('upstream adds other', { 'skills/other/SKILL.md': 'other\n' });
  gitSync(local, 'fetch', '--quiet');
  writeFiles(local, {
    'skills/grill/SKILL.md': 'grill local\n',
    'skills/grill/extra.md': 'extra\n',
    'skills/brand-new/SKILL.md': 'brand new\n',
  });
  gitSync(local, 'add', 'skills/grill/extra.md');

  const report = await runGit(watchCheckout(local));
  assert.equal(report.path, local);
  assert.equal(report.status, 'edits');
  assert.equal(report.branch, 'main');
  assert.deepEqual(report.unpushed.map((c) => c.subject), ['tune tdd locally']);
  assert.deepEqual(report.uncommitted, ['skills/brand-new/SKILL.md', 'skills/grill/SKILL.md', 'skills/grill/extra.md']);
  assert.deepEqual(report.skills.map((s) => [s.name, s.path]), [
    ['brand-new', 'skills/brand-new'],
    ['grill', 'skills/grill'],
    ['tdd', 'skills/tdd'],
  ]);
  const md = Object.fromEntries(report.skills.map((s) => [s.name, s.skillMd ?? '']));
  assert.match(md['brand-new']!, /^\+brand new$/m);
  assert.match(md.grill!, /^-grill v1$/m);
  assert.match(md.grill!, /^\+grill local$/m);
  assert.match(md.tdd!, /^\+tdd local$/m);
});

test('a checkout with nothing to push is clean', async (t) => {
  const { local } = setup(tempDir(t));
  assert.deepEqual(await runGit(watchCheckout(local)), {
    path: local, status: 'clean', branch: 'main', unpushed: [], uncommitted: [], skills: [],
  });
});

test('a subfolder of the work tree reports the whole repository', async (t) => {
  const { local } = setup(tempDir(t));
  writeFiles(local, { 'skills/grill/SKILL.md': 'grill local\n' });
  const report = await runGit(watchCheckout(join(local, 'skills')));
  assert.equal(report.status, 'edits');
  assert.deepEqual(report.skills.map((s) => s.name), ['grill']);
  assert.deepEqual(report.uncommitted, ['skills/grill/SKILL.md']);
});

test('a checkout with no upstream measures edits from HEAD', async (t) => {
  const solo = makeRepo(tempDir(t), 'solo');
  solo.commit('add', { 'skills/grill/SKILL.md': 'grill v1\n' });
  writeFiles(solo.dir, { 'skills/grill/SKILL.md': 'grill local\n' });
  const report = await runGit(watchCheckout(solo.dir));
  assert.equal(report.status, 'no-upstream');
  assert.deepEqual(report.unpushed, []);
  assert.match(report.skills[0]!.skillMd!, /^\+grill local$/m);
});

test('a folder that is not a work tree, or is missing, is not-a-repo', async (t) => {
  const root = tempDir(t);
  const plain = join(root, 'plain');
  mkdirSync(plain);
  for (const path of [plain, join(root, 'missing')]) {
    assert.deepEqual(await runGit(watchCheckout(path)), {
      path, status: 'not-a-repo', unpushed: [], uncommitted: [], skills: [],
    });
  }
});

test('parseStatus reads -z porcelain, skipping a rename\'s original path', () => {
  assert.deepEqual(parseStatus(' M a.txt\0R  new.txt\0old.txt\0?? n/SKILL.md\0'), [
    { path: 'a.txt', untracked: false },
    { path: 'new.txt', untracked: false },
    { path: 'n/SKILL.md', untracked: true },
  ]);
});

test('an upstream with unrelated history still reports the checkout', async (t) => {
  const root = tempDir(t);
  const { local } = setup(root);
  gitSync(local, 'checkout', '--quiet', '--orphan', 'other');
  commitFiles(local, 'unrelated', { 'skills/tdd/SKILL.md': 'tdd other\n' });
  gitSync(local, 'branch', '--quiet', '-u', 'origin/main');
  const report = await runGit(watchCheckout(local));
  assert.notEqual(report.status, 'not-a-repo');
  assert.equal(report.branch, 'other');
});
