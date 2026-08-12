import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-update-'));
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

// Redirect the skills dir too, the same way test/status.test.mjs does, so a
// future test that forgets to override `preserve` fails loudly on a missing
// fixture instead of silently reading the real ~/.agents/skills.
process.env.NORTUSCC_AGENTS_DIR = join(claude, '.agents', 'skills');
// backupDir() now resolves under the state root rather than ~/.claude.
process.env.NORTUSCC_STATE_DIR = join(claude, 'state');

// Task 8 adds manifest handling to update.mjs (readSkillsManifest/manifestPath
// are not dependency-injected — only writeManifest is). Without this, `before`
// in manifestOutcome would be computed from this repo's own real
// skills-manifest.txt, the same real-file leak test/status.test.mjs's
// fixtureRepo pattern exists to prevent.
const fixtureRepo = mkdtempSync(join(tmpdir(), 'nortuscc-update-repo-'));
process.env.NORTUSCC_REPO_DIR = fixtureRepo;

const { run, exitCode, reportLines, parseFlags, manifestOutcome } = await import('../src/commands/update.mjs');
const { backupDir } = await import('../src/backup.mjs');

const URL = 'https://github.com/o/r.git';
const entry = (path, hash) => ({
  source: 'o/r', sourceUrl: URL, skillPath: `${path}/SKILL.md`, skillFolderHash: hash,
});

// Two installed skills: `stale` has moved upstream, `fresh` has not.
function baseDeps(overrides = {}) {
  return {
    readLock: () => ({ skills: { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') } }),
    installed: () => ['fresh', 'stale'],
    inspectSource: async () => ({ trees: new Map([['s/stale', 'new'], ['s/fresh', 'same']]), skillPaths: [] }),
    preserve: () => '/backup/path',
    runUpdate: async () => true,
    ...overrides,
  };
}

// Adds an `available` skill (`wizard`) on top of baseDeps' fixture, plus the
// remove/install/manifest deps the orchestration tests below exercise.
const AVAILABLE_DEPS = (overrides = {}) => ({
  readLock: () => ({ skills: { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') } }),
  installed: () => ['fresh', 'stale'],
  inspectSource: async () => ({
    trees: new Map([['s/stale', 'new'], ['s/fresh', 'same']]),
    skillPaths: ['s/stale/SKILL.md', 's/fresh/SKILL.md', 's/wizard/SKILL.md'],
  }),
  select: async () => [],
  preserve: () => '/b',
  runUpdate: async () => true,
  runRemove: async () => true,
  installGroups: async () => [],
  writeManifest: () => {},
  ...overrides,
});

test('exitCode is 0 when everything is current', () => {
  const plan = { current: ['a'], outdated: [], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, failed: false }), 0);
});

test('exitCode is 1 for a gone skill even with nothing outdated', () => {
  const plan = { current: [], outdated: [], gone: [{ name: 'a' }], unknown: [], local: [] };
  assert.equal(exitCode({ plan, failed: false }), 1);
});

test('exitCode is 1 for an unreachable source', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [{ name: 'a' }], local: [] };
  assert.equal(exitCode({ plan, failed: false }), 1);
});

test('exitCode is 1 when the updater failed', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, failed: true }), 1);
});

test('exitCode ignores local skills, which are informational', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [], local: ['mine'] };
  assert.equal(exitCode({ plan, failed: false }), 0);
});

test('exitCode is 0 for an outdated skill left alone — declining is not a failure', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, failed: false }), 0);
});

test('exitCode does not count a gone skill named in prunedNames toward exit 1', () => {
  const plan = { current: [], outdated: [], gone: [{ name: 'a' }], unknown: [], local: [] };
  assert.equal(exitCode({ plan, failed: false, prunedNames: ['a'] }), 0);
});

test('reportLines shows both SHAs for an outdated skill', () => {
  const plan = {
    current: [], gone: [], unknown: [], local: [],
    outdated: [{ name: 'tdd', source: 'o/r', from: 'abcdef1234', to: '1234567890' }],
  };
  const text = reportLines(plan).join('\n');
  assert.match(text, /tdd/);
  assert.match(text, /abcdef1/);
  assert.match(text, /1234567/);
});

test('--check and --yes together are refused', async () => {
  assert.equal(await run(['--check', '--yes'], baseDeps()), 2);
});

