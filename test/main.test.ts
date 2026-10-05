import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTED } from '../bin/commands.mjs';

const bin = fileURLToPath(new URL('../bin/nortuscc.mjs', import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), 'nortuscc-main-'));
const run = (...args: string[]) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NORTUSCC_STATE_DIR: stateDir } });

test('--help prints usage without loading any command', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^nortuscc — keep this machine in agreement with claude-config/);
});

test('an unknown command exits 2 with usage', () => {
  const result = run('frobnicate');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'frobnicate'/);
});

test('a ported command reaches its TypeScript module through main.ts', () => {
  assert.ok(PORTED.includes('uninstall'));
  const result = run('uninstall', '--target', 'all');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Re-run with --yes to confirm/);
});

test('a legacy state writer is refused while another live run holds apply.lock', () => {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'apply.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const result = run('push');
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`another nortuscc run \\(pid ${process.pid}\\) holds`));
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  } finally {
    rmSync(lock, { force: true });
  }
});

test('a legacy state writer takes over a dead holder and releases the lock', () => {
  const lock = join(stateDir, 'apply.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-01-01T00:00:00.000Z' }));
  const result = run('push');
  assert.equal(result.status, 2); // push without -m is a usage error, reached only once the lock is held
  assert.equal(existsSync(lock), false);
});

test('an unported command reaches its legacy module through main.ts', () => {
  const state = mkdtempSync(join(tmpdir(), 'nortuscc-main-'));
  const result = spawnSync(process.execPath, [bin, 'apply', '--take-local'], {
    encoding: 'utf8',
    env: { ...process.env, NORTUSCC_STATE_DIR: state, NORTUSCC_CLAUDE_DIR: join(state, 'claude') },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--take-local has no effect on apply/);
});
