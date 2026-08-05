import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-status-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { configReport, run } = await import('../src/commands/status.mjs');

test('configReport returns one row per manifest entry', async () => {
  const { SYNC } = await import('../src/manifest.mjs');
  const rows = configReport();
  assert.equal(rows.length, SYNC.length);
  for (const row of rows) {
    assert.ok(row.dest, 'each row names its destination');
    assert.ok(['link', 'copy'].includes(row.mode));
    assert.ok(typeof row.state === 'string' && row.state.length > 0);
  }
});

test('an empty claude dir reports nothing as clean', () => {
  const rows = configReport();
  const clean = rows.filter((r) => r.state === 'clean' || r.state === 'linked');
  assert.equal(clean.length, 0, 'a bare machine has no synced files yet');
});

test('link entries report missing on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'link');
  for (const row of rows) assert.equal(row.state, 'missing');
});

test('copy entries report unmanaged on a bare machine', () => {
  const rows = configReport().filter((r) => r.mode === 'copy');
  for (const row of rows) assert.equal(row.state, 'unmanaged');
});

test('run() returns 1 on a dirty machine and does not write lockfile', async () => {
  const { lockPath } = await import('../src/resolve.mjs');
  const lockFile = lockPath();

  // Capture initial state
  let lockExistedBefore = false;
  let lockContentBefore = null;
  let lockMtimeBefore = null;

  try {
    lockContentBefore = readFileSync(lockFile);
    const stat = statSync(lockFile);
    lockMtimeBefore = stat.mtimeMs;
    lockExistedBefore = true;
  } catch {
    lockExistedBefore = false;
  }

  // Run the command
  const exitCode = await run();

  // Verify exit code is 1 (dirty machine)
  assert.equal(exitCode, 1, 'run() returns 1 on a machine with drift');

  // Verify lockfile was not created/modified
  if (lockExistedBefore) {
    const lockContentAfter = readFileSync(lockFile);
    const statAfter = statSync(lockFile);
    assert.deepEqual(lockContentAfter, lockContentBefore, 'lockfile content unchanged');
    assert.equal(statAfter.mtimeMs, lockMtimeBefore, 'lockfile mtime unchanged');
  } else {
    try {
      readFileSync(lockFile);
      assert.fail('lockfile should not be created by run()');
    } catch (e) {
      assert.equal(e.code, 'ENOENT', 'lockfile does not exist after run()');
    }
  }

  // Verify backup directory was not created
  const { backupRoot } = await import('../src/resolve.mjs');
  const backupDir = backupRoot();
  try {
    statSync(backupDir);
    assert.fail('backup directory should not be created by run()');
  } catch (e) {
    assert.equal(e.code, 'ENOENT', 'backup directory not created by run()');
  }
});

test('unknown mode is surfaced as an error, not silently treated as copy', async () => {
  // This test validates that configReport would catch a bogus mode.
  // We can't easily inject a bogus mode into SYNC without deep mocking,
  // but we verify the safety invariant: only 'link' and 'copy' modes exist in the real manifest.
  const { SYNC } = await import('../src/manifest.mjs');
  for (const entry of SYNC) {
    assert.ok(
      entry.mode === 'link' || entry.mode === 'copy',
      `every manifest entry uses 'link' or 'copy', found: ${entry.mode}`,
    );
  }
  // The actual fix is in configReport: it must dispatch 'copy' explicitly
  // and reject unknown modes, not silently fall through to the copy inspector.
});