// Outdated alone is a suggestion, not a --check failure — only `gone` and
// `unknown` are unresolved problems `exitCode` treats as exit 1. That is what
// lets `--check` stay quiet on a machine that is merely behind, the same way
// declining an update was never a failure either.
test('--check reports outdated skills and updates nothing', async () => {
  let updated = false;
  let preserved = false;
  const code = await run(['--check'], baseDeps({
    runUpdate: async () => { updated = true; return true; },
    preserve: () => { preserved = true; return '/backup/path'; },
  }));
  assert.equal(code, 0, 'outdated alone does not fail --check');
  assert.equal(updated, false, '--check must never write');
  assert.equal(preserved, false, '--check must never take a backup either');
});

// `run` no longer destructures `confirm` at all, so a mock installed under
// that name is dead weight that can never observe anything `run` does — this
// used to assert on it and could not have failed no matter what `run` called.
// `select` is the thing that would actually be reached if --check stopped
// short-circuiting before the picker, so a mock that throws pins the real
// guarantee: it fails loudly instead of passing by construction.
test('--check never prompts', async () => {
  await run(['--check'], baseDeps({
    select: async () => { throw new Error('select must not be called under --check'); },
  }));
});

test('an all-current machine exits 0 and updates nothing', async () => {
  let updated = false;
  const deps = baseDeps({
    inspectSource: async () => ({ trees: new Map([['s/stale', 'old'], ['s/fresh', 'same']]), skillPaths: [] }),
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.equal(updated, false);
});

test('a confirmed run backs up and updates only the outdated skills', async () => {
  const preserved = [];
  const sent = [];
  const deps = baseDeps({
    select: async () => ['update:stale'],
    preserve: (abs, rel) => { preserved.push(rel); return '/b'; },
    runUpdate: async (names) => { sent.push(...names); return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.deepEqual(sent, ['stale'], 'only the outdated skill may be updated');
  assert.equal(preserved.length, 1);
  assert.match(preserved[0], /stale/);
});

test('backups are taken before the updater runs', async () => {
  const order = [];
  const deps = baseDeps({
    select: async () => ['update:stale'],
    preserve: () => { order.push('backup'); return '/b'; },
    runUpdate: async () => { order.push('update'); return true; },
  });
  await run([], deps);
  assert.deepEqual(order, ['backup', 'update']);
});

// Same rot as '--check never prompts' above: `confirm` is not a dependency of
// `run` anymore, so a mock under that name could never be reached. `select`
// is the picker --yes is supposed to bypass, so that is what has to throw.
test('--yes skips the prompt entirely', async () => {
  const deps = baseDeps({
    select: async () => { throw new Error('select must not be called under --yes'); },
  });
  assert.equal(await run(['--yes'], deps), 0);
});

test('no TTY and no --yes refuses with exit 2 rather than hanging', async () => {
  const code = await run([], AVAILABLE_DEPS({ select: async () => null, isTTY: false }));
  assert.equal(code, 2);
});

test('an unreachable source exits 1 and updates nothing', async () => {
  let sent = null;
  const deps = baseDeps({
    inspectSource: async () => null,
    runUpdate: async (names) => { sent = names; return true; },
  });
  assert.equal(await run(['--yes'], deps), 1);
  assert.equal(sent, null, 'the updater must never be invoked when a source is unreachable');
});

test('a failing updater exits 1', async () => {
  const deps = baseDeps({ runUpdate: async () => false });
  assert.equal(await run(['--yes'], deps), 1);
});

test('a skill whose folder vanished upstream is never sent to the updater', async () => {
  const sent = [];
  const deps = baseDeps({
    inspectSource: async () => ({ trees: new Map([['s/stale', null], ['s/fresh', 'same']]), skillPaths: [] }),
    runUpdate: async (names) => { sent.push(...names); return true; },
  });
  const code = await run(['--yes'], deps);
  assert.equal(code, 1);
  assert.deepEqual(sent, [], 'a gone skill has nowhere to update from');
});

test('an empty picker selection still exits 1 when a skill has gone missing upstream', async () => {
  const deps = baseDeps({
    select: async () => [],
    inspectSource: async () => ({ trees: new Map([['s/stale', null], ['s/fresh', 'same']]), skillPaths: [] }),
  });
  assert.equal(await run([], deps), 1);
});

// --- Finding 1: the `moved` branch must be falsifiable. ---
// readLock is called twice by run() (before and after the updater). A fake
// that returns the SAME object both times can never distinguish a correct
// `moved` computation from a broken one, so these two tests drive it
// statefully: the second call reports a different hash than the first.

test('the closing report names the hash the lock actually moved to', async () => {
  let calls = 0;
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run([], baseDeps({
      select: async () => ['update:stale'],
      readLock: () => ({ skills: {
        stale: entry('s/stale', ++calls === 1 ? 'old' : 'newhash1234'),
        fresh: entry('s/fresh', 'same'),
      } }),
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /stale\s+updated\s+old -> newhash/);
  assert.doesNotMatch(out, /unchanged/);
});

test('an unmoved lock (no writer touched it) still reports unchanged', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run([], baseDeps({ select: async () => ['update:stale'] }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /unchanged/);
  assert.doesNotMatch(out, /stale\s+updated/);
});

// --- Finding 2: `from: null` (no hash was ever recorded) must never read as
// "unknown -> unknown" just because the post-update lock is also hashless. ---

test('a still-hashless skill is not reported as updated', async () => {
  const noHashEntry = { source: 'o/r', sourceUrl: URL, skillPath: 's/nohash/SKILL.md' };
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes'], {
      readLock: () => ({ skills: { nohash: noHashEntry } }),
      installed: () => ['nohash'],
      inspectSource: async () => ({ trees: new Map([['s/nohash', 'somehash']]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /unchanged/);
  assert.doesNotMatch(out, /unknown -> unknown/);
});

// --- Finding 3: the printed backup location must name the whole batch's
// shared directory, and a failed update with nothing preserved must not
// falsely point at "the backup listed at the top". ---

test("the backup line names the shared backup directory, not the last skill's path", async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes'], {
      readLock: () => ({ skills: { one: entry('s/one', 'old1'), two: entry('s/two', 'old2') } }),
      installed: () => ['one', 'two'],
      inspectSource: async () => ({ trees: new Map([['s/one', 'new1'], ['s/two', 'new2']]), skillPaths: [] }),
      preserve: (abs, rel) => `/fake/per-skill/${rel}`,
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.ok(out.includes(`backed up -> ${backupDir()}`), 'expected the shared backup directory in the output');
  assert.doesNotMatch(out, /\/fake\/per-skill\//, 'must not print a single skill\'s own backup path');
});

test('a failed update with nothing to preserve does not falsely point at a backup', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes'], baseDeps({
      preserve: () => null,
      runUpdate: async () => false,
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.doesNotMatch(out, /backed up ->/);
  assert.match(out, /No backup was made/);
});

// --- Finding 5: two distinct sources, one unreachable, only its own skills
// classified unknown. Exercises the per-source inspectSource loop, not just
// planUpdates directly. ---

test('two sources: an unreachable one only marks its own skills unknown', async () => {
  const URL2 = 'https://github.com/o/other.git';
  const deps = baseDeps({
    readLock: () => ({ skills: {
      stale: entry('s/stale', 'old'),
      fresh: { source: 'o/other', sourceUrl: URL2, skillPath: 's/fresh/SKILL.md', skillFolderHash: 'same' },
    } }),
    inspectSource: async (sourceUrl) => (sourceUrl === URL2 ? null : { trees: new Map([['s/stale', 'new']]), skillPaths: [] }),
  });
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--check'], deps);
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /outdated\s+1\s+stale/);
  assert.match(out, /unreachable\s+1\s+fresh/);
});

// --- Fix 1: `gone` skills must get a next step, not just a count row, and
// that pointer must not be swallowed by (or swallow) the `Run: nortuscc
// update` suggestion. `Run: nortuscc update` itself excludes `gone` skills
// from its batch by construction, so it alone sends the user in a circle. ---

test('gone with nothing outdated prints the prune pointer and --check exits 1', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--check'], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old'), fresh: entry('s/fresh', 'same') } }),
      installed: () => ['vanished', 'fresh'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null], ['s/fresh', 'same']]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /nortuscc update --prune/);
  // A precise line match: the gone footer's own "Run: nortuscc update
  // --prune" advice starts with the same words as the outdated suggestion,
  // so a loose substring match would false-positive against it.
  assert.doesNotMatch(out, /^Run: nortuscc update$/m, 'nothing is outdated, so that suggestion must not appear');
});

