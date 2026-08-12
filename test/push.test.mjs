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
  mkdirSync(join(seed, 'claude'), { recursive: true });
  mkdirSync(join(seed, 'codex'), { recursive: true });
  writeFileSync(join(seed, 'claude', 'CLAUDE.md'), '# from repo\n');
  writeFileSync(join(seed, 'codex', 'AGENTS.md'), '# codex from repo\n');
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
  const codex = join(home, '.codex');
  const agents = join(home, '.agents', 'skills');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { home, claude, codex, agents };
}

function headSha(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

function headMessage(dir) {
  return execSync('git log -1 --format=%s', { cwd: dir }).toString().trim();
}

async function withFixtureEnv(env, fn) {
  const keys = [
    'NORTUSCC_CLAUDE_DIR',
    'NORTUSCC_CODEX_DIR',
    'NORTUSCC_AGENTS_DIR',
    'NORTUSCC_REPO_DIR',
  ];
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

// Captures both stdout and stderr from a single invocation, so one call can
// be checked both for its human-readable text and for the absence of a raw
// Node stack trace, without running the command under test twice.
function captureBoth(fn) {
  let out = '';
  let err = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = function (chunk) {
    out += chunk.toString();
    return true;
  };
  process.stderr.write = function (chunk) {
    err += chunk.toString();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    })
    .then((result) => ({ result, stdout: () => out, stderr: () => err }));
}

// A standalone repo with the manifest layout but no remote at all -- used to
// exercise the "no upstream configured" branch, which is a legitimate state
// (a fresh branch that was never pushed) distinct from "nothing to push".
function createStandaloneRepo(prefix) {
  const work = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  execSync('git init -b main', { cwd: work, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: work, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: work, stdio: 'ignore' });
  mkdirSync(join(work, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(work, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(work, 'claude', 'bin', '.gitkeep'), '');
  writeFileSync(join(work, 'claude', 'hooks', '.gitkeep'), '');
  writeFileSync(join(work, 'claude', 'settings.json'), '{"version":1}\n');
  writeFileSync(join(work, 'claude', 'CLAUDE.md'), '# from repo\n');
  execSync('git add .', { cwd: work, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: work, stdio: 'ignore' });
  return work;
}

test('push refuses without an explicit message and stages nothing', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-nomsg');
  const { claude, codex, agents } = createTestHome('nortuscc-push-nomsg-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
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
  const { claude, codex, agents } = createTestHome('nortuscc-push-emptym-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
    async () => {
      const code = await pushRun(['-m']);
      assert.equal(code, 2, 'a dangling -m with no following value is not a message');
    },
  );
});

test('push with nothing captured reports a no-op and makes no commit', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-noop');
  const { claude, codex, agents } = createTestHome('nortuscc-push-noop-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
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
  const { claude, codex, agents } = createTestHome('nortuscc-push-full-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
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

// push hands capture only the flags capture understands. That filter used to
// drop --target on the floor, so `push --target codex` captured and committed
// the Claude file too — the exact silent over-reach the target option exists
// to prevent.
test('push forwards its target to capture and commits only that agent\'s file', async () => {
  const { work } = createRemoteAndClone('nortuscc-push-target');
  const { claude, codex, agents } = createTestHome('nortuscc-push-target-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
    async () => {
      assert.equal(await applyRun([]), 0);

      // Both agents drift locally; only Codex is named on the command line.
      writeFileSync(join(claude, 'CLAUDE.md'), '# claude edit\n');
      writeFileSync(join(codex, 'AGENTS.md'), '# codex edit\n');

      const code = await pushRun(['--target', 'codex', '-m', 'test: codex only']);
      assert.equal(code, 0);

      const committedFiles = execSync('git show --stat --format= HEAD', { cwd: work }).toString();
      assert.match(committedFiles, /codex\/AGENTS\.md/, 'the named target must be committed');
      assert.doesNotMatch(
        committedFiles,
        /claude\/CLAUDE\.md/,
        'a target-less capture would sweep the other agent into the same commit',
      );
    },
  );
});

test('push does not commit or push when capture refuses a conflict', async () => {
  const { bare, work } = createRemoteAndClone('nortuscc-push-conflict');
  const { claude, codex, agents } = createTestHome('nortuscc-push-conflict-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
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
  const { claude, codex, agents } = createTestHome('nortuscc-push-takelocal-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
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
  const { claude, codex, agents } = createTestHome('nortuscc-push-longflag-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
    async () => {
      assert.equal(await applyRun([]), 0);
      writeFileSync(join(claude, 'CLAUDE.md'), '# via long flag\n');

      const code = await pushRun(['--message', 'test: long flag']);
      assert.equal(code, 0);
      assert.equal(headMessage(work), 'test: long flag');
    },
  );
});

test('a retried push after a failed non-fast-forward attempt must not report success', async () => {
  const { bare, work } = createRemoteAndClone('nortuscc-push-retry');
  const { claude, codex, agents } = createTestHome('nortuscc-push-retry-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
    async () => {
      assert.equal(await applyRun([]), 0);

      // Simulate another machine pushing to the shared remote first, so this
      // machine's eventual push is a genuine non-fast-forward rejection, not
      // just "nothing to do".
      const other = mkdtempSync(join(tmpdir(), 'nortuscc-push-retry-other-'));
      execFileSync('git', ['clone', bare, other], { stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: other, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: other, stdio: 'ignore' });
      writeFileSync(join(other, 'claude', 'CLAUDE.md'), '# from another machine\n');
      execSync('git commit -am "another machine\'s change"', { cwd: other, stdio: 'ignore' });
      execFileSync('git', ['-C', other, 'push'], { stdio: 'ignore' });

      // Now this machine captures and commits locally, unaware the remote
      // has moved on.
      writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');

      const first = await captureBoth(() => pushRun(['-m', 'test: first attempt']));
      assert.equal(first.result, 1, 'the first attempt must fail: the remote has diverged');
      assert.doesNotMatch(first.stderr(), /at .*:\d+:\d+/, 'no raw stack trace on the first failure');

      const shaAfterFirst = headSha(work);
      assert.equal(headMessage(work), 'test: first attempt', 'the commit lands locally even though the push failed');

      // Retry, exactly as a user re-running the same command would. capture
      // finds nothing new -- the machine already matches what was captured
      // on the first attempt -- but the local branch is still ahead of its
      // upstream and must not be reported as a no-op.
      const second = await captureBoth(() => pushRun(['-m', 'test: retry']));
      assert.notEqual(second.result, 0, 'a retried push with an unpushed local commit must not report success');
      assert.doesNotMatch(
        second.stdout(),
        /nothing captured; nothing to push/,
        'push has an unreconciled local commit ahead of upstream; it must not claim there is nothing to push',
      );
      assert.doesNotMatch(second.stderr(), /at .*:\d+:\d+/, 'no raw stack trace on the retry failure either');
      assert.equal(headSha(work), shaAfterFirst, 'the retry must not create a duplicate local commit');

      const bareHead = execSync('git log -1 --format=%s', { cwd: bare }).toString().trim();
      assert.equal(bareHead, "another machine's change", 'the diverged local commit never reached the remote');
    },
  );
});

test('push on a fresh branch with no upstream and nothing captured is a genuine no-op, not a crash', async () => {
  const work = createStandaloneRepo('nortuscc-push-noupstream');
  const { claude, codex, agents } = createTestHome('nortuscc-push-noupstream-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
    },
    async () => {
      assert.equal(await applyRun([]), 0);
      const shaBefore = headSha(work);

      const { result: code, output } = await captureStdout(() => pushRun(['-m', 'test: no upstream no-op']));
      assert.equal(code, 0, 'no upstream configured, and nothing captured, must be a genuine no-op, not an error');
      assert.match(output(), /nothing captured; nothing to push/);
      assert.equal(headSha(work), shaBefore, 'no commit should be created');
    },
  );
});
