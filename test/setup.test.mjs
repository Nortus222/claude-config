import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Helper: create a test repo
function createTestRepo(prefix = 'nortuscc-setup-repo-') {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execSync('git init', { cwd: repo, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: repo, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(repo, 'claude'), { recursive: true });
  mkdirSync(join(repo, 'codex'), { recursive: true });
  writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# test\n');
  writeFileSync(join(repo, 'codex', 'AGENTS.md'), '# test codex\n');
  execSync('git add .', { cwd: repo, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: repo, stdio: 'ignore' });
  return repo;
}

// Helper: create a test home
function createTestHome() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-setup-'));
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

// Test 1: setup updates lock.repo
test('setup updates lock.repo with the repo root', async () => {
  const testRepo = createTestRepo();
  const { claude, codex, agents, state } = createTestHome();

  // Save and clear env
  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    process.env.NORTUSCC_REPO_DIR = testRepo;

    const { run } = await import('../src/commands/setup.mjs');
    const { readLock } = await import('../src/lock.mjs');

    const code = await run([]);
    assert.equal(code, 0);
    const lock = readLock();
    assert.equal(lock.repo, testRepo);
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 2: Probe B — when apply returns non-zero, status should not run
test('when apply returns non-zero, setup short-circuits before status (no banner)', async () => {
  const testRepo = createTestRepo();
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    process.env.NORTUSCC_REPO_DIR = testRepo;

    const { run } = await import('../src/commands/setup.mjs');

    // First run: establish baseline
    let code = await run([]);
    assert.equal(code, 0);

    // Create conflict
    writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');
    writeFileSync(join(testRepo, 'claude', 'CLAUDE.md'), '# repo change\n');
    execSync('git add .', { cwd: testRepo, stdio: 'ignore' });
    execSync('git commit -m "repo change"', { cwd: testRepo, stdio: 'ignore' });

    // Capture stdout
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = function(chunk) {
      output += chunk.toString();
      return originalWrite.call(this, chunk);
    };

    try {
      code = await run([]);
      process.stdout.write = originalWrite;

      // Probe B: verify apply exit code is propagated
      assert.notEqual(code, 0, 'apply returned non-zero');
      assert.equal(
        output.includes('--- status ---'),
        false,
        'PROBE B FAILED: status ran when it should not have'
      );
    } finally {
      process.stdout.write = originalWrite;
    }
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 3: lock.repo fallback
test('lock.repo is used as fallback', async () => {
  const testRepo = createTestRepo();
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    process.env.NORTUSCC_REPO_DIR = testRepo;

    const { run } = await import('../src/commands/setup.mjs');
    const { repoRoot } = await import('../src/resolve.mjs');

    let code = await run([]);
    assert.equal(code, 0);

    // Now delete the env var and verify lock.repo is used
    delete process.env.NORTUSCC_REPO_DIR;
    const root = repoRoot();
    assert.equal(root, testRepo);
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 3b: stale lock.repo (nonexistent path) falls back safely.
//
// repoRoot() is consumed by every command (apply, status, capture, setup
// itself), so a lock.repo left pointing at a moved or deleted clone must
// fall back to the module's own location rather than propagating a path
// that no longer exists -- without this guard every command would appear
// to be broken, when the real problem is just a stale record.
test('stale lock.repo pointing at a nonexistent path falls back to module location', async () => {
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    delete process.env.NORTUSCC_REPO_DIR;

    const { repoRoot } = await import('../src/resolve.mjs');
    const { writeLock } = await import('../src/lock.mjs');

    writeLock({ version: 1, repo: '/nonexistent/nortuscc-stale/path', files: {} });

    const root = repoRoot();
    assert.notEqual(
      root,
      '/nonexistent/nortuscc-stale/path',
      'should not use a lock.repo path that does not exist',
    );
    assert.ok(existsSync(root), 'fallback path should exist');
    assert.ok(
      existsSync(join(root, 'src', 'resolve.mjs')),
      'fallback should be this module\'s own repo checkout, not an arbitrary existing path',
    );
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 3c: stale lock.repo (directory with no .git) falls back safely.
//
// A path that exists but isn't a git checkout (e.g. the clone was deleted
// and the directory got reused, or recreated by something else) is exactly
// as unsafe as a nonexistent one and must fail the same way.
test('stale lock.repo pointing at a directory with no .git falls back to module location', async () => {
  const { claude, codex, agents, state } = createTestHome();
  const notAGitRepo = mkdtempSync(join(tmpdir(), 'nortuscc-not-a-repo-'));

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    delete process.env.NORTUSCC_REPO_DIR;

    const { repoRoot } = await import('../src/resolve.mjs');
    const { writeLock } = await import('../src/lock.mjs');

    writeLock({ version: 1, repo: notAGitRepo, files: {} });

    const root = repoRoot();
    assert.notEqual(
      root,
      notAGitRepo,
      'should not use a lock.repo directory that exists but has no .git',
    );
    assert.ok(existsSync(root), 'fallback path should exist');
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 4: Probe A — --skills must be composed into the applyRun(...) call.
//
// Fixture has a real, correctly source-grouped skills-manifest.txt naming one
// skill, and that skill is pre-installed into the temp agents/skills dir. That
// keeps skills.missing empty, so apply's --skills branch takes the
// "satisfied" path and never calls installGroups — nothing is spawned, no
// network is touched. Without --skills, apply's `if (args.includes('--skills'))`
// block is skipped entirely and no "skills" row is ever produced, so the row's
// presence is a clean, honest signal that only depends on the flag.
//
// The assertion is scoped to the text setup prints before its own
// "--- status ---" banner (i.e. apply's report only) because status.mjs runs
// its own, unconditional skills reconciliation afterward and would otherwise
// print its own "manifest satisfied" line regardless of whether --skills was
// ever passed to apply — that's exactly what let this probe pass vacuously
// before.
test('setup composes --skills into apply, producing a "skills satisfied" row', async () => {
  const skillsTestRepo = createTestRepo('nortuscc-skills-repo-');
  writeFileSync(join(skillsTestRepo, 'skills-manifest.txt'), '[test-source]\nknown-skill\n');
  execSync('git add .', { cwd: skillsTestRepo, stdio: 'ignore' });
  execSync('git commit -m "add skills manifest"', { cwd: skillsTestRepo, stdio: 'ignore' });

  const { claude, codex, agents, state } = createTestHome();
  // Pre-install the manifest's only named skill so reconcile() reports it as
  // already satisfied, never missing.
  mkdirSync(join(agents, 'known-skill'), { recursive: true });

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    process.env.NORTUSCC_REPO_DIR = skillsTestRepo;

    const { run } = await import('../src/commands/setup.mjs');

    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk) {
      output += chunk.toString();
      return originalWrite.call(this, chunk);
    };

    let code;
    try {
      code = await run([]);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 0);

    const applyReport = output.split('--- status ---')[0];
    assert.match(
      applyReport,
      /^\s*skills\s+satisfied\b/m,
      'apply report should include a "skills satisfied" row, which only appears when setup composed --skills into the applyRun(...) call',
    );
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 5: setup forwards --take-* flags to apply.
//
// A conflict that apply refuses without --take-repo (see Test 2) must
// resolve once setup forwards --take-repo through to the composed
// applyRun([...]) call. If the `...args.filter((a) => a.startsWith('--take-'))`
// spread were dropped, apply would never see the flag and would keep
// refusing -- exit 1, file untouched -- so this only passes when the flag
// genuinely arrives.
test('setup forwards --take-repo to apply, resolving a conflict', async () => {
  const testRepo = createTestRepo('nortuscc-take-repo-');
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    process.env.NORTUSCC_REPO_DIR = testRepo;

    const { run } = await import('../src/commands/setup.mjs');

    // Baseline run establishes the lockfile's recorded hash for CLAUDE.md.
    let code = await run([]);
    assert.equal(code, 0);

    // Genuine conflict: both sides change CLAUDE.md after the baseline.
    writeFileSync(join(claude, 'CLAUDE.md'), '# local change\n');
    writeFileSync(join(testRepo, 'claude', 'CLAUDE.md'), '# repo change\n');
    execSync('git add .', { cwd: testRepo, stdio: 'ignore' });
    execSync('git commit -m "repo change"', { cwd: testRepo, stdio: 'ignore' });

    // Forward --take-repo through setup. Only true when the flag reaches
    // apply: the conflict resolves in the repo's favor instead of being
    // refused.
    code = await run(['--take-repo']);
    assert.equal(code, 0, '--take-repo should resolve the conflict once forwarded to apply');

    const resolved = readFileSync(join(claude, 'CLAUDE.md'), 'utf8');
    assert.equal(
      resolved,
      '# repo change\n',
      'CLAUDE.md should have been overwritten with the repo version, proving --take-repo reached apply',
    );
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 6: setup --dir pointing at an existing directory skips the clone.
//
// The guard `if (dir && !existsSync(dir))` should never attempt a clone when
// --dir already names a real directory. Asserted purely on observable
// behavior: no "cloning" log line, and setup still succeeds using that
// directory directly. `--repo` is deliberately pointed at a bogus,
// unreachable URL so that if the guard regresses and a clone is attempted
// anyway, it fails immediately on git's local "destination already exists"
// check -- before any network I/O -- rather than hanging or reaching out.
test('setup --dir pointing at an existing directory does not attempt to clone', async () => {
  const existingRepo = createTestRepo('nortuscc-existing-dir-');
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    delete process.env.NORTUSCC_REPO_DIR;

    const { run } = await import('../src/commands/setup.mjs');
    const { readLock } = await import('../src/lock.mjs');

    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk) {
      output += chunk.toString();
      return originalWrite.call(this, chunk);
    };

    let code;
    try {
      code = await run(['--dir', existingRepo, '--repo', 'file:///nortuscc-test-should-never-be-cloned']);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 0, 'setup should succeed against the pre-existing directory rather than attempt a clone');
    assert.equal(
      output.includes('cloning'),
      false,
      'setup should not log a clone attempt when --dir already names an existing directory',
    );
    const lock = readLock();
    assert.equal(lock.repo, existingRepo, 'lock.repo should record the pre-existing --dir path directly');
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 7: --dir naming an existing directory that is NOT a checkout.
//
// An interrupted `git clone` leaves the directory behind, so re-running the
// documented onboarding command lands exactly here. setup used to skip the
// clone, announce that path as the repo, and write it into lock.repo — while
// repoRoot() rejected it for having no .git and resolved somewhere else
// entirely (under `npx github:`, the throwaway npx cache). Every later apply,
// capture and push then silently worked against a different repo than the one
// setup had just named.
test('setup --dir naming an existing non-git directory is refused and lock.repo is left alone', async () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'nortuscc-interrupted-clone-'));
  writeFileSync(join(notARepo, 'partial'), 'left behind by an interrupted clone\n');
  const goodRepo = createTestRepo('nortuscc-i1-good-');
  const { claude, codex, agents, state } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedCodex = process.env.NORTUSCC_CODEX_DIR;
  const savedState = process.env.NORTUSCC_STATE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
    process.env.NORTUSCC_CODEX_DIR = codex;
    process.env.NORTUSCC_STATE_DIR = state;
    process.env.NORTUSCC_AGENTS_DIR = agents;
    delete process.env.NORTUSCC_REPO_DIR;

    const { run } = await import('../src/commands/setup.mjs');
    const { readLock, writeLock } = await import('../src/lock.mjs');

    // A previously good record, so overwriting it with the bogus path is visible.
    writeLock({ version: 1, repo: goodRepo, files: {} });

    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = function (chunk) {
      output += chunk.toString();
      return true;
    };

    let code;
    try {
      code = await run(['--dir', notARepo, '--repo', 'file:///nortuscc-test-should-never-be-cloned']);
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(code, 2, 'setup must refuse a --dir that is not a git checkout');
    assert.equal(
      output.includes(`repo: ${notARepo}`),
      false,
      'setup must not announce a path it cannot actually sync from',
    );
    assert.equal(
      readLock().repo,
      goodRepo,
      'a refused setup must leave lock.repo alone rather than poisoning it',
    );
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = savedClaude;
    process.env.NORTUSCC_CODEX_DIR = savedCodex;
    process.env.NORTUSCC_STATE_DIR = savedState;
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});