// A `gone` skill still gets a row in the picker (so it can be removed), even
// when nothing is outdated. Declining that row (an empty selection) leaves it
// unresolved, so the prune pointer must still print and the exit code must
// still be 1.
test('gone with nothing outdated still prints the prune pointer when nothing is picked', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run([], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old'), fresh: entry('s/fresh', 'same') } }),
      installed: () => ['vanished', 'fresh'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null], ['s/fresh', 'same']]), skillPaths: [] }),
      select: async () => [],
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /nortuscc update --prune/);
});

test('gone and outdated together print both the prune pointer and the update suggestion', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--check'], {
      readLock: () => ({ skills: { stale: entry('s/stale', 'old'), vanished: entry('s/vanished', 'old2') } }),
      installed: () => ['stale', 'vanished'],
      inspectSource: async () => ({ trees: new Map([['s/stale', 'new'], ['s/vanished', null]]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /^Run: nortuscc update$/m);
  assert.match(out, /nortuscc update --prune/);
});

// --- Fix 2: preserveCopy returns null when existsSync sees nothing at the
// path, which includes a broken symlink (existsSync follows links;
// installedSkillNames deliberately counts them). That skill must be named as
// unprotected rather than silently handed to the updater with no backup. ---

test('a skill whose backup returns null is named as unprotected, not silently sent on', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes'], {
      readLock: () => ({ skills: { one: entry('s/one', 'old1'), two: entry('s/two', 'old2') } }),
      installed: () => ['one', 'two'],
      inspectSource: async () => ({ trees: new Map([['s/one', 'new1'], ['s/two', 'new2']]), skillPaths: [] }),
      preserve: (abs, rel) => (rel.includes('one') ? '/backup/one' : null),
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /backed up ->/, 'one skill did back up, so the shared directory is still reported');
  assert.match(out, /no backup exists for:.*\btwo\b/);
  assert.ok(
    !/no backup exists for:[^\n]*\bone\b/.test(out),
    'the skill that WAS backed up must not also be named as unprotected',
  );
});

