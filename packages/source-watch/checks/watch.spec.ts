import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { WatchedSource } from '../src/model.ts';
import { sourcesFrom } from '../src/sources.ts';
import { watchSources } from '../src/watch.ts';
import { gitSync, makeRepo, runGit, tempDir, writeFiles } from './fixtures.ts';

test('watches every source in input order, confining failures and attaching checkouts', async (t) => {
  const root = tempDir(t);
  const upstream = makeRepo(root);
  upstream.commit('add', { 'skills/tdd/SKILL.md': 'tdd v1\n' });
  upstream.tag('v1');
  upstream.commit('tune', { 'skills/tdd/SKILL.md': 'tdd v2\n' });
  const local = join(root, 'local');
  gitSync(root, 'clone', '--quiet', upstream.url, local);
  writeFiles(local, { 'skills/tdd/SKILL.md': 'tdd local\n' });

  const sources: WatchedSource[] = [
    { source: 'ada/private', url: 'https://ada:s3cret@example.invalid/private.git', exact: false, skills: ['x'] },
    { source: 'ada/skills', url: upstream.url, baseline: 'v1', exact: false, skills: ['tdd'], checkout: local },
  ];
  const reports = await runGit(watchSources(sources, { cacheDir: join(root, 'cache') }));

  assert.deepEqual(reports.map((r) => [r.source, r.status]), [
    ['ada/private', 'unreachable'],
    ['ada/skills', 'ahead'],
  ]);
  assert.equal(reports[0]!.url, 'https://example.invalid/private.git');
  assert.match(reports[0]!.reason!, /transport 'https' not allowed/);
  assert.equal(reports[0]!.local, undefined);
  assert.equal(reports[1]!.skills[0]!.status, 'changed');
  assert.equal(reports[1]!.local?.status, 'edits');
  assert.deepEqual(reports[1]!.local?.skills.map((s) => s.name), ['tdd']);

  const json = JSON.stringify(reports);
  assert.doesNotMatch(json, /s3cret/);
  assert.doesNotMatch(json, /ada@example\.com/);
});

test('sources derived from a setup default to GitHub, which tests refuse rather than fetch', async (t) => {
  const root = tempDir(t);
  const from = { layer: 'base', source: 'skills-manifest.txt' } as const;
  const sources = sourcesFrom({
    skills: [{ name: 'tdd', source: 'mattpocock/skills', exact: false, optional: false, install: true, from }],
  });
  const [report] = await runGit(watchSources(sources, { cacheDir: join(root, 'cache') }));
  assert.equal(report!.url, 'https://github.com/mattpocock/skills.git');
  assert.equal(report!.status, 'unreachable');
  assert.match(report!.reason!, /transport 'https' not allowed/);
});
