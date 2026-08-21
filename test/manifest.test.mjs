import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
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

// Widened from an equality when merge-keys arrived. The point is unchanged:
// a typo'd mode must not reach a command that would then misdispatch it.
const MODES = new Set(['copy', 'merge-keys']);

test('every manifest entry declares a valid mode', () => {
  for (const entry of SYNC) {
    assert.ok(MODES.has(entry.mode), `bad mode on ${entry.src}: ${entry.mode}`);
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

// A target can now own more than one entry (Claude's instruction file plus
// its settings keys), so this checks coverage — every agent appears — rather
// than a one-to-one count that a second Claude entry would break.
test('both supported agents have a managed instruction file', () => {
  assert.deepEqual([...new Set(SYNC.map((e) => e.target))].sort(), [...TARGETS].sort());
});

test('repoRoot points at the repo containing package.json', () => {
  assert.ok(existsSync(`${repoRoot()}/package.json`));
});

// --- retirement --------------------------------------------------------------

// bin/ and hooks/ were Claude-only wrappers that native skill installation
// replaces, and a link mode with no remaining entry is machinery with nothing
// to drive — neither comes back. settings.json returned narrowly under
// mode: 'merge-keys' (see manifest.mjs), which owns named keys and leaves
// every other key alone; a whole-file copy or link over it would still
// silently replace the machine's permissions and UI preferences, so that
// shape stays forbidden.
test('the sync manifest contains no whole-file settings, helper, hook, or link entry', () => {
  assert.equal(SYNC.some((entry) => entry.mode === 'link'), false);
  assert.equal(SYNC.some((entry) => /bin|hooks/.test(entry.src)), false);
  assert.equal(
    SYNC.some((entry) => /settings/.test(entry.src) && entry.mode !== 'merge-keys'),
    false,
  );
});

test('the retired assets are gone from the repository', () => {
  for (const path of [
    'claude/settings.json',
    'claude/bin/sp',
    'claude/bin/sdd-pkg.sh',
    'claude/hooks/context-mode-cache-heal.mjs',
  ]) {
    assert.equal(existsSync(join(repoRoot(), path)), false, `${path} must no longer be tracked`);
  }
});

// The managed instruction file is what every agent reads at startup. Leaving
// an instruction to run a wrapper this repo no longer ships would send every
// future session at a path that does not exist.
test('Claude instructions do not name retired helpers', () => {
  const text = readFileSync(join(repoRoot(), 'claude', 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(text, /sdd-pkg|\.claude\/bin\/sp/);
});

test('Codex instructions do not name retired helpers either', () => {
  const text = readFileSync(join(repoRoot(), 'codex', 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(text, /sdd-pkg|\.claude\/bin\/sp/);
});