// --- Follow-up fixes after the final branch review ---

// An unrecognised flag used to be ignored, so `nortuscc update --chek` — a
// plausible slip when reaching for the refused `--check --yes` — silently
// performed a full interactive update. `update` is the first command whose
// default action writes, so the permissiveness `apply` gets away with is not
// safe here.

test('an unknown flag is refused rather than silently ignored', async () => {
  let updated = false;
  const code = await run(['--chek'], baseDeps({ runUpdate: async () => { updated = true; return true; } }));
  assert.equal(code, 2);
  assert.equal(updated, false, 'a typo must never reach the updater');
});

test('the unknown-flag refusal names the offending flag', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (m) => errs.push(String(m));
  try {
    await run(['--dry-run'], baseDeps());
  } finally { console.error = orig; }
  assert.match(errs.join('\n'), /--dry-run/);
});

test('a bare positional argument is refused too', async () => {
  assert.equal(await run(['tdd'], baseDeps()), 2);
});

test('the known flags are still accepted together with nothing else', async () => {
  assert.equal(await run(['--yes'], baseDeps()), 0);
  assert.equal(await run([], baseDeps({ select: async () => [] })), 0);
});

// The gone footer used to read "re-add them upstream" and sat directly below
// the outdated detail rows, so "them" read as referring to those. It must name
// the skills it is about.

test('the gone footer names the gone skills, not just a bare pronoun', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], {
      readLock: () => ({ skills: { stale: entry('s/stale', 'old'), vanished: entry('s/vanished', 'old2') } }),
      installed: () => ['stale', 'vanished'],
      inspectSource: async () => ({ trees: new Map([['s/stale', 'new'], ['s/vanished', null]]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  // The footer must say which skill it means, and must not be phrased so it
  // could be read as advice about the outdated one listed just above it.
  const footer = out.split('\n').filter((l) => /gone upstream|nortuscc update --prune/.test(l)).join('\n');
  assert.match(footer, /vanished/, 'the footer must name the gone skill');
  assert.doesNotMatch(footer, /\bstale\b/, 'the footer must not name an outdated skill');
});

// The footer used to point at a manual `npx skills remove` followed by
// `nortuscc capture` — advice that skips the backup the interactive picker's
// own `remove` group takes, and that `capture`'s shrink guard would now
// refuse outright for anything but a single entry. `update --prune` is the
// one route that actually works end to end.
test('the gone footer points at update --prune, not a manual remove-then-capture', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old') } }),
      installed: () => ['vanished'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null]]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /nortuscc update --prune/, 'a skill deleted upstream is removed via the prune flag');
  assert.doesNotMatch(out, /skills remove/, 'no manual npx skills remove advice');
  assert.doesNotMatch(out, /nortuscc capture/, 'no capture advice — its own shrink guard would refuse this');
});

