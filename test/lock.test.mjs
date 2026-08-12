import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-lock-'));
const dir = join(home, '.claude');
mkdirSync(dir, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = dir;
// The complete override for where machine state lives. Every test below must
// stay inside it: the real state file is the record of what this machine has
// synced, and a test that rewrites it corrupts the developer's own machine.
process.env.NORTUSCC_STATE_DIR = join(home, 'state');

const { hashFile, hashText, readLock, writeLock, setBaseline, migrateLegacyState } =
  await import('../src/lock.mjs');
const { statePath, stateRoot, legacyLockPath } = await import('../src/resolve.mjs');

function clearState() {
  rmSync(statePath(), { force: true });
}

test('hashText is stable and prefixed', () => {
  const h = hashText('hello');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, hashText('hello'));
});

test('CRLF and LF hash identically', () => {
  assert.equal(hashText('a\r\nb\r\n'), hashText('a\nb\n'));
});

test('different content hashes differently', () => {
  assert.notEqual(hashText('a'), hashText('b'));
});

test('hashFile returns null for a missing file', () => {
  assert.equal(hashFile(join(dir, 'nope.txt')), null);
});

test('hashFile matches hashText for the same content', () => {
  const f = join(dir, 'x.txt');
  writeFileSync(f, 'contents\n');
  assert.equal(hashFile(f), hashText('contents\n'));
});

test('state path uses the explicit test root', () => {
  assert.equal(statePath(), join(home, 'state', 'state.json'));
  assert.equal(stateRoot(), join(home, 'state'));
});

// The whole point of moving state out of ~/.claude: nortuscc configures Codex
// too, so its own bookkeeping cannot live inside one of the agents it manages.
test('state lives outside every agent directory', () => {
  const saved = process.env.NORTUSCC_STATE_DIR;
  delete process.env.NORTUSCC_STATE_DIR;
  try {
    const expected =
      process.platform === 'win32'
        ? join(process.env.APPDATA ?? '', 'nortuscc')
        : join(homedir(), '.config', 'nortuscc');
    assert.equal(stateRoot(), expected);
    assert.ok(!stateRoot().includes(join(homedir(), '.claude')));
    assert.ok(!stateRoot().includes(join(homedir(), '.codex')));
  } finally {
    process.env.NORTUSCC_STATE_DIR = saved;
  }
});

test('the legacy lock path still names the old location under the Claude dir', () => {
  assert.equal(legacyLockPath(), join(dir, '.nortuscc-lock.json'));
});

test('readLock returns an empty lock when no file exists', () => {
  clearState();
  const lock = readLock();
  assert.equal(lock.version, 1);
  assert.deepEqual(lock.files, {});
});

test('readLock survives a corrupt state file', () => {
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(statePath(), '{ not json');
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  clearState();
});

