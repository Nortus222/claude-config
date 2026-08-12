import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run as applyRun } from '../src/commands/apply.mjs';
import { run as pullRun } from '../src/commands/pull.mjs';

// pull.mjs's `git pull` must never contact a real network remote. Every
// fixture is a bare repo on local disk plus clones of it -- "pull" moves
// commits only between directories under os.tmpdir().
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

function cloneOf(bare, prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  execFileSync('git', ['clone', bare, dir], { stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function createTestHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const claude = join(home, '.claude');
  const codex = join(home, '.codex');
  const agents = join(home, '.agents', 'skills');
  // nortuscc's own state lives outside every agent dir, so it needs its own
  // override — without it these runs write the developer's real state file.
  const state = join(home, 'state');
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { home, claude, codex, agents, state };
}

function headSha(dir) {
  return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
}

async function withFixtureEnv(env, fn) {
  const keys = [
    'NORTUSCC_CLAUDE_DIR',
    'NORTUSCC_CODEX_DIR',
    'NORTUSCC_AGENTS_DIR',
    'NORTUSCC_REPO_DIR',
    'NORTUSCC_STATE_DIR',
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

function captureStderr(fn) {
  let output = '';
  const original = process.stderr.write;
  process.stderr.write = function (chunk) {
    output += chunk.toString();
    return true;
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.stderr.write = original;
    })
    .then((result) => ({ result, output: () => output }));
}

test('pull refuses gracefully when the local and remote branches have diverged, without a stack trace, and never calls apply', async () => {
  const { bare, work } = createRemoteAndClone('nortuscc-pull-diverge');
  const { claude, codex, agents, state } = createTestHome('nortuscc-pull-diverge-home-');

  // A second clone pushes a commit to the bare remote that `work` never sees...
  const other = cloneOf(bare, 'nortuscc-pull-diverge-other');
  writeFileSync(join(other, 'claude', 'CLAUDE.md'), '# from other machine\n');
  execSync('git add .', { cwd: other, stdio: 'ignore' });
  execSync('git commit -m "other machine change"', { cwd: other, stdio: 'ignore' });
  execSync('git push origin main', { cwd: other, stdio: 'ignore' });

  // ...while `work` makes its own unpushed local commit. Now `work`'s branch
  // cannot fast-forward onto origin/main: a real divergence, not a mock.
  writeFileSync(join(work, 'claude', 'CLAUDE.md'), '# local unpushed change\n');
  execSync('git add .', { cwd: work, stdio: 'ignore' });
  execSync('git commit -m "local unpushed change"', { cwd: work, stdio: 'ignore' });

  const shaBefore = headSha(work);

  // A sentinel claude dir: if apply ran despite the pull failure, this would
  // be overwritten from the repo.
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'CLAUDE.md'), '# sentinel, must survive\n');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
      NORTUSCC_STATE_DIR: state,
    },
    async () => {
      const { result: code, output } = await captureStderr(() => pullRun([]));

      assert.equal(code, 1, 'a diverged, non-fast-forwardable pull must return a deliberate non-zero code');
      assert.match(
        output(),
        /nortuscc: git pull --ff-only failed/,
        'the failure must be reported as a human-readable line',
      );
      assert.doesNotMatch(output(), /at\s+.*\(.*:\d+:\d+\)/, 'no raw Node stack trace frame should be printed');

      assert.equal(headSha(work), shaBefore, "a failed pull must not have moved work's HEAD");
      assert.equal(
        readFileSync(join(claude, 'CLAUDE.md'), 'utf8'),
        '# sentinel, must survive\n',
        'apply must never run after a failed pull',
      );
    },
  );
});

test('pull with nothing new succeeds and delegates to apply', async () => {
  const { work } = createRemoteAndClone('nortuscc-pull-noop');
  const { claude, codex, agents, state } = createTestHome('nortuscc-pull-noop-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
      NORTUSCC_STATE_DIR: state,
    },
    async () => {
      const code = await pullRun([]);
      assert.equal(code, 0);
      assert.equal(
        readFileSync(join(claude, 'CLAUDE.md'), 'utf8'),
        '# from repo\n',
        'apply must have run and copied the repo file down to the machine',
      );
    },
  );
});

test('pull forwards args through to apply, resolving a conflict with --take-repo', async () => {
  const { work } = createRemoteAndClone('nortuscc-pull-takerepo');
  const { claude, codex, agents, state } = createTestHome('nortuscc-pull-takerepo-home-');

  await withFixtureEnv(
    {
      NORTUSCC_CLAUDE_DIR: claude,
      NORTUSCC_CODEX_DIR: codex,
      NORTUSCC_AGENTS_DIR: agents,
      NORTUSCC_REPO_DIR: work,
      NORTUSCC_STATE_DIR: state,
    },
    async () => {
      // Baseline: seed the machine so the lockfile has a recorded hash.
      assert.equal(await applyRun([]), 0);

      // Conflict: both sides change after the baseline. The repo-side change
      // is a local commit in `work` only -- remote is untouched, so `git
      // pull --ff-only` will trivially succeed ("already up to date") and
      // the conflict is left for apply to resolve.
      writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');
      writeFileSync(join(work, 'claude', 'CLAUDE.md'), '# repo change\n');
      execSync('git add .', { cwd: work, stdio: 'ignore' });
      execSync('git commit -m "repo change"', { cwd: work, stdio: 'ignore' });

      const code = await pullRun(['--take-repo']);
      assert.equal(code, 0, '--take-repo forwarded to apply should resolve the conflict');
      assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), '# repo change\n');
    },
  );
});