// A long skill name used to shunt the state column out of alignment, because
// formatRow padded every label to a fixed 16.

test('a long skill name keeps the outdated detail rows aligned', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], {
      readLock: () => ({
        skills: {
          'setup-matt-pocock-skills': entry('s/long', 'old'),
          tdd: entry('s/tdd', 'old2'),
        },
      }),
      installed: () => ['setup-matt-pocock-skills', 'tdd'],
      inspectSource: async () => ({ trees: new Map([['s/long', 'new'], ['s/tdd', 'new2']]), skillPaths: [] }),
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  // Detail rows carry the SHA transition; the aggregate count row above them
  // also contains the word "outdated", so match on the arrow instead.
  const detail = chunks.join('').split('\n').filter((l) => /outdated/.test(l) && / -> /.test(l));
  assert.equal(detail.length, 2, 'both skills should have a detail row');
  assert.equal(
    detail[0].indexOf('outdated'),
    detail[1].indexOf('outdated'),
    'the state column must line up regardless of skill-name length',
  );
});

// --- Task 8: parseFlags and manifestOutcome ---

test('parseFlags reads --add as a comma list', () => {
  assert.deepEqual(parseFlags(['--add', 'a,b']).add, ['a', 'b']);
});

test('parseFlags accepts --add=a,b', () => {
  assert.deepEqual(parseFlags(['--add=a,b']).add, ['a', 'b']);
});

test('parseFlags rejects --add with no names', () => {
  // There is deliberately no way to adopt a whole repo from a flag.
  assert.match(parseFlags(['--add']).error, /--add/);
});

test('parseFlags reads --prune as a boolean', () => {
  assert.equal(parseFlags(['--prune']).prune, true);
  assert.equal(parseFlags([]).prune, false);
});

test('parseFlags refuses --check with an action flag', () => {
  assert.match(parseFlags(['--check', '--prune']).error, /--check/);
  assert.match(parseFlags(['--check', '--add', 'x']).error, /--check/);
  assert.match(parseFlags(['--check', '--yes']).error, /--check/);
});

test('parseFlags refuses an unknown flag', () => {
  assert.match(parseFlags(['--chek']).error, /--chek/);
});

test('manifestOutcome writes when nothing shrank', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b'] }];
  const groups = [{ source: 'o/r', skills: ['a', 'b'] }];
  assert.equal(manifestOutcome({ before, groups, prunedNames: [] }).write, true);
});

test('manifestOutcome writes a shrink that the prune fully explains', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b'] }];
  const groups = [{ source: 'o/r', skills: ['a'] }];
  assert.equal(manifestOutcome({ before, groups, prunedNames: ['b'] }).write, true);
});

test('manifestOutcome refuses a shrink larger than the prune, naming the survivors', () => {
  // The real hazard: a machine simply missing skills the shared manifest lists
  // would otherwise delete them for every other machine.
  const before = [{ source: 'o/r', skills: ['a', 'b', 'c'] }];
  const groups = [{ source: 'o/r', skills: ['a'] }];
  const out = manifestOutcome({ before, groups, prunedNames: ['b'] });
  assert.equal(out.write, false);
  assert.match(out.reason, /--allow-shrink/);
  assert.match(out.reason, /\bc\b/, 'the surviving entry the prune does not explain must be named');
});

test('manifestOutcome writes growth', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b'] }];
  const groups = [{ source: 'o/r', skills: ['a', 'b', 'c'] }];
  assert.equal(manifestOutcome({ before, groups, prunedNames: [] }).write, true);
});

// The bug the count-based guard could not catch: an adopt (+1) exactly cancels
// out a miss (-1) in the aggregate count, so `before === after` and the old
// guard wrote — silently dropping the missing skill from the shared manifest
// on the next push. A set difference catches this even though the totals
// match; a plain subtraction cannot.
test('an adopt that exactly masks a miss is refused, not written', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b', 'ghost'] }]; // this machine never had 'ghost'
  const groups = [{ source: 'o/r', skills: ['a', 'b', 'wizard'] }]; // adopted 'wizard' instead
  const out = manifestOutcome({ before, groups, prunedNames: [] });
  assert.equal(out.write, false, 'counts match (3 == 3) but the set differs — must still refuse');
  assert.match(out.reason, /ghost/, 'the missing skill must be named, not just counted');
});

