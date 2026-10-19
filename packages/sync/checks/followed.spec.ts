import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs, nodeProcesses, type MachinePathsValue } from '@nortuscc/machine';
import * as sync from '../src/index.ts';
import { tempRepo } from './support/repo.ts';

const URL = 'https://github.com/example/setup.git';
const fixture = () => {
  const repo = tempRepo({ 'claude/CLAUDE.md': '# first\n' });
  repo.git('remote', 'add', 'origin', URL);
  const paths: MachinePathsValue = { repo: repo.dir, stateRoot: join(repo.root, 'state'), backups: join(repo.root, 'backups'), claude: join(repo.root, 'claude'), codex: join(repo.root, 'codex'), codexOpenRouter: join(repo.root, 'glm'), agentsSkills: join(repo.root, 'skills') };
  const services = sync.setupsStore.pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, nodeProcesses())));
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(Effect.provide(services)) as Effect.Effect<A, E>);
  return { ...repo, paths, run };
};

test("an existing CLI checkout migrates to follow its origin's default profile", async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await f.run(sync.SetupsStore.use(s => s.write([{ setupId: 'setup-1', accountId: 'account-1', repoUrl: sync.normalizeRepoUrl(URL), checkout: f.dir, trustedAt: '2026-10-15T00:00:00Z' }])));
  const expected = { repoUrl: URL, profile: 'default', setupId: 'setup-1' };
  assert.deepEqual(await f.run(sync.migrateFollowed(f.paths)), expected);
  assert.deepEqual(JSON.parse(readFileSync(join(f.paths.stateRoot, 'agent/followed.json'), 'utf8')), { version: 1, followed: expected });
  execFileSync('git', ['-C', f.dir, 'remote', 'set-url', 'origin', 'https://github.com/other/repo']);
  assert.deepEqual(await f.run(sync.migrateFollowed(f.paths)), expected, 'migration does not replace an existing selection');
});

test('migration refuses an untrusted or changed checkout origin', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.equal(await f.run(sync.migrateFollowed(f.paths)), undefined);
  await f.run(sync.SetupsStore.use(s => s.write([{ setupId: null, repoUrl: 'github.com/other/repo', checkout: f.dir, trustedAt: '2026-10-15T00:00:00Z' }])));
  assert.equal(await f.run(sync.migrateFollowed(f.paths)), undefined);
});

test('replacing a followed profile preserves its previous selection in backups', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const run = <A, E>(effect: Effect.Effect<A, E, sync.FollowedStore>) => f.run(effect.pipe(Effect.provide(sync.followedStore)));
  const first = { repoUrl: URL, profile: 'default', setupId: null };
  await run(sync.FollowedStore.use(s => s.write(first)));
  await run(sync.FollowedStore.use(s => s.write({ ...first, profile: 'personal' })));
  const backup = readdirSync(f.paths.backups, { recursive: true }).find(p => String(p).endsWith('agent/followed.json'));
  assert.ok(backup);
  assert.deepEqual(JSON.parse(readFileSync(join(f.paths.backups, String(backup)), 'utf8')).followed, first);
});


test('migration preserves applied and held Git objects before abandoning the CLI checkout', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const held = f.commit({ 'claude/CLAUDE.md': '# held locally\n' });
  f.git('reset', '--hard', f.first);
  mkdirSync(f.paths.stateRoot, { recursive: true });
  writeFileSync(join(f.paths.stateRoot, 'state.json'), JSON.stringify({ version: 1, repo: f.dir, files: {}, applied: { commit: f.first, at: '2026-10-15T00:00:00Z' } }));
  writeFileSync(join(f.paths.stateRoot, 'sync.json'), JSON.stringify({ version: 1, held: { 'file:claude:CLAUDE.md': held } }));
  await f.run(sync.SetupsStore.use(s => s.write([{ setupId: null, repoUrl: sync.normalizeRepoUrl(URL), checkout: f.dir, trustedAt: '2026-10-15T00:00:00Z' }])));
  await f.run(sync.migrateFollowed(f.paths));
  rmSync(f.dir, { recursive: true, force: true });
  const clone = sync.followedClone(f.paths, URL);
  assert.equal(execFileSync('git', ['--git-dir', clone, 'cat-file', 'blob', `${held}:claude/CLAUDE.md`], { encoding: 'utf8' }), '# held locally\n');
  assert.equal(execFileSync('git', ['--git-dir', clone, 'cat-file', 'blob', `${f.first}:claude/CLAUDE.md`], { encoding: 'utf8' }), '# first\n');
});


test('an invalid trusted origin cannot seed a followed selection', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const invalid = 'https://[invalid/repo';
  f.git('remote', 'set-url', 'origin', invalid);
  await f.run(sync.SetupsStore.use(s => s.write([{ setupId: null, repoUrl: invalid, checkout: f.dir, trustedAt: '2026-10-15T00:00:00Z' }])));
  assert.equal(await f.run(sync.migrateFollowed(f.paths)), undefined);
});
