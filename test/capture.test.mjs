import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway repo mirroring the manifest, so capture never writes to tracked
// files. Every override must be set before the modules are imported, since
// resolve.mjs reads them at call time but the commands capture paths eagerly.
const home = mkdtempSync(join(tmpdir(), 'nortuscc-capture-'));
const repo = join(home, 'repo');
const claude = join(home, '.claude');

mkdirSync(join(repo, 'claude', 'bin'), { recursive: true });
mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
writeFileSync(join(repo, 'claude', 'bin', 'sp'), 'echo sp\n');
writeFileSync(join(repo, 'claude', 'hooks', 'h.mjs'), '// hook\n');
writeFileSync(join(repo, 'claude', 'settings.json'), '{"a":1}\n');
writeFileSync(join(repo, 'claude', 'CLAUDE.md'), '# from repo\n');
mkdirSync(claude, { recursive: true });

process.env.NORTUSCC_REPO_DIR = repo;
process.env.NORTUSCC_CLAUDE_DIR = claude;
process.env.NORTUSCC_AGENTS_DIR = join(home, 'agents-skills');

const { run: applyRun } = await import('../src/commands/apply.mjs');
const { run: captureRun, capturedPaths } = await import('../src/commands/capture.mjs');
const { lockPath } = await import('../src/resolve.mjs');

const repoClaudeMd = join(repo, 'claude', 'CLAUDE.md');

test('seed the machine from the fixture repo', async () => {
  assert.equal(await applyRun([]), 0);
  assert.equal(readFileSync(join(claude, 'CLAUDE.md'), 'utf8'), '# from repo\n');
});

test('capture with no local changes captures nothing', async () => {
  assert.equal(await captureRun([]), 0);
  assert.deepEqual(capturedPaths(), []);
});

test('capture copies a local edit back into the repo', async () => {
  writeFileSync(join(claude, 'CLAUDE.md'), '# captured edit\n');
  assert.equal(await captureRun([]), 0);
  assert.equal(readFileSync(repoClaudeMd, 'utf8'), '# captured edit\n');
  assert.ok(capturedPaths().includes('claude/CLAUDE.md'));
});

test('capture ignores linked directories entirely', async () => {
  assert.ok(
    !capturedPaths().some((p) => p.includes('bin') || p.includes('hooks')),
    'linked dirs need no capture — the repo IS the live copy',
  );
});

test('a second capture with nothing new captures nothing', async () => {
  assert.equal(await captureRun([]), 0);
  assert.deepEqual(capturedPaths(), []);
});

test('a clean second capture does not rewrite the lockfile at all', async () => {
  const lockBytesBefore = readFileSync(lockPath(), 'utf8');
  const mtimeBefore = statSync(lockPath()).mtimeMs;

  // Force the clock forward so a spurious rewrite would show up as a changed
  // mtime even on filesystems with coarse mtime resolution.
  await new Promise((r) => setTimeout(r, 20));

  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(lockPath(), 'utf8'), lockBytesBefore, 'lockfile bytes must be untouched on a clean run');
  assert.equal(statSync(lockPath()).mtimeMs, mtimeBefore, 'lockfile must not be rewritten on a clean run');
});

test('an unknown mode is reported and left alone, not treated as a conflict', async () => {
  const bogusEntry = { src: 'claude/CLAUDE.md', dest: 'some-file', mode: 'bogus' };
  const lockBytesBefore = readFileSync(lockPath(), 'utf8');

  const code = await captureRun([], [bogusEntry]);

  // BLOCKED like conflict and missing-repo, but not itself a refused conflict:
  // capture cannot remediate a mode it does not understand, so it must not
  // affect the exit code, must not stage anything for that entry, and must
  // not touch the lockfile.
  assert.equal(code, 0);
  assert.deepEqual(capturedPaths(), []);
  assert.equal(readFileSync(lockPath(), 'utf8'), lockBytesBefore, 'an unknown-mode entry must not touch the lockfile');
});

test('the manifest path resolves inside the fixture repo, never the real one', async () => {
  const { manifestPath } = await import('../src/skills.mjs');
  assert.equal(manifestPath(), join(repo, 'skills-manifest.txt'));
});