test('a pure prune of exactly the pruned names writes', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b', 'c'] }];
  const groups = [{ source: 'o/r', skills: ['a'] }];
  const out = manifestOutcome({ before, groups, prunedNames: ['b', 'c'] });
  assert.equal(out.write, true);
});

test('an adopt with no misses writes', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b'] }];
  const groups = [{ source: 'o/r', skills: ['a', 'b', 'wizard'] }];
  const out = manifestOutcome({ before, groups, prunedNames: [] });
  assert.equal(out.write, true);
});

test('manifestOutcome refuses to write an empty manifest even when the shrink is fully explained', () => {
  const before = [{ source: 'o/r', skills: ['a', 'b'] }];
  const groups = [];
  const out = manifestOutcome({ before, groups, prunedNames: ['a', 'b'] });
  assert.equal(out.write, false);
});

// --- orchestration ---

test('the report lists an upstream skill that is not installed as available', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], AVAILABLE_DEPS());
  } finally { process.stdout.write = orig; }
  assert.match(chunks.join(''), /available.*wizard/s);
});

test('available skills never affect the exit code', async () => {
  // An active source repo almost always has something new; counting it would
  // leave --check permanently red and useless as a gate.
  const code = await run(['--check'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', 'old'], ['s/fresh', 'same']]),
      skillPaths: ['s/stale/SKILL.md', 's/fresh/SKILL.md', 's/wizard/SKILL.md'],
    }),
  }));
  assert.equal(code, 0, 'nothing outdated, gone or unknown — available alone must not fail');
});

test('the picker drives what gets executed', async () => {
  const sent = [];
  await run([], AVAILABLE_DEPS({
    select: async () => ['update:stale'],
    runUpdate: async (names) => { sent.push(...names); return true; },
  }));
  assert.deepEqual(sent, ['stale']);
});

// The spec requirement ("--add and --prune pre-tick rows") was previously
// exercised only through --yes, which reads `r.checked` directly and would
// pass even if `seeded` were dropped from the call to `select` entirely — the
// interactive path would still show every row unchecked and nothing here
// would catch it. Capturing what `select` actually receives closes that gap.
test('--add and --prune pre-tick their rows in the picker, not just under --yes', async () => {
  let capturedRows = null;
  await run(['--add', 'wizard', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md', 's/wizard/SKILL.md', 's/gizmo/SKILL.md'],
    }),
    select: async (rows) => { capturedRows = rows; return []; },
  }));
  const byKey = Object.fromEntries(capturedRows.map((r) => [r.key, r.checked]));
  assert.equal(byKey['add:wizard'], true, '--add wizard must pre-tick its row');
  assert.equal(byKey['add:gizmo'], false, 'a skill not named by --add must not be pre-ticked');
  assert.equal(byKey['remove:stale'], true, '--prune must pre-tick the gone row');
});

test('a cancelled picker changes nothing and exits 0', async () => {
  let touched = false;
  const mark = async () => { touched = true; return true; };
  // isTTY: true distinguishes this from "no terminal at all" (tested below) —
  // a real select() only ever returns null with no isTTY reason attached, so
  // run() has to take the caller's word for which case it is.
  const code = await run([], AVAILABLE_DEPS({
    select: async () => null,
    isTTY: true,
    runUpdate: mark, runRemove: mark, installGroups: mark,
  }));
  assert.equal(code, 0);
  assert.equal(touched, false);
});

test('an empty selection is a no-op that exits 0', async () => {
  let touched = false;
  const code = await run([], AVAILABLE_DEPS({
    select: async () => [],
    runUpdate: async () => { touched = true; return true; },
  }));
  assert.equal(code, 0);
  assert.equal(touched, false);
});

test('--yes skips the picker and updates everything outdated', async () => {
  let asked = false;
  const sent = [];
  await run(['--yes'], AVAILABLE_DEPS({
    select: async () => { asked = true; return []; },
    runUpdate: async (names) => { sent.push(...names); return true; },
  }));
  assert.equal(asked, false, '--yes must not open a picker');
  assert.deepEqual(sent, ['stale']);
});

test('--yes --add adopts exactly the named skills', async () => {
  const added = [];
  await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    installGroups: async (groups) => { added.push(...groups.flatMap((g) => g.skills)); return []; },
  }));
  assert.deepEqual(added, ['wizard']);
});

