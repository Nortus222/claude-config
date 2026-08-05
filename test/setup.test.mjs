import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-setup-'));
const claude = join(home, '.claude');
const agents = join(home, '.agents', 'skills');
mkdirSync(claude, { recursive: true });
mkdirSync(agents, { recursive: true });

// Test repo: a minimal local git repo with all manifest entries, not cloned from network
const testRepo = mkdtempSync(join(tmpdir(), 'nortuscc-setup-repo-'));
execSync('git init', { cwd: testRepo, stdio: 'ignore' });
execSync('git config user.email "test@example.com"', { cwd: testRepo, stdio: 'ignore' });
execSync('git config user.name "Test"', { cwd: testRepo, stdio: 'ignore' });
mkdirSync(join(testRepo, 'claude', 'bin'), { recursive: true });
mkdirSync(join(testRepo, 'claude', 'hooks'), { recursive: true });
writeFileSync(join(testRepo, 'claude', 'CLAUDE.md'), '# test\n');
writeFileSync(join(testRepo, 'claude', 'settings.json'), '{"version": 1}\n');
writeFileSync(join(testRepo, 'claude', 'bin', '.gitkeep'), '');
writeFileSync(join(testRepo, 'claude', 'hooks', '.gitkeep'), '');
execSync('git add .', { cwd: testRepo, stdio: 'ignore' });
execSync('git commit -m "initial"', { cwd: testRepo, stdio: 'ignore' });

process.env.NORTUSCC_CLAUDE_DIR = claude;
process.env.NORTUSCC_AGENTS_DIR = agents;
process.env.NORTUSCC_REPO_DIR = testRepo;

const { run } = await import('../src/commands/setup.mjs');
const { readLock } = await import('../src/lock.mjs');

test('setup with no arguments records the current repo in lock', async () => {
  const code = await run([]);
  assert.equal(code, 0, 'setup should exit 0 on success');

  const lock = readLock();
  assert.equal(lock.repo, testRepo, 'lock.repo should be set to the repo root');
});

test('setup records the repo root even with --take-* flags', async () => {
  const code = await run(['--take-repo']);
  assert.equal(code, 0, 'setup with --take-repo should exit 0');

  const lock = readLock();
  assert.equal(lock.repo, testRepo, 'lock.repo should be set even with --take-repo');
});

test('setup is idempotent — a second run returns 0 and does not change the lock', async () => {
  const lockBefore = readFileSync(join(claude, '.nortuscc-lock.json'), 'utf8');
  const code = await run([]);
  assert.equal(code, 0, 'second run should exit 0');

  const lockAfter = readFileSync(join(claude, '.nortuscc-lock.json'), 'utf8');
  assert.equal(lockBefore, lockAfter, 'lock should not change on idempotent run');
});

test('setup with --dir pointing to an existing directory does not clone', async () => {
  const existingDir = mkdtempSync(join(tmpdir(), 'nortuscc-existing-'));
  // Create a minimal git repo in the existing directory
  execSync('git init', { cwd: existingDir, stdio: 'ignore' });

  const code = await run(['--dir', existingDir]);
  assert.equal(code, 0, 'setup with existing --dir should exit 0');

  const lock = readLock();
  assert.equal(lock.repo, existingDir, 'lock.repo should be set to the --dir path');
});
