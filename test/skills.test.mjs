import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseManifest,
  emitManifest,
  groupsFromLock,
  reconcile,
  installArgs,
  brokenSkillLinks,
  installedGroups,
} from '../src/skills.mjs';

const SAMPLE = `# a comment
[Nortus222/agent-skills]
explain

[mattpocock/skills]
teach
grill-me
`;

test('parseManifest groups skills under their source', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(g, [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['teach', 'grill-me'] },
  ]);
});

test('parseManifest ignores comments and blank lines', () => {
  assert.deepEqual(parseManifest('\n# nothing\n\n'), []);
});

test('parseManifest drops names that precede any source header', () => {
  assert.deepEqual(parseManifest('orphan\n[a/b]\nreal\n'), [{ source: 'a/b', skills: ['real'] }]);
});

test('emit then parse round-trips', () => {
  const g = parseManifest(SAMPLE);
  assert.deepEqual(parseManifest(emitManifest(g)), g);
});

test('groupsFromLock derives sources and sorts deterministically', () => {
  const lock = {
    skills: {
      teach: { source: 'mattpocock/skills' },
      explain: { source: 'Nortus222/agent-skills' },
      'grill-me': { source: 'mattpocock/skills' },
      scratch: {},
    },
  };
  assert.deepEqual(groupsFromLock(lock), [
    { source: 'Nortus222/agent-skills', skills: ['explain'] },
    { source: 'mattpocock/skills', skills: ['grill-me', 'teach'] },
  ]);
});

test('reconcile splits into ok, missing, extra, and local', () => {
  const groups = [{ source: 'a/b', skills: ['have', 'want'] }];
  const lock = { skills: { have: { source: 'a/b' }, spare: { source: 'c/d' }, mine: {} } };
  const r = reconcile({ groups, lock, installedNames: ['have', 'spare', 'mine'] });

  assert.deepEqual(r.ok, ['have']);
  assert.deepEqual(r.missing, [{ name: 'want', source: 'a/b' }]);
  assert.deepEqual(r.extra, ['spare']);
  assert.deepEqual(r.local, ['mine']);
});

test('a manifest skill installed from a different source still counts as present', () => {
  const groups = [{ source: 'a/b', skills: ['thing'] }];
  const lock = { skills: { thing: { source: 'z/z' } } };
  const r = reconcile({ groups, lock, installedNames: ['thing'] });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.ok, ['thing']);
});

test('installArgs groups missing skills into one call per source', () => {
  const missing = [
    { name: 'one', source: 'a/b' },
    { name: 'two', source: 'a/b' },
    { name: 'three', source: 'c/d' },
  ];
  assert.deepEqual(installArgs(missing), [
    { source: 'a/b', skills: ['one', 'two'] },
    { source: 'c/d', skills: ['three'] },
  ]);
});

// Fix round 1, finding 4: groupsFromLock and reconcile must agree on what counts
// as "has a recorded source" — a non-string source (e.g. malformed JSON) is not
// a source. Previously groupsFromLock required a string but reconcile only
// checked truthiness, so `{"source": 5}` was excluded from one and called
// `extra` by the other.
test('groupsFromLock and reconcile agree that a non-string source is not a source', () => {
  const lock = { skills: { odd: { source: 5 } } };

  assert.deepEqual(groupsFromLock(lock), []);

  const r = reconcile({ groups: [], lock, installedNames: ['odd'] });
  assert.deepEqual(r.extra, []);
  assert.deepEqual(r.local, ['odd']);
});