// seedKeys quietly drops an --add name that matches nothing in
// plan.available — right for the picker, where it just means one fewer row
// pre-ticked, but a scripted run has no picker to show that anything was
// skipped. Without a diagnostic, `--yes --add does-not-exist` looks
// identical to a run that adopted the name successfully: it calls nothing,
// never mentions the name, and exits 0.
test('a scripted --add naming an unmatched skill reports it and exits non-zero', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--yes', '--add', 'does-not-exist'], AVAILABLE_DEPS());
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /does-not-exist/, 'the unmatched name must be named in the output');
  assert.equal(code, 1, 'a named --add skill that matched nothing must not exit clean');
});

// Same guarantee with nothing else pending at all, so the run has no other
// route to a non-zero exit — it has to come from the unmatched name itself.
test('a scripted --add with an unmatched name and nothing else pending still exits non-zero', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--yes', '--add', 'does-not-exist'], AVAILABLE_DEPS({
      inspectSource: async () => ({ trees: new Map([['s/stale', 'old'], ['s/fresh', 'same']]), skillPaths: [] }),
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /does-not-exist/);
  assert.equal(code, 1);
});

test('--check refuses an action flag', async () => {
  assert.equal(await run(['--check', '--prune'], AVAILABLE_DEPS()), 2);
});

test('removals are backed up before anything is removed', async () => {
  const order = [];
  await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
    preserve: () => { order.push('backup'); return '/b'; },
    runRemove: async () => { order.push('remove'); return true; },
  }));
  assert.deepEqual(order, ['backup', 'remove'], 'prune is the first thing that deletes a skill outright');
});

test('a pruned gone skill no longer forces exit 1', async () => {
  const code = await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
  }));
  assert.equal(code, 0, 'a gone skill that was dealt with is not still a problem');
});

test('an unpruned gone skill still forces exit 1', async () => {
  const code = await run(['--yes'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
  }));
  assert.equal(code, 1);
});

// `assert.ok(written)` alone passes for any string, including an empty
// `emitManifest([])` — and with static readLock/installed stubs `wizard` can
// never actually appear in the emitted text, since the manifest block
// rebuilds `groups` from `readLock()`/`installed()` called *after* the
// executors ran, not from `actions.add`. Driving those two dependencies
// statefully (the same pattern as 'the closing report names the hash the
// lock actually moved to' above) proves `run` really does feed the adopted
// skill's post-install presence into what gets written, not just some fixed
// string.
test('the manifest is written after adopting', async () => {
  let written = null;
  let adopted = false;
  await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    readLock: () => ({
      skills: {
        stale: entry('s/stale', 'old'),
        fresh: entry('s/fresh', 'same'),
        ...(adopted ? { wizard: entry('s/wizard', 'wizardhash') } : {}),
      },
    }),
    installed: () => (adopted ? ['fresh', 'stale', 'wizard'] : ['fresh', 'stale']),
    installGroups: async (groups) => {
      adopted = true;
      return groups.map((g) => ({ source: g.source, ok: true }));
    },
    writeManifest: (text) => { written = text; },
  }));
  assert.ok(written, 'adopting a skill must record it in the manifest');
  assert.match(written, /\bwizard\b/, 'the manifest must actually name the skill that was adopted');
});

test('the manifest is left alone when nothing was adopted or pruned', async () => {
  let written = null;
  await run(['--yes'], AVAILABLE_DEPS({ writeManifest: (t) => { written = t; } }));
  assert.equal(written, null, 'a plain refresh changes no manifest entry');
});

