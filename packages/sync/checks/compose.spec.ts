import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { loadProfile, nodeFiles } from '@nortuscc/profile-engine';
import { commitDocuments, desiredFor, desiredOfDocuments } from '../src/index.ts';
import { BASE, failureOf, json, load, runSync, tempRepo } from './support/repo.ts';

const EFFORT = 'setting:claude:settings.json#effortLevel';
const keysOf = (snapshot: { desired: { files: ReadonlyArray<{ id: string; keys?: Readonly<Record<string, { value: unknown }>> }> } }) =>
  snapshot.desired.files.find((f) => f.id === 'claude:settings.json')!.keys!;

test('with nothing held, the working tree resolves in place exactly as loadProfile', async () => {
  const repo = tempRepo();
  const into = join(repo.root, 'into');
  const snapshot = await runSync(desiredFor({ repo: repo.dir, head: { kind: 'worktree' }, held: {}, into }));
  assert.equal(snapshot.repo, repo.dir);
  assert.deepEqual(snapshot.desired, await load(repo.dir));
  assert.equal(existsSync(into), false);
});

test('a held key keeps its held value over the working tree, whose other edits still apply', async () => {
  const repo = tempRepo();
  repo.commit({ 'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }) });
  repo.write({ 'claude/CLAUDE.md': '# being edited\n' });
  const into = join(repo.root, 'into');
  const snapshot = await runSync(desiredFor({ repo: repo.dir, head: { kind: 'worktree' }, held: { [EFFORT]: repo.first }, into }));
  assert.equal(snapshot.repo, into);
  assert.equal(keysOf(snapshot).effortLevel!.value, 'high');
  assert.equal(keysOf(snapshot).theme!.value, 'light');
  assert.equal(readFileSync(join(into, 'claude/CLAUDE.md'), 'utf8'), '# being edited\n');
  assert.equal(readFileSync(join(into, 'claude/hooks/hk.mjs'), 'utf8'), BASE['claude/hooks/hk.mjs']);
});

test('a commit head comes from git objects only', async () => {
  const repo = tempRepo();
  const second = repo.commit({ 'claude/CLAUDE.md': '# second\n' });
  repo.write({ 'claude/CLAUDE.md': '# uncommitted\n' });
  const into = join(repo.root, 'into');
  const snapshot = await runSync(desiredFor({ repo: repo.dir, head: { kind: 'commit', commit: second }, held: {}, into }));
  assert.equal(readFileSync(join(into, 'claude/CLAUDE.md'), 'utf8'), '# second\n');
  assert.deepEqual(snapshot.desired, desiredOfDocuments(await runSync(commitDocuments(repo.dir, second))));
});

test("this machine's override still wins over a held value", async () => {
  const repo = tempRepo();
  repo.commit({ 'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'medium' }) });
  const overrides = { value: { settings: { 'claude:settings.json': { effortLevel: 'low' } } }, source: 'overrides.json', issues: [] };
  const snapshot = await runSync(desiredFor({
    repo: repo.dir, head: { kind: 'worktree' }, held: { [EFFORT]: repo.first }, into: join(repo.root, 'into'), overrides,
  }));
  assert.equal(keysOf(snapshot).effortLevel!.value, 'low');
});

test('a hold on a commit the checkout lacks is RevisionUnavailable', async () => {
  const repo = tempRepo();
  const failure = await failureOf(desiredFor({
    repo: repo.dir, head: { kind: 'worktree' }, held: { [EFFORT]: 'f'.repeat(40) }, into: join(repo.root, 'into'),
  }));
  assert.equal(failure._tag, 'RevisionUnavailable');
});

test('two items held in one document both survive, whatever order the holds are in', async () => {
  const repo = tempRepo();
  repo.commit({
    'claude/settings.keys.json': json({ theme: 'light', effortLevel: 'medium' }),
    'skills-manifest.txt': '[mattpocock/skills] optional\ntdd\ndiagnose\n\n[anthropics/skills] optional\npdf\n',
  });
  const TDD = 'skill:mattpocock/skills/tdd';
  const DIAGNOSE = 'skill:mattpocock/skills/diagnose';
  const THEME = 'setting:claude:settings.json#theme';
  for (const [n, ids] of [[THEME, EFFORT, TDD, DIAGNOSE], [DIAGNOSE, TDD, EFFORT, THEME]].entries()) {
    const held = Object.fromEntries(ids.map((id) => [id, repo.first]));
    const snapshot = await runSync(desiredFor({ repo: repo.dir, head: { kind: 'worktree' }, held, into: join(repo.root, `into-${n}`) }));
    assert.equal(keysOf(snapshot).theme!.value, 'auto');
    assert.equal(keysOf(snapshot).effortLevel!.value, 'high');
    const optional = Object.fromEntries(snapshot.desired.skills.map((s: { name: string; optional: boolean }) => [s.name, s.optional]));
    assert.deepEqual(optional, { tdd: false, diagnose: false, pdf: true });
  }
});

test('with nothing held, overrides resolve exactly as loadProfile with the same overrides', async () => {
  const repo = tempRepo();
  const overrides = { value: { settings: { 'claude:settings.json': { effortLevel: 'low' } }, skills: { pdf: true } }, source: 'overrides.json', issues: [] };
  const snapshot = await runSync(desiredFor({ repo: repo.dir, head: { kind: 'worktree' }, held: {}, into: join(repo.root, 'into'), overrides }));
  assert.deepEqual(snapshot.desired, await Effect.runPromise(loadProfile(repo.dir, { overrides }).pipe(Effect.provide(nodeFiles))));
  assert.equal(keysOf(snapshot).effortLevel!.value, 'low');
});