// Fix round 1, finding 1: status must flag broken symlinks under
// ~/.claude/skills — skills-check.sh's one behaviour that isn't about the
// manifest. A broken link happens when a skill is removed from
// ~/.agents/skills but its Claude-side link remains.
test('brokenSkillLinks reports symlinks whose target no longer exists', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'nortuscc-claude-skills-'));
  const agentsDir = mkdtempSync(join(tmpdir(), 'nortuscc-agents-skills-'));
  const skillsDir = join(claudeDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  // A live target and a live link to it.
  const liveTarget = join(agentsDir, 'alive');
  mkdirSync(liveTarget, { recursive: true });
  symlinkSync(liveTarget, join(skillsDir, 'alive'), 'dir');

  // A link whose target has been removed.
  const goneTarget = join(agentsDir, 'gone');
  mkdirSync(goneTarget, { recursive: true });
  symlinkSync(goneTarget, join(skillsDir, 'gone'), 'dir');
  rmSync(goneTarget, { recursive: true, force: true });

  // A real directory, not a symlink at all — must be ignored, not reported.
  mkdirSync(join(skillsDir, 'real-dir'), { recursive: true });

  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = claudeDir;
  try {
    assert.deepEqual(brokenSkillLinks(), ['gone']);
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
  }
});

test('brokenSkillLinks reports nothing when ~/.claude/skills does not exist', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'nortuscc-claude-skills-missing-'));
  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = claudeDir;
  try {
    assert.deepEqual(brokenSkillLinks(), []);
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
  }
});

test('brokenSkillLinks sorts deterministically', () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'nortuscc-claude-skills-sort-'));
  const agentsDir = mkdtempSync(join(tmpdir(), 'nortuscc-agents-skills-sort-'));
  const skillsDir = join(claudeDir, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  for (const name of ['zeta', 'alpha', 'mid']) {
    symlinkSync(join(agentsDir, name), join(skillsDir, name), 'dir'); // none of these targets exist
  }

  const origClaudeDir = process.env.NORTUSCC_CLAUDE_DIR;
  process.env.NORTUSCC_CLAUDE_DIR = claudeDir;
  try {
    assert.deepEqual(brokenSkillLinks(), ['alpha', 'mid', 'zeta']);
  } finally {
    process.env.NORTUSCC_CLAUDE_DIR = origClaudeDir;
  }
});

const locked = (skills) => ({ skills });
const meta = (source) => ({ source, sourceUrl: `https://github.com/${source}.git`, skillPath: 'x/SKILL.md' });

test('installedGroups keeps a skill whose folder is present', () => {
  const lock = locked({ tdd: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/r', skills: ['tdd'] }]);
});

test('installedGroups drops a lock entry whose folder is gone', () => {
  // The lock outlives the folder — this is the whole reason the function
  // exists, and why regenerating the manifest from the lock alone is wrong.
  const lock = locked({ tdd: meta('o/r'), ghost: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/r', skills: ['tdd'] }]);
});

test('installedGroups drops a source group that empties', () => {
  const lock = locked({ tdd: meta('o/one'), ghost: meta('o/two') });
  assert.deepEqual(installedGroups(lock, ['tdd']), [{ source: 'o/one', skills: ['tdd'] }]);
});

test('installedGroups includes a newly adopted skill', () => {
  const lock = locked({ tdd: meta('o/r'), wizard: meta('o/r') });
  assert.deepEqual(installedGroups(lock, ['tdd', 'wizard']), [
    { source: 'o/r', skills: ['tdd', 'wizard'] },
  ]);
});

test('installedGroups creates a group for a source new to the manifest', () => {
  const lock = locked({ tdd: meta('o/one'), fresh: meta('o/new') });
  assert.deepEqual(installedGroups(lock, ['tdd', 'fresh']), [
    { source: 'o/new', skills: ['fresh'] },
    { source: 'o/one', skills: ['tdd'] },
  ]);
});

test('installedGroups ignores a skill on disk with no lock entry', () => {
  // Hand-authored: nothing could install it, so it never enters the manifest.
  assert.deepEqual(installedGroups(locked({ tdd: meta('o/r') }), ['tdd', 'mine']), [
    { source: 'o/r', skills: ['tdd'] },
  ]);
});

test('installedGroups on a malformed lock is empty rather than throwing', () => {
  assert.deepEqual(installedGroups(null, ['tdd']), []);
  assert.deepEqual(installedGroups({ skills: 'nope' }, ['tdd']), []);
});
