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

// Fix round 1, finding 1: apply's --take-local hole (see apply.test.mjs) has
// a mirror image here — capture's --take-repo was parsed but never wired to
// captureCopy's `force` (only --take-local was), so it was silently accepted
// and did nothing. capture only ever moves machine -> repo, so "keep the
// repo version" is not a resolution capture can perform at all; it must
// refuse the flag outright and point at apply, not attempt and fail silently.
test('capture --take-repo is refused outright — the flag does not fit capture\'s direction', async () => {
  const lockBytesBefore = readFileSync(lockPath(), 'utf8');
  let stderr = '';
  const originalError = console.error;
  console.error = (msg) => { stderr += String(msg) + '\n'; };
  let code;
  try {
    code = await captureRun(['--take-repo']);
  } finally {
    console.error = originalError;
  }
  assert.notEqual(code, 0, '--take-repo must not be silently accepted by capture');
  assert.match(stderr, /apply --take-repo/, 'must point the user at the command that actually supports it');
  assert.equal(readFileSync(lockPath(), 'utf8'), lockBytesBefore, 'a refused flag must not touch the lockfile');
  assert.deepEqual(capturedPaths(), [], 'a refused flag must not stage anything for commit');
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

// Fix round 2, finding 2: the fixture above never populates a skill lock, so
// the manifest-write and shrink-guard branches capture.mjs added were never
// actually exercised by the suite (the whole block could be deleted with all
// tests still green). These tests populate .skill-lock.json — a sibling of
// NORTUSCC_AGENTS_DIR's directory, per skills.mjs's SKILL_LOCK() — to drive
// both branches for real, still entirely inside the fixture home.
const skillLockPath = join(home, '.skill-lock.json');
const { manifestPath, parseManifest } = await import('../src/skills.mjs');

test('capture regenerates the manifest from the skill lock, grouped by source, excluding a local skill', async () => {
  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        beta: { source: 'foo/bar' },
        gamma: { source: 'baz/qux' },
        // No recorded source: authored directly in ~/.agents/skills. Nothing
        // could install it, so it must never land in the manifest.
        homegrown: {},
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);

  const written = readFileSync(manifestPath(), 'utf8');
  assert.deepEqual(parseManifest(written), [
    { source: 'baz/qux', skills: ['gamma'] },
    { source: 'foo/bar', skills: ['alpha', 'beta'] },
  ]);
  assert.ok(!written.includes('homegrown'), 'a skill with no recorded source must never be written to the manifest');
  assert.ok(capturedPaths().includes('skills-manifest.txt'), 'a manifest write must be staged for commit');
});

test('capture refuses to shrink the manifest when the lock has fewer skills than the manifest already has', async () => {
  const before = readFileSync(manifestPath(), 'utf8');

  // Drop 'beta': the regenerated manifest would now have fewer skills than
  // the 3 already written above.
  writeFileSync(
    skillLockPath,
    JSON.stringify({
      skills: {
        alpha: { source: 'foo/bar' },
        gamma: { source: 'baz/qux' },
      },
    }),
    'utf8',
  );

  const code = await captureRun([]);
  assert.equal(code, 0);
  assert.equal(readFileSync(manifestPath(), 'utf8'), before, 'a shrinking manifest must be refused, not written');
  assert.ok(!capturedPaths().includes('skills-manifest.txt'), 'a refused write must not be staged for commit');
});

test('--allow-shrink permits writing a smaller manifest', async () => {
  const code = await captureRun(['--allow-shrink']);
  assert.equal(code, 0);

  const written = parseManifest(readFileSync(manifestPath(), 'utf8'));
  assert.deepEqual(written, [
    { source: 'baz/qux', skills: ['gamma'] },
    { source: 'foo/bar', skills: ['alpha'] },
  ]);
  assert.ok(capturedPaths().includes('skills-manifest.txt'));
});
