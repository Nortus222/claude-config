import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/nortuscc.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

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

test('an unported command reaches its legacy module through main.ts', () => {
  const result = run('uninstall', '--target', 'all');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Re-run with --yes to confirm/);
});

test('a ported command runs its TypeScript module', () => {
  const result = run('update', '--check', '--yes');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--check is mutually exclusive/);
});
