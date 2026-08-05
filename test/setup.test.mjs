import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a test repo
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

// Create test home
const home = mkdtempSync(join(tmpdir(), 'nortuscc-setup-'));
const claude = join(home, '.claude');
const agents = join(home, '.agents', 'skills');
mkdirSync(claude, { recursive: true });
mkdirSync(agents, { recursive: true });

process.env.NORTUSCC_CLAUDE_DIR = claude;
process.env.NORTUSCC_AGENTS_DIR = agents;
process.env.NORTUSCC_REPO_DIR = testRepo;

const { run } = await import('../src/commands/setup.mjs');
const { readLock, writeLock } = await import('../src/lock.mjs');
const { repoRoot } = await import('../src/resolve.mjs');

test('setup updates lock.repo with the repo root', async () => {
  const code = await run([]);
  assert.equal(code, 0, 'setup should exit 0');
  const lock = readLock();
  assert.equal(lock.repo, testRepo);
});

test('setup returns apply exit code when there is a conflict', async () => {
  // Create a conflict: write a different version of CLAUDE.md locally
  writeFileSync(join(claude, 'CLAUDE.md'), '# local version\n');

  // Run setup without --take-repo to trigger conflict
  const code = await run([]);

  // Should return non-zero due to conflict
  assert.notEqual(code, 0, 'setup should return non-zero on conflict');
});

test('lock.repo is used as fallback when NORTUSCC_REPO_DIR is not set', async () => {
  // First, establish lock.repo with the current testRepo
  delete process.env.NORTUSCC_REPO_DIR;

  // Check that repoRoot() returns lock.repo
  const root = repoRoot();
  assert.equal(root, testRepo, 'repoRoot should fall back to lock.repo');
});

test('stale lock.repo is rejected and falls back to module location', async () => {
  // Write a stale path to lock
  writeLock({ version: 1, repo: '/nonexistent/stale/path', files: {} });

  // repoRoot should not return the stale path
  const root = repoRoot();
  assert.notEqual(root, '/nonexistent/stale/path', 'should not use stale lock.repo');
  assert.ok(existsSync(root), 'fallback path should exist');
});
