import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Git, LOG_FORMAT, parseLog, type RunOptions } from '../src/git.ts';
import { makeRepo, runGit, tempDir } from './fixtures.ts';

const run = (args: string[], options?: RunOptions) =>
  Effect.gen(function* () {
    const git = yield* Git;
    return yield* git.run(args, options);
  });

test('returns stdout, and parseLog reads commits without emails', async (t) => {
  const repo = makeRepo(tempDir(t));
  const first = repo.commit('first', { 'a.txt': 'a\n' });
  const second = repo.commit('second: with | odd chars', { 'a.txt': 'b\n' });
  const commits = parseLog(await runGit(run(['log', LOG_FORMAT], { cwd: repo.dir })));
  assert.deepEqual(commits.map((c) => [c.sha, c.subject, c.author]), [
    [second, 'second: with | odd chars', 'Ada'],
    [first, 'first', 'Ada'],
  ]);
  assert.match(commits[0]!.date, /^2026-01-01T\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/);
  assert.doesNotMatch(JSON.stringify(commits), /example\.com/);
});

test('a failing command is a GitFailed carrying git\'s message, redacted', async (t) => {
  const root = tempDir(t);
  const error = await runGit(Effect.flip(run(['ls-remote', `file://${root}/nope?token=s3cret`])));
  assert.equal(error._tag, 'GitFailed');
  assert.match(error.reason, /does not appear to be a git repository/);
  assert.doesNotMatch(error.reason, /s3cret/);
});

test('transports outside allowProtocols are refused without touching the network', async (t) => {
  const root = tempDir(t);
  const error = await runGit(Effect.flip(run(['clone', 'https://ada:s3cret@example.invalid/x.git', join(root, 'x')])));
  assert.match(error.reason, /transport 'https' not allowed/);
  assert.doesNotMatch(error.reason, /s3cret/);
});

test('an exit code listed in ok succeeds', async (t) => {
  const repo = makeRepo(tempDir(t));
  const first = repo.commit('first');
  const second = repo.commit('second');
  assert.equal(await runGit(run(['merge-base', '--is-ancestor', second, first], { cwd: repo.dir, ok: [0, 1] })), '');
  await assert.rejects(runGit(run(['merge-base', '--is-ancestor', second, first], { cwd: repo.dir })));
});

test('a missing working directory is a GitFailed, not a crash', async (t) => {
  const error = await runGit(Effect.flip(run(['status'], { cwd: join(tempDir(t), 'missing') })));
  assert.equal(error._tag, 'GitFailed');
});

test('forces log.showSignature off and literal pathspecs, whatever the user configured', async (t) => {
  const root = tempDir(t);
  const config = join(root, 'gitconfig');
  writeFileSync(config, '[log]\n\tshowSignature = true\n');
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  });
  const repo = makeRepo(root);
  const sha = repo.commit('first', { 'a.txt': 'a\n' });
  assert.equal((await runGit(run(['config', '--get', 'log.showSignature'], { cwd: repo.dir }))).trim(), 'false');
  const commits = parseLog(await runGit(run(['log', LOG_FORMAT], { cwd: repo.dir })));
  assert.deepEqual(commits.map((c) => c.sha), [sha]);
});

test('appends to config the parent environment already passes through GIT_CONFIG_COUNT', async (t) => {
  const root = tempDir(t);
  const repo = makeRepo(root);
  repo.commit('first', { 'a.txt': 'a\n' });
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'user.name';
  process.env.GIT_CONFIG_VALUE_0 = 'Env User';
  t.after(() => {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  });
  assert.equal((await runGit(run(['config', '--get', 'user.name'], { cwd: repo.dir }))).trim(), 'Env User');
  assert.equal((await runGit(run(['config', '--get', 'log.showSignature'], { cwd: repo.dir }))).trim(), 'false');
});

test('pathspecs are literal', async (t) => {
  const repo = makeRepo(tempDir(t));
  repo.commit('first', { 'a.txt': 'a\n' });
  assert.equal((await runGit(run(['ls-files', '--', '*.txt'], { cwd: repo.dir }))).trim(), '');
});
