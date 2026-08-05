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
  mkdirSync(join(repo, 'claude', 'bin'), { recursive: true });
  mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
  writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# test\n');
  writeFileSync(join(repo, 'claude', 'settings.json'), '{"version": 1}\n');
  writeFileSync(join(repo, 'claude', 'bin', '.gitkeep'), '');
  writeFileSync(join(repo, 'claude', 'hooks', '.gitkeep'), '');
  execSync('git add .', { cwd: repo, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: repo, stdio: 'ignore' });
  return repo;
}

// Helper: create a test home
function createTestHome() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-setup-'));
  const claude = join(home, '.claude');
  const agents = join(home, '.agents', 'skills');
  mkdirSync(claude, { recursive: true });
  mkdirSync(agents, { recursive: true });
  return { home, claude, agents };
}

// Test 1: setup updates lock.repo
test('setup updates lock.repo with the repo root', async () => {
  const testRepo = createTestRepo();
  const { claude, agents } = createTestHome();

  // Save and clear env
  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
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
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 2: Probe B — when apply returns non-zero, status should not run
test('when apply returns non-zero, setup short-circuits before status (no banner)', async () => {
  const testRepo = createTestRepo();
  const { claude, agents } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
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
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});

// Test 3: lock.repo fallback
test('lock.repo is used as fallback', async () => {
  const testRepo = createTestRepo();
  const { claude, agents } = createTestHome();

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
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

  const { claude, agents } = createTestHome();
  // Pre-install the manifest's only named skill so reconcile() reports it as
  // already satisfied, never missing.
  mkdirSync(join(agents, 'known-skill'), { recursive: true });

  const savedClaude = process.env.NORTUSCC_CLAUDE_DIR;
  const savedAgents = process.env.NORTUSCC_AGENTS_DIR;
  const savedRepo = process.env.NORTUSCC_REPO_DIR;

  try {
    process.env.NORTUSCC_CLAUDE_DIR = claude;
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
    process.env.NORTUSCC_AGENTS_DIR = savedAgents;
    process.env.NORTUSCC_REPO_DIR = savedRepo;
  }
});
