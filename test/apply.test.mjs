import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-apply-'));
const claude = join(home, '.claude');
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { run, summarizeSkillsInstall } = await import('../src/commands/apply.mjs');
const { SYNC } = await import('../src/manifest.mjs');
const { resolveEntry } = await import('../src/resolve.mjs');
const { readLock } = await import('../src/lock.mjs');
const { lockPath, backupRoot } = await import('../src/resolve.mjs');

test('apply on a bare machine links dirs and copies files', async () => {
  const code = await run([]);
  assert.equal(code, 0);

  for (const entry of SYNC) {
    const { dest } = resolveEntry(entry);
    assert.ok(existsSync(dest), `${entry.dest} should exist after apply`);
  }
});

test('apply records a baseline for every copied file', async () => {
  const lock = readLock();
  for (const entry of SYNC.filter((e) => e.mode === 'copy')) {
    assert.ok(lock.files[entry.dest], `no baseline recorded for ${entry.dest}`);
    assert.match(lock.files[entry.dest].hash, /^sha256:/);
  }
});

test('apply on a bare machine creates no backup directory (nothing needed backing up)', () => {
  assert.equal(existsSync(backupRoot()), false, 'a first apply with no pre-existing files must not touch backups/');
});

test('apply is idempotent — a second run changes nothing and still exits 0', async () => {
  const before = readFileSync(join(claude, 'CLAUDE.md'), 'utf8');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), before);
});

test('a clean second run does not rewrite the lockfile at all', async () => {
  const lockBytesBefore = readFileSync(lockPath(), 'utf8');
  const mtimeBefore = statSync(lockPath()).mtimeMs;

  // Force the clock forward so a spurious rewrite would show up as a changed
  // mtime even on filesystems with coarse mtime resolution.
  await new Promise((r) => setTimeout(r, 20));

  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(lockPath(), 'utf8'), lockBytesBefore, 'lockfile bytes must be untouched on a clean run');
  assert.equal(statSync(lockPath()).mtimeMs, mtimeBefore, 'lockfile must not be rewritten on a clean run');
});

test('apply leaves a local-only edit alone and exits 0', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# edited locally\n');
  const code = await run([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(f, 'utf8'), '# edited locally\n', 'apply must not clobber a local edit');
});

test('apply --take-repo overwrites the local edit', async () => {
  const f = join(claude, 'CLAUDE.md');
  writeFileSync(f, '# still edited\n');
  const code = await run(['--take-repo']);
  assert.equal(code, 0);
  assert.notEqual(readFileSync(f, 'utf8'), '# still edited\n');
});

test('an unknown mode is reported and left alone, not treated as a conflict', async () => {
  const bogusEntry = { src: 'claude/CLAUDE.md', dest: 'some-file', mode: 'bogus' };
  const lockBytesBefore = readFileSync(lockPath(), 'utf8');

  const code = await run([], [bogusEntry]);

  // BLOCKED like conflict and missing-repo, but not itself a refused conflict:
  // apply cannot remediate a mode it does not understand, so it must not
  // affect the exit code, must not write anything for that entry, and must
  // not touch the lockfile.
  assert.equal(code, 0);
  assert.equal(existsSync(join(claude, 'some-file')), false, 'apply must not write an entry with an unknown mode');
  assert.equal(readFileSync(lockPath(), 'utf8'), lockBytesBefore, 'an unknown-mode entry must not touch the lockfile');
});

// Fix round 2, finding 1: installGroups' per-source results were discarded,
// so a failed install still reported "installed" and exited 0. These tests
// drive the reporting logic directly with crafted results — never through a
// real install — matching the reviewer's guidance that dryRun already covers
// installGroups' own wiring and no injectable-spawn seam is needed here.
test('summarizeSkillsInstall reports every skill installed when every source succeeds', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'a/b' },
    { name: 'three', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: true },
    { source: 'c/d', ok: true },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 0);
  assert.equal(summary.lines.length, 1);
  assert.match(summary.lines[0], /installed/);
  assert.match(summary.lines[0], /one/);
  assert.match(summary.lines[0], /two/);
  assert.match(summary.lines[0], /three/);
});

test('summarizeSkillsInstall reports every skill failed when every source fails, and counts them', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: false },
    { source: 'c/d', ok: false },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 2);
  assert.equal(summary.lines.length, 1);
  assert.match(summary.lines[0], /failed/);
});

test('summarizeSkillsInstall keeps a partial failure visible as partial — not collapsed either way', () => {
  const missing = [
    { name: 'good', source: 'a/b' },
    { name: 'bad', source: 'c/d' },
  ];
  const results = [
    { source: 'a/b', ok: true },
    { source: 'c/d', ok: false },
  ];
  const summary = summarizeSkillsInstall(missing, results);
  assert.equal(summary.failed, 1);
  // Both an "installed" row (for the source that succeeded) and a "failed"
  // row (for the source that didn't) must be present — a partial failure is
  // neither total success nor total failure.
  assert.equal(summary.lines.length, 2);
  const joined = summary.lines.join('\n');
  assert.match(joined, /installed/);
  assert.match(joined, /good/);
  assert.match(joined, /failed/);
  assert.match(joined, /bad/);
});

test('summarizeSkillsInstall with nothing missing reports nothing and fails nothing', () => {
  const summary = summarizeSkillsInstall([], []);
  assert.deepEqual(summary, { lines: [], failed: 0 });
});
