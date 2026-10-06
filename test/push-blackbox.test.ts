import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, runCli, type Machine } from './support/cli.ts';

// `nortuscc push` from the outside: a temp machine, a temp repo with a bare origin, fake installers.

const push = (m: Machine, ...args: string[]) => runCli(m, ['push', ...args]);
const origin = (m: Machine) => join(m.home, 'origin.git');
// Paths the commit at `ref` touched, exactly.
const committed = (cwd: string, ref = 'HEAD') => git(cwd, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean).sort();
const subject = (cwd: string, ref = 'HEAD') => git(cwd, 'log', '-1', '--format=%s', ref);

async function applied(): Promise<Machine> {
  const m = machine();
  git(m.repo, 'config', 'user.email', 't@t');
  git(m.repo, 'config', 'user.name', 't');
  const result = await runCli(m, ['apply']);
  assert.equal(result.code, 0, result.stderr);
  return m;
}

test('the captured file is committed alone and lands on origin; unrelated work stays untracked', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# captured edit\n');
  writeFileSync(join(m.repo, 'unrelated.txt'), 'work in progress\n');

  const result = await push(m, '-m', 'test: capture edit');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /staged:/);
  assert.equal(subject(m.repo), 'test: capture edit');
  assert.deepEqual(committed(m.repo), ['claude/CLAUDE.md']);
  assert.equal(git(m.repo, 'status', '--porcelain'), '?? unrelated.txt');
  assert.equal(subject(origin(m)), 'test: capture edit');
  assert.deepEqual(committed(origin(m)), ['claude/CLAUDE.md']);
});

test('a missing message, or a dangling -m, is a usage error that stages nothing', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# edit\n');
  const head = git(m.repo, 'rev-parse', 'HEAD');

  for (const args of [[], ['-m']]) {
    const result = await push(m, ...args);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /push requires an explicit message/);
  }
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(m.repo, 'status', '--porcelain'), '');
});

test('--message is an alias for -m', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# long\n');
  const result = await push(m, '--message', 'test: long flag');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(subject(m.repo), 'test: long flag');
  assert.deepEqual(committed(m.repo), ['claude/CLAUDE.md']);
});

test('nothing captured and nothing ahead is a no-op', async () => {
  const m = await applied();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  const result = await push(m, '-m', 'test: nothing');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /nothing captured; nothing to push/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
});

test('a branch with no upstream and nothing captured is a no-op, not a crash', async () => {
  const m = await applied();
  git(m.repo, 'branch', '--unset-upstream');
  const result = await push(m, '-m', 'test: nothing');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /nothing captured; nothing to push/);
});

test('a prior unpushed local commit is pushed when capture finds nothing, without a new commit', async () => {
  const m = await applied();
  writeFileSync(join(m.repo, 'note.txt'), 'earlier\n');
  git(m.repo, 'add', 'note.txt');
  git(m.repo, 'commit', '-qm', 'earlier local commit');
  const head = git(m.repo, 'rev-parse', 'HEAD');

  const result = await push(m, '-m', 'test: unused');
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /nothing captured/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(origin(m), 'rev-parse', 'main'), head);
});

test('a push rejected because origin advanced exits 1 with the two-line message; a retry still fails', async () => {
  const m = await applied();
  const other = join(m.home, 'other');
  git(m.home, 'clone', '-q', origin(m), other);
  writeFileSync(join(other, 'claude', 'CLAUDE.md'), '# from another machine\n');
  git(other, 'commit', '-qam', 'another machine');
  git(other, 'push', '-q');
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');

  const first = await push(m, '-m', 'test: first');
  assert.equal(first.code, 1);
  assert.match(first.stderr, /nortuscc: git add\/commit\/push failed\.\nResolve the git error above, then try again\./);
  assert.doesNotMatch(first.stderr, /at .*:\d+:\d+/);
  assert.equal(subject(m.repo), 'test: first');
  const head = git(m.repo, 'rev-parse', 'HEAD');

  const retry = await push(m, '-m', 'test: retry');
  assert.equal(retry.code, 1);
  assert.doesNotMatch(retry.stdout, /nothing captured/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(subject(origin(m)), 'another machine');
});

test('--target limits the commit to that agent', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# claude edit\n');
  writeFileSync(join(m.codex, 'AGENTS.md'), '# codex edit\n');
  const result = await push(m, '--target', 'codex', '-m', 'test: codex only');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(committed(m.repo), ['codex/AGENTS.md']);
});

test('a refused conflict commits and pushes nothing; --take-local resolves it', async () => {
  const m = await applied();
  writeFileSync(join(m.claude, 'CLAUDE.md'), '# local\n');
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# repo\n');
  git(m.repo, 'commit', '-qam', 'repo change');
  git(m.repo, 'push', '-q');
  const head = git(m.repo, 'rev-parse', 'HEAD');

  const refused = await push(m, '-m', 'test: refused');
  assert.equal(refused.code, 1);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(git(m.repo, 'diff', '--cached', '--name-only'), '');

  const taken = await push(m, '-m', 'test: take local', '--take-local');
  assert.equal(taken.code, 0, taken.stderr);
  assert.deepEqual(committed(m.repo), ['claude/CLAUDE.md']);
  assert.equal(git(m.repo, 'show', 'HEAD:claude/CLAUDE.md'), '# local');
  assert.equal(subject(origin(m)), 'test: take local');
});
