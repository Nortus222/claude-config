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
  skillExposure,
  installedGroups,
} from '../src/skills.mjs';
import * as skillsModule from '../src/skills.mjs';

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

// --- agent exposure ----------------------------------------------------------
//
// There is one shared skill store, so "installed" and "usable by this agent"
// are different questions. The old scan for broken symlinks under
// ~/.claude/skills answered the second question for Claude alone and by
// guessing at a layout the installer owns; asking the installer per agent
// answers it for both.

test('exposure reports a canonical skill missing from one selected agent', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': ['review'], codex: [] },
  });
  assert.deepEqual(result.partial, [{ name: 'review', missingAgents: ['codex'] }]);
});

test('a skill every selected agent can see is exposed, not partial', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': ['review'], codex: ['review'] },
  });
  assert.deepEqual(result.exposed, ['review']);
  assert.deepEqual(result.partial, []);
  assert.deepEqual(result.missing, []);
});

test('a skill no selected agent can see is missing, not partial', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': [], codex: [] },
  });
  assert.deepEqual(result.missing, ['review']);
  assert.deepEqual(result.partial, []);
});

// Only the selected agents count. A skill Codex cannot see is not a problem
// for `--target claude`, and reporting it as one would make a Claude-only run
// permanently dirty.
test('an unselected agent never makes a skill partial', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code'],
    list: { 'claude-code': ['review'], codex: [] },
  });
  assert.deepEqual(result.exposed, ['review']);
  assert.deepEqual(result.partial, []);
});

test('every missing agent is named, not just the first', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': [], codex: [] },
  });
  assert.deepEqual(result.missing, ['review']);

  const oneOfThree = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': ['review'], codex: [] },
  });
  assert.deepEqual(oneOfThree.partial[0].missingAgents, ['codex']);
});

// An agent the installer returned nothing for is not an agent that has
// nothing: it may be an agent the inspection failed to read. That distinction
// belongs to the caller of the list command, so exposure itself treats an
// absent key as an empty list and lets the runner report the read failure.
test('an agent absent from the list reads as seeing nothing', () => {
  const result = skillExposure({
    names: ['review'], agents: ['claude-code', 'codex'],
    list: { 'claude-code': ['review'] },
  });
  assert.deepEqual(result.partial, [{ name: 'review', missingAgents: ['codex'] }]);
});

test('exposure with no names reports three empty lists', () => {
  const result = skillExposure({ names: [], agents: ['codex'], list: { codex: ['x'] } });
  assert.deepEqual(result, { exposed: [], partial: [], missing: [] });
});

// The Claude-only link scan guessed at a layout the installer owns, and
// answered only for Claude. Leaving it exported alongside the per-agent
// inspection would leave two disagreeing sources of truth.
test('the Claude-only broken-link scan is gone, not merely unused', () => {
  assert.ok(!('brokenSkillLinks' in skillsModule));
  assert.ok(!('claudeSkillsDir' in skillsModule));
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
