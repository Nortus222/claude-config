import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as applyRun } from '../src/commands/apply.mjs';
import { run as pushRun } from '../src/commands/push.mjs';

// push.mjs's `git push` must never reach a real network remote. Every
// fixture here is a bare repo on local disk plus a clone of it, so "push"
// really does move commits, but only ever between two directories under
// os.tmpdir() -- nothing ever leaves the machine, let alone hits origin.
function createRemoteAndClone(prefix) {
  const seed = mkdtempSync(join(tmpdir(), `${prefix}-seed-`));
  execSync('git init -b main', { cwd: seed, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: seed, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: seed, stdio: 'ignore' });
  mkdirSync(join(seed, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(seed, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(seed, 'claude', 'bin', '.gitkeep'), '');
  writeFileSync(join(seed, 'claude', 'hooks', '.gitkeep'), '');
  writeFileSync(join(seed, 'claude', 'settings.json'), '{"version":1}\n');
  writeFileSync(join(seed, 'claude', 'CLAUDE.md'), '# from repo\n');
  execSync('git add .', { cwd: seed, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: seed, stdio: 'ignore' });

  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`));
  execFileSync('git', ['clone', '--bare', seed, bare], { stdio: 'ignore' });

  const work = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: work, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: work, stdio: 'ignore' });

  return { bare, work };
}

function createTestHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const claude = join(home, '.claude');
  const agents = join(home, '.agents', 'skills');
  mkdirSync(claude, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { home, claude, agents };
}

function headSha(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function headMessage(dir) {
  return execSync('git log -1 --format=%s', { cwd: dir }).toString().trim();
}

async function withFixtureEnv(env, fn) {
  const keys = ['NORTUSCC_CLAUDE_DIR', 'NORTUSCC_AGENTS_DIR', 'NORTUSCC_REPO_DIR'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function captureStdout(fn) {
  let output = '';
  const original = process.stdout.write;
  process.stdout.write = function (chunk) {
    output += chunk.toString();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = original;
    })
    .then((result) => ({ result, output: () => output }));
}

test('push refuses without an explicit message and stages nothing', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-nomsg');
  const { claude, agents } = createTestHome('nortuscc-push-nomsg-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      const shaBefore = headSha(work);
      const code = await pushRun([]);
      assert.equal(code, 2, 'push with no -m/--message must refuse (exit 2), never invent a message');
      assert.equal(headSha(work), shaBefore, 'no commit should be created');
      const staged = execSync('git diff --cached --name-only', { cwd: work }).toString().trim();
      assert.equal(staged, '', 'nothing should be staged when push refuses');
    },
  );
});

test('push refuses when -m is given with no value', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-emptym');
  const { claude, agents } = createTestHome('nortuscc-push-emptym-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      const code = await pushRun(['-m']);
      assert.equal(code, 2, 'a dangling -m with no following value is not a message');
    },
  );
});

test('push with nothing captured reports a no-op and makes no commit', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-noop');
  const { claude, agents } = createTestHome('nortuscc-push-noop-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      // Seed the local machine so it exactly matches the repo: capture will
      // have nothing to report.
      assert.equal(await applyRun([]), 0);
      const shaBefore = headSha(work);

      const { result: code, output } = await captureStdout(() => pushRun(['-m', 'test: no-op']));
      assert.equal(code, 0);
      assert.match(output(), /nothing captured; nothing to push/);
      assert.equal(headSha(work), shaBefore, 'a no-op capture must not produce a commit');
    },
  );
});

test('push stages only manifest-owned captured paths, commits with the given message, and pushes to the local remote', async () => {
  const { bare, work } = createRemoteAndClone('nortuscc-push-full');
  const { claude, agents } = createTestHome('nortuscc-push-full-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      assert.equal(await applyRun([]), 0);
      writeFileSync(join(claude, 'CLAUDE.md'), '# captured edit\n');

      // Unrelated in-flight work sitting in the repo checkout. push must
      // never sweep this into the commit -- it is none of this tool's
      // business, and `git add -A` would grab it.
      writeFileSync(join(work, 'unrelated.txt'), 'work in progress\n');

      const code = await pushRun(['-m', 'test: capture edit']);
      assert.equal(code, 0);

      assert.equal(headMessage(work), 'test: capture edit');

      const committedFiles = execSync('git show --stat --format= HEAD', { cwd: work }).toString();
      assert.match(committedFiles, /claude\/CLAUDE\.md/, 'the captured file must be in the commit');
      assert.doesNotMatch(committedFiles, /unrelated\.txt/, 'unrelated work must never be committed by push');

      const status = execSync('git status --porcelain', { cwd: work }).toString();
      assert.match(status, /\?\? unrelated\.txt/, 'unrelated file must remain untracked after push');

      // Prove an actual push happened against the local bare "remote", not
      // just a local commit.
      const bareHead = execSync('git log -1 --format=%s', { cwd: bare }).toString().trim();
      assert.equal(bareHead, 'test: capture edit', 'the bare remote must have received the push');
    },
  );
});

test('push does not commit or push when capture refuses a conflict', async () => {
  const { bare, work } = createRemoteAndClone('nortuscc-push-conflict');
  const { claude, agents } = createTestHome('nortuscc-push-conflict-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      assert.equal(await applyRun([]), 0);

      // Genuine conflict: both sides change after the baseline.
      writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');
      writeFileSync(join(work, 'claude', 'CLAUDE.md'), '# repo change\n');
      execSync('git add .', { cwd: work, stdio: 'ignore' });
      execSync('git commit -m "repo change"', { cwd: work, stdio: 'ignore' });

      const shaBefore = headSha(work);
      const bareHeadBefore = execSync('git log -1 --format=%s', { cwd: bare }).toString().trim();

      const code = await pushRun(['-m', 'test: should not land']);
      assert.equal(code, 1, "push must surface capture's refusal exit code");
      assert.equal(headSha(work), shaBefore, 'a refused capture must not produce a commit');
      assert.equal(
        execSync('git log -1 --format=%s', { cwd: bare }).toString().trim(),
        bareHeadBefore,
        'nothing should have been pushed to the remote',
      );
    },
  );
});

test('push forwards --take-local to capture, resolving a conflict in the local file\'s favor', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-takelocal');
  const { claude, agents } = createTestHome('nortuscc-push-takelocal-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      assert.equal(await applyRun([]), 0);

      writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');
      writeFileSync(join(work, 'claude', 'CLAUDE.md'), '# repo change\n');
      execSync('git add .', { cwd: work, stdio: 'ignore' });
      execSync('git commit -m "repo change"', { cwd: work, stdio: 'ignore' });

      const code = await pushRun(['-m', 'test: take local', '--take-local']);
      assert.equal(code, 0, '--take-local forwarded to capture should resolve the conflict');
      assert.equal(readFileSync(join(work, 'claude', 'CLAUDE.md'), 'utf8'), '# local change\n');
      assert.equal(headMessage(work), 'test: take local');
    },
  );
});

test('push accepts --message as an alias for -m', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-longflag');
  const { claude, agents } = createTestHome('nortuscc-push-longflag-home-');

  await withFixtureEnv(
    { NORTUSCC_CLAUDE_DIR: claude, NORTUSCC_AGENTS_DIR: agents, NORTUSCC_REPO_DIR: work },
    async () => {
      assert.equal(await applyRun([]), 0);
      writeFileSync(join(claude, 'CLAUDE.md'), '# via long flag\n');

      const code = await pushRun(['--message', 'test: long flag']);
      assert.equal(code, 0);
      assert.equal(headMessage(work), 'test: long flag');
    },
  );
});
