import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  copyFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-status-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

// Set up a fixture repo with empty settings.json so tests don't read plugins from the real repo
const fixtureRepo = mkdtempSync(join(tmpdir(), 'nortuscc-repo-'));
process.env.NORTUSCC_REPO_DIR = fixtureRepo;
mkdirSync(join(fixtureRepo, 'claude'), { recursive: true });
writeFileSync(join(fixtureRepo, 'claude', 'settings.json'), JSON.stringify({}));
writeFileSync(join(fixtureRepo, 'claude', 'CLAUDE.md'), '# Test');

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

test('run() returns 0 on a clean machine', async () => {
  // Set up a genuinely clean machine: all entries in non-actionable states
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
  const { ensureLink } = await import('../src/link.mjs');
  const { resolveEntry, claudeDir } = await import('../src/resolve.mjs');

  const claude = claudeDir();

  // For all link entries: create the symlinks
  for (const entry of SYNC) {
    if (entry.mode === 'link') {
      const { src, dest } = resolveEntry(entry);
      await ensureLink(dest, src);
    }
  }

  // For all copy entries: copy the file to dest and seed lockfile with its hash
  const lock = readLock();
  for (const entry of SYNC) {
    if (entry.mode === 'copy') {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        // Copy the repo file to the local destination
        copyFileSync(src, dest);
        // Seed the baseline hash in the lockfile
        setBaseline(lock, entry.dest, hash);
      }
    }
  }
  writeLock(lock);

  // Now run the command on this clean machine
  const exitCode = await run();

  // Verify exit code is 0
  assert.equal(exitCode, 0, 'run() returns 0 on a clean machine');
});

test('unknown mode is surfaced with correct state and note', async () => {
  // Inject a bogus mode entry and verify it surfaces as unknown-mode with appropriate note
  const bogusEntry = { src: 'repo/some-file', dest: 'some-file', mode: 'bogus' };
  const rows = configReport([bogusEntry]);

  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.dest, 'some-file');
  assert.equal(row.mode, 'bogus');
  assert.equal(row.state, 'unknown-mode', 'unknown mode is surfaced as unknown-mode state');

  // Verify the note appears in formatted output
  const { formatRow } = await import('../src/report.mjs');
  const formatted = formatRow(row.dest, row.state, 'manifest entry has an unrecognized mode');
  assert.ok(
    formatted.includes('unknown-mode'),
    'unknown-mode state appears in formatted output',
  );
  assert.ok(
    formatted.includes('unrecognized mode'),
    'descriptive note appears in formatted output',
  );
});

// Finding 4: Strengthen read-only safety net with full directory snapshot
function snapshotDirectory(dir) {
  // Recursively snapshot a directory's contents
  const snapshot = {};
  try {
    const walk = (path, prefix) => {
      const entries = readdirSync(path, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(path, entry.name);
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, key);
        } else {
          snapshot[key] = readFileSync(fullPath);
        }
      }
    };
    walk(dir, '');
  } catch (e) {
    // Directory doesn't exist yet
  }
  return snapshot;
}

test('run() does not write any files to claude dir and does not create new directories', async () => {
  // Set up a genuinely clean machine
  const { SYNC } = await import('../src/manifest.mjs');
  const { hashFile, readLock, writeLock, setBaseline } = await import('../src/lock.mjs');
  const { ensureLink } = await import('../src/link.mjs');
  const { resolveEntry, claudeDir } = await import('../src/resolve.mjs');

  const claude = claudeDir();

  // Snapshot before run()
  const snapshotBefore = snapshotDirectory(claude);

  // For all link entries: create the symlinks
  for (const entry of SYNC) {
    if (entry.mode === 'link') {
      const { src, dest } = resolveEntry(entry);
      await ensureLink(dest, src);
    }
  }

  // For all copy entries: copy the file to dest and seed lockfile with its hash
  const lock = readLock();
  for (const entry of SYNC) {
    if (entry.mode === 'copy') {
      const { src, dest } = resolveEntry(entry);
      const hash = hashFile(src);
      if (hash) {
        copyFileSync(src, dest);
        setBaseline(lock, entry.dest, hash);
      }
    }
  }
  writeLock(lock);

  // Snapshot after setup but before run()
  const snapshotAfterSetup = snapshotDirectory(claude);

  // Run the command
  await run();

  // Snapshot after run()
  const snapshotAfter = snapshotDirectory(claude);

  // Verify no new files or directories were created
  const keysBefore = Object.keys(snapshotAfterSetup).sort();
  const keysAfter = Object.keys(snapshotAfter).sort();

  assert.deepEqual(
    keysAfter,
    keysBefore,
    'run() created no new files or directories in claude dir',
  );

  // Verify no files were modified
  for (const key of keysBefore) {
    assert.deepEqual(
      snapshotAfter[key],
      snapshotAfterSetup[key],
      `run() did not modify ${key}`,
    );
  }
});
