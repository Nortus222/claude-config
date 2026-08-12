import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file asserts things about *this* checkout's manifest, so the repo side
// is pinned to this checkout rather than left to repoRoot()'s fallback chain.
// Without the pin, repoRoot() reads the developer's live nortuscc state and
// resolves against whatever repo that records — a different checkout, which
// may not have the files this manifest names.
process.env.NORTUSCC_REPO_DIR = fileURLToPath(new URL('..', import.meta.url));

// Both agent dirs are redirected into a throwaway home. Nothing here writes,
// but resolveEntry() builds real absolute paths from them, and a test that
// prints or asserts on the developer's live ~/.claude or ~/.codex has already
// stopped being hermetic.
const home = mkdtempSync(join(tmpdir(), 'nortuscc-manifest-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
process.env.NORTUSCC_CODEX_DIR = join(home, '.codex');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });
mkdirSync(process.env.NORTUSCC_CODEX_DIR, { recursive: true });

const { SYNC } = await import('../src/manifest.mjs');
const { TARGETS } = await import('../src/targets.mjs');
const { resolveEntry, repoRoot, agentDir } = await import('../src/resolve.mjs');

test('every manifest entry resolves to a path that exists in the repo', () => {
  assert.ok(SYNC.length > 0, 'manifest must not be empty');
  for (const entry of SYNC) {
    const { src } = resolveEntry(entry);
    assert.ok(existsSync(src), `manifest source missing from repo: ${entry.src}`);
  }
});

test('every manifest entry declares a valid mode', () => {
  for (const entry of SYNC) {
    assert.equal(entry.mode, 'copy', `bad mode on ${entry.src}: ${entry.mode}`);
  }
});

// A target-less or misspelled entry is the one shape that could send a write
// somewhere nobody named: agentDir() throws on it rather than defaulting, and
// this keeps the manifest itself from ever containing one.
test('every manifest entry declares a supported target', () => {
  for (const entry of SYNC) {
    assert.ok(TARGETS.includes(entry.target), `bad target on ${entry.src}: ${entry.target}`);
  }
});

test('manifest dest paths are relative and land under their own agent dir', () => {
  for (const entry of SYNC) {
    assert.ok(!entry.dest.startsWith('/'), `dest must be relative: ${entry.dest}`);
    const { dest } = resolveEntry(entry);
    assert.ok(
      dest.startsWith(agentDir(entry.target)),
      `dest escaped the ${entry.target} dir: ${dest}`,
    );
  }
});

// The whole point of tagging entries: a Claude entry must never resolve into
// ~/.codex, and a Codex entry must never resolve into ~/.claude.
test('the two agents never resolve into each other\'s directory', () => {
  for (const entry of SYNC) {
    const { dest } = resolveEntry(entry);
    for (const other of TARGETS) {
      if (other === entry.target) continue;
      assert.ok(!dest.startsWith(agentDir(other)), `${entry.src} landed in the ${other} dir: ${dest}`);
    }
  }
});

test('both supported agents have a managed instruction file', () => {
  assert.deepEqual(SYNC.map((e) => e.target).sort(), [...TARGETS].sort());
});

test('repoRoot points at the repo containing package.json', () => {
  assert.ok(existsSync(`${repoRoot()}/package.json`));
});
