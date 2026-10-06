import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCKED, PORTED, VERBS } from '../bin/commands.mjs';

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

test('no verb is routed through the legacy whole-command lock', () => {
  assert.deepEqual(LOCKED, []);
  assert.ok(VERBS.every((verb) => PORTED.includes(verb)));
});

// setup takes apply.lock only through the executor, per phase, so a live holder cannot stop it
// from reporting a usage error, and the holder's lock is left as it was.
test('setup holds no lock of its own while another live run holds apply.lock', () => {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'apply.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const result = run('setup', '--target', 'bogus');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--target must be claude\|codex\|all/);
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
  } finally {
    rmSync(lock, { force: true });
  }
});

test('a ported command runs its TypeScript module', () => {
  const result = run('update', '--check', '--yes');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--check is mutually exclusive/);
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