// The refusal branch of manifestOutcome is the thing protecting every other
// machine's manifest from one machine's incomplete skill set — and nothing
// exercised it through `run` before this: `fixtureRepo` is an empty temp dir
// for every other test here, so readSkillsManifest() always returns [] and
// `before` is always 0, landing on `write: true` no matter what. This test
// writes a real, populated manifest into an isolated repo dir (swapped in and
// restored the same way test/status.test.mjs does), then drives a prune that
// only accounts for 1 of the 6 entries the shared manifest lists — proving
// `run` feeds the real manifest count into manifestOutcome rather than a
// constant, and that the refusal message names the actual numbers.
test('a shrink larger than what was pruned leaves a populated manifest alone', async () => {
  const isolatedRepo = mkdtempSync(join(tmpdir(), 'nortuscc-update-shrink-'));
  writeFileSync(join(isolatedRepo, 'skills-manifest.txt'), '[o/r]\na\nb\nc\nd\ne\nf\n');
  const origRepoDir = process.env.NORTUSCC_REPO_DIR;
  process.env.NORTUSCC_REPO_DIR = isolatedRepo;

  let pruned = false;
  let written = null;
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes', '--prune'], AVAILABLE_DEPS({
      inspectSource: async () => ({
        trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
        skillPaths: ['s/fresh/SKILL.md'],
      }),
      // Statefully reflects only 'stale' having actually been removed — 'a'
      // through 'f' were never installed here at all, so the shared manifest
      // is simply ahead of what this machine has, which is exactly the
      // hazard the guard exists for.
      readLock: () => ({
        skills: pruned
          ? { fresh: entry('s/fresh', 'same') }
          : { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') },
      }),
      installed: () => (pruned ? ['fresh'] : ['fresh', 'stale']),
      runRemove: async () => { pruned = true; return true; },
      writeManifest: (text) => { written = text; },
    }));
  } finally {
    process.stdout.write = orig;
    process.env.NORTUSCC_REPO_DIR = origRepoDir;
  }
  assert.equal(written, null, 'a shrink bigger than the prune must never be written');
  const out = chunks.join('');
  assert.match(out, /left alone/);
  // 'stale' was pruned, but none of a-f were ever installed on this machine —
  // pruning 'stale' explains none of their absence, so all six are named as
  // unaccounted-for survivors, not folded into a single opaque count.
  assert.match(out, /would drop 6 entr\(ies\)/);
  assert.match(out, /\ba\b.*\bb\b.*\bc\b.*\bd\b.*\be\b.*\bf\b/);
});

test('a failing remover exits 1', async () => {
  const code = await run(['--yes', '--prune'], AVAILABLE_DEPS({
    inspectSource: async () => ({
      trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
      skillPaths: ['s/fresh/SKILL.md'],
    }),
    runRemove: async () => false,
  }));
  assert.equal(code, 1);
});

// A failed removal must never be reported as 'removed' — that row sits right
// below the 'backed up ->' line and would read as an invitation to discard
// the backup that is now the skill's only remaining copy.
test('a failing remover reports the skill as failed, not removed', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes', '--prune'], AVAILABLE_DEPS({
      inspectSource: async () => ({
        trees: new Map([['s/stale', null], ['s/fresh', 'same']]),
        skillPaths: ['s/fresh/SKILL.md'],
      }),
      runRemove: async () => false,
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /stale\s+failed/, 'the failed removal must be named as failed');
  assert.doesNotMatch(out, /stale\s+removed/, 'a failed removal must never be reported as removed');
});

test('a failing installer exits 1', async () => {
  const code = await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
    installGroups: async () => [{ source: 'o/r', ok: false }],
  }));
  assert.equal(code, 1);
});

// Mirrors the removal case: a failed install must not read as adopted.
test('a failing installer reports the skill as failed, not added', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
      installGroups: async () => [{ source: 'o/r', ok: false }],
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /wizard\s+failed/, 'the failed install must be named as failed');
  assert.doesNotMatch(out, /wizard\s+added/, 'a failed install must never be reported as added');
});

// The bug a single shared derivation closes: `installResults.some(r =>
// !r.ok)` and membership in `okAddSources` used to be computed separately,
// and only ever agreed because installGroups always returned one result per
// group. A fixture (or a real bug) that returns fewer results than groups
// used to pass `some(r => !r.ok)` vacuously — nothing in the (empty) array is
// `!r.ok` — while still reporting every add as failed, an exit-0-with-a-
// failed-row contradiction. Both now read the same map, so a missing result
// reads as failed everywhere at once.
test('an installer that returns no result for a requested source is coherent, not a silent success', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
      installGroups: async () => [],
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1, 'a source installGroups never answered for must not exit clean');
  assert.match(out, /wizard\s+failed/, 'the unanswered add must be named as failed, not silently dropped');
});

// Finding: an unmatched --add name used to always read as a typo, even when
// the real cause was staring right at it in plan.unknown — the source it
// would have come from was never reached at all.
test('an unmatched --add name blames an unreachable source when one exists, not just a typo', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--yes', '--add', 'wizard'], AVAILABLE_DEPS({
      inspectSource: async () => null,
    }));
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /wizard/);
  assert.match(out, /could not be reached \(o\/r\)/, 'the unreachable source must be named, not just guessed at as a typo');
});
