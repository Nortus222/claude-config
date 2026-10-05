import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WatchedSource } from '../src/model.ts';
import { watchUpstream } from '../src/upstream.ts';
import { gitSync, makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 adds tdd and grill; the next commit changes tdd; v2 touches only the README.
function history(root: string) {
  const repo = makeRepo(root);
  const c1 = repo.commit('add skills', { 'skills/tdd/SKILL.md': 'tdd v1\n', 'skills/grill/SKILL.md': 'grill v1\n' });
  repo.tag('v1');
  const c2 = repo.commit('tune tdd', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const c3 = repo.commit('readme', { 'README.md': 'hi\n' });
  repo.tag('v2');
  return { repo, c1, c2, c3 };
}

const watched = (url: string, extra: Partial<WatchedSource> = {}): WatchedSource => ({
  source: 'ada/skills', url, exact: false, skills: ['tdd', 'grill', 'ghost'], ...extra,
});
const watch = (root: string, source: WatchedSource) =>
  runGit(watchUpstream(source, { cacheDir: join(root, 'cache') }));

test('an unpinned source reports its latest revision and where the declared skills are', async (t) => {
  const root = tempDir(t);
  const { repo, c3 } = history(root);
  const report = await watch(root, watched(repo.url));
  assert.equal(report.status, 'unpinned');
  assert.equal(report.url, repo.url);
  assert.equal(report.latest?.sha, c3);
  assert.deepEqual(report.latest?.tags, ['v2']);
  assert.match(report.latest!.date, /^2026-01-01T/);
  assert.equal(report.baseline, undefined);
  assert.deepEqual(report.commits, []);
  assert.deepEqual(report.skills.map((s) => [s.name, s.status, s.path]), [
    ['tdd', 'unchanged', 'skills/tdd'],
    ['grill', 'unchanged', 'skills/grill'],
    ['ghost', 'missing', undefined],
  ]);
});

test('a baseline at latest is up to date', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: 'v2' }));
  assert.equal(report.status, 'up-to-date');
  assert.deepEqual(report.commits, []);
  assert.deepEqual(report.skills.map((s) => s.status), ['unchanged', 'unchanged', 'missing']);
});

test('a tag baseline behind latest is ahead, with the commits between them', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2, c3 } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: 'v1' }));
  assert.equal(report.status, 'ahead');
  assert.equal(report.baseline?.ref, 'v1');
  assert.equal(report.baseline?.sha, c1);
  assert.deepEqual(report.baseline?.tags, ['v1']);
  assert.deepEqual(report.commits.map((c) => [c.sha, c.subject, c.author]), [
    [c3, 'readme', 'Ada'],
    [c2, 'tune tdd', 'Ada'],
  ]);
  assert.deepEqual(report.skills.map((s) => s.status), ['changed', 'unchanged', 'missing']);
  assert.doesNotMatch(JSON.stringify(report), /example\.com/);
});

test('a sha baseline resolves like a tag', async (t) => {
  const root = tempDir(t);
  const { repo, c1 } = history(root);
  const report = await watch(root, watched(repo.url, { baseline: c1 }));
  assert.equal(report.status, 'ahead');
  assert.equal(report.commits.length, 2);
});

test('a full sha on no branch is fetched by id', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  gitSync(repo.dir, 'checkout', '--quiet', '-b', 'side');
  const side = repo.commit('side work', { 'side.txt': 'x\n' });
  gitSync(repo.dir, 'update-ref', 'refs/pull/1/head', side);
  gitSync(repo.dir, 'checkout', '--quiet', 'main');
  gitSync(repo.dir, 'branch', '--quiet', '-D', 'side');
  const report = await watch(root, watched(repo.url, { baseline: side }));
  assert.equal(report.status, 'diverged');
  assert.equal(report.baseline?.sha, side);
});

test('an unknown baseline, or one shaped like an option, is baseline-missing', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  for (const baseline of ['nope', '--output=/tmp/x']) {
    const report = await watch(root, watched(repo.url, { baseline }));
    assert.equal(report.status, 'baseline-missing', baseline);
    assert.match(report.reason!, /baseline/);
    assert.deepEqual(report.skills, []);
  }
});

test('a rewritten history reads as diverged', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2 } = history(root);
  assert.equal((await watch(root, watched(repo.url, { baseline: c2 }))).status, 'ahead');
  gitSync(repo.dir, 'reset', '--quiet', '--hard', c1);
  const redo = repo.commit('redo', { 'skills/tdd/SKILL.md': 'tdd redo\n' });
  const report = await watch(root, watched(repo.url, { baseline: c2 }));
  assert.equal(report.status, 'diverged');
  assert.deepEqual(report.commits.map((c) => c.sha), [redo]);
});

test('a second run fetches into the existing cache', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  await watch(root, watched(repo.url));
  const next = repo.commit('next', { 'skills/grill/SKILL.md': 'grill v2\n' });
  const report = await watch(root, watched(repo.url, { baseline: 'v2' }));
  assert.equal(report.latest?.sha, next);
  assert.deepEqual(report.commits.map((c) => c.subject), ['next']);
});

test('an unreachable or empty upstream is reported, not thrown', async (t) => {
  const root = tempDir(t);
  const missing = await watch(root, watched(pathToFileURL(join(root, 'missing')).href, { baseline: 'v1' }));
  assert.equal(missing.status, 'unreachable');
  assert.match(missing.reason!, /does not appear to be a git repository/);
  assert.deepEqual([missing.commits, missing.skills, missing.added], [[], [], []]);

  const empty = makeRepo(root, 'empty');
  const report = await watch(root, watched(empty.url));
  assert.equal(report.status, 'unreachable');
  assert.ok(report.reason);
});