test('writeLock then readLock round-trips', () => {
  clearState();
  const lock = readLock();
  setBaseline(lock, 'claude:CLAUDE.md', hashText('v1'));
  lock.repo = '/some/repo';
  writeLock(lock);

  const again = readLock();
  assert.equal(again.repo, '/some/repo');
  assert.equal(again.files['claude:CLAUDE.md'].hash, hashText('v1'));
  assert.match(again.files['claude:CLAUDE.md'].appliedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('writeLock creates the state root when it does not exist yet', () => {
  rmSync(stateRoot(), { recursive: true, force: true });
  const lock = { version: 1, repo: '/r', files: {} };
  writeLock(lock);
  assert.ok(existsSync(statePath()));
});

// A half-written state file reads as corrupt, which degrades every managed
// file to 'unmanaged' and makes the next apply back up and overwrite files it
// had already reconciled. The write goes to a sibling and renames into place.
test('writeLock leaves no temporary file behind', () => {
  clearState();
  const lock = readLock();
  lock.repo = '/some/repo';
  writeLock(lock);
  const strays = readdirSync(stateRoot()).filter((n) => n !== 'state.json');
  assert.deepEqual(strays, [], 'the atomic write must not leave a temp file in the state root');
});

test('readLock rejects valid JSON with string files field', () => {
  writeFileSync(statePath(), JSON.stringify({ version: 1, repo: null, files: 'not-an-object' }));
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  assert.doesNotThrow(() => setBaseline(lock, 'x', hashText('test')));
  clearState();
});

test('readLock rejects valid JSON with array files field', () => {
  writeFileSync(statePath(), JSON.stringify({ version: 1, repo: null, files: [1, 2, 3] }));
  const lock = readLock();
  assert.deepEqual(lock.files, {});
  assert.doesNotThrow(() => setBaseline(lock, 'y', hashText('test')));
  clearState();
});

// --- migration ---------------------------------------------------------------

const LEGACY = JSON.stringify({
  version: 1,
  repo: '/legacy/repo',
  files: {
    'CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-01-01T00:00:00.000Z' },
    'settings.json': { hash: 'sha256:b', appliedAt: '2026-01-01T00:00:00.000Z' },
  },
});

test('legacy migration imports repo and Claude baseline but drops settings', () => {
  clearState();
  writeFileSync(legacyLockPath(), LEGACY);

  const result = migrateLegacyState();

  assert.equal(result.migrated, true);
  assert.equal(result.state.repo, '/legacy/repo');
  assert.deepEqual(Object.keys(result.state.files), ['claude:CLAUDE.md']);
  assert.equal(result.state.files['claude:CLAUDE.md'].hash, 'sha256:a');
  assert.ok(existsSync(legacyLockPath()));
});

// The old lock is the only record a machine has if the migration turns out to
// be wrong, and settings.json management is being retired rather than moved —
// so nothing about the old file may change, not even its bytes.
test('migration leaves the old lock byte-for-byte intact', () => {
  clearState();
  writeFileSync(legacyLockPath(), LEGACY);
  const before = readFileSync(legacyLockPath());

  migrateLegacyState();

  assert.deepEqual(readFileSync(legacyLockPath()), before);
});

test('migration writes the neutral state file so it happens only once', () => {
  clearState();
  writeFileSync(legacyLockPath(), LEGACY);

  migrateLegacyState();
  assert.ok(existsSync(statePath()));

  // A second run must not re-import: by now the neutral state is authoritative,
  // and re-importing would resurrect baselines the user has since moved on from.
  writeFileSync(statePath(), JSON.stringify({ version: 1, repo: '/moved/on', files: {} }));
  const second = migrateLegacyState();
  assert.equal(second.migrated, false);
  assert.equal(second.state.repo, '/moved/on');
  assert.deepEqual(second.state.files, {});
});

test('readLock performs the migration on first use', () => {
  clearState();
  writeFileSync(legacyLockPath(), LEGACY);

  const lock = readLock();
  assert.equal(lock.repo, '/legacy/repo');
  assert.deepEqual(Object.keys(lock.files), ['claude:CLAUDE.md']);
});

test('migration with no legacy lock is a no-op that yields an empty state', () => {
  clearState();
  rmSync(legacyLockPath(), { force: true });

  const result = migrateLegacyState();
  assert.equal(result.migrated, false);
  assert.deepEqual(result.state.files, {});
  assert.equal(result.state.repo, null);
  assert.equal(existsSync(statePath()), false, 'nothing to migrate must not create a state file');
});

test('a corrupt legacy lock is skipped rather than throwing', () => {
  clearState();
  writeFileSync(legacyLockPath(), '{ not json');

  const result = migrateLegacyState();
  assert.equal(result.migrated, false);
  assert.deepEqual(result.state.files, {});
});

// Every key other than CLAUDE.md described something nortuscc no longer
// manages. Importing them would leave permanent baselines for files no
// manifest entry will ever reconcile.
test('migration drops every legacy key that is not the Claude instruction file', () => {
  clearState();
  writeFileSync(
    legacyLockPath(),
    JSON.stringify({
      version: 1,
      repo: '/legacy/repo',
      files: {
        'CLAUDE.md': { hash: 'sha256:a', appliedAt: '2026-01-01T00:00:00.000Z' },
        'settings.json': { hash: 'sha256:b', appliedAt: '2026-01-01T00:00:00.000Z' },
        bin: { hash: 'sha256:c', appliedAt: '2026-01-01T00:00:00.000Z' },
        hooks: { hash: 'sha256:d', appliedAt: '2026-01-01T00:00:00.000Z' },
      },
    }),
  );

  const result = migrateLegacyState();
  assert.deepEqual(Object.keys(result.state.files), ['claude:CLAUDE.md']);
});
