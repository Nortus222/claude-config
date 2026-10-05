import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Effect } from 'effect';
import { pinImpact } from '../src/impact.ts';
import type { WatchedSource } from '../src/model.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

// v1 has tdd, grill and plan; c2 changes tdd; v2 removes grill and adds fresh; c4 is a README.
function history(root: string) {
  const repo = makeRepo(root);
  const c1 = repo.commit('add skills', {
    'skills/tdd/SKILL.md': 'tdd v1\n',
    'skills/grill/SKILL.md': 'grill v1\n',
    'skills/plan/SKILL.md': 'plan v1\n',
  });
  repo.tag('v1');
  const c2 = repo.commit('tune tdd', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const c3 = repo.commit('swap skills', { 'skills/grill': null, 'skills/fresh/SKILL.md': 'fresh\n' });
  repo.tag('v2');
  const c4 = repo.commit('readme', { 'README.md': 'hi\n' });
  return { repo, c1, c2, c3, c4 };
}

const watched = (url: string, baseline?: string): WatchedSource => ({
  source: 'ada/skills',
  url,
  exact: false,
  skills: ['tdd', 'grill', 'plan', 'fresh', 'ghost'],
  ...(baseline === undefined ? {} : { baseline }),
});
const impact = (root: string, source: WatchedSource, ref: string) =>
  runGit(pinImpact(source, ref, { cacheDir: join(root, 'cache') }));
const statuses = (result: { skills: ReadonlyArray<{ name: string; status: string }> }) =>
  result.skills.map((s) => [s.name, s.status]);

test('moving a pin to an intermediate commit moves only the skills changed by then', async (t) => {
  const root = tempDir(t);
  const { repo, c1, c2 } = history(root);
  const result = await impact(root, watched(repo.url, 'v1'), c2);
  assert.equal(result.source, 'ada/skills');
  assert.deepEqual(result.from, { ref: 'v1', sha: c1 });
  assert.deepEqual(result.to, { ref: c2, sha: c2 });
  assert.deepEqual(statuses(result), [
    ['tdd', 'changed'], ['grill', 'unchanged'], ['plan', 'unchanged'], ['fresh', 'missing'], ['ghost', 'missing'],
  ]);
});

test('moving a pin to a tag reports removed and newly present skills', async (t) => {
  const root = tempDir(t);
  const { repo, c3 } = history(root);
  const result = await impact(root, watched(repo.url, 'v1'), 'v2');
  assert.deepEqual(result.to, { ref: 'v2', sha: c3 });
  assert.deepEqual(statuses(result), [
    ['tdd', 'changed'], ['grill', 'removed'], ['plan', 'unchanged'], ['fresh', 'changed'], ['ghost', 'missing'],
  ]);
});

test('an unpinned source compares against HEAD and has no from', async (t) => {
  const root = tempDir(t);
  const { repo, c2 } = history(root);
  const result = await impact(root, watched(repo.url), c2);
  assert.equal(result.from, undefined);
  assert.deepEqual(statuses(result), [
    ['tdd', 'unchanged'], ['grill', 'changed'], ['plan', 'unchanged'], ['fresh', 'removed'], ['ghost', 'missing'],
  ]);
});

test('a full sha pushed after the cache was made is fetched by id', async (t) => {
  const root = tempDir(t);
  const { repo, c4 } = history(root);
  await impact(root, watched(repo.url, 'v1'), c4);
  const c5 = repo.commit('tune plan', { 'skills/plan/SKILL.md': 'plan v2\n' });
  const result = await impact(root, watched(repo.url, 'v1'), c5);
  assert.equal(result.to.sha, c5);
  assert.deepEqual(statuses(result).find(([name]) => name === 'plan'), ['plan', 'changed']);
});

test('a target or baseline that does not resolve is RefMissing', async (t) => {
  const root = tempDir(t);
  const { repo } = history(root);
  for (const [baseline, ref, named] of [
    ['v1', 'nope', 'nope'],
    ['v1', '--upload-pack=x', '--upload-pack=x'],
    ['gone', 'v2', 'gone'],
  ] as const) {
    const error = await runGit(Effect.flip(pinImpact(watched(repo.url, baseline), ref, { cacheDir: join(root, 'cache') })));
    assert.equal(error._tag, 'RefMissing');
    assert.ok(error.reason.includes(`'${named}'`), error.reason);
  }
});

test('a source that cannot be cloned fails with a redacted GitFailed', async (t) => {
  const root = tempDir(t);
  const source = watched(`file://${root}/nope?token=s3cret`, 'v1');
  const error = await runGit(Effect.flip(pinImpact(source, 'v2', { cacheDir: join(root, 'cache') })));
  assert.equal(error._tag, 'GitFailed');
  assert.ok(!error.reason.includes('s3cret'), error.reason);
});
