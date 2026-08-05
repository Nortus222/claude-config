import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-update-'));
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

// Redirect the skills dir too, the same way test/status.test.mjs does, so a
// future test that forgets to override `preserve` fails loudly on a missing
// fixture instead of silently reading the real ~/.agents/skills.
process.env.NORTUSCC_AGENTS_DIR = join(claude, '.agents', 'skills');

const { run, exitCode, reportLines } = await import('../src/commands/update.mjs');
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
    confirm: async () => true,
    preserve: () => '/backup/path',
    runUpdate: async () => true,
    ...overrides,
  };
}

test('exitCode is 0 when everything is current', () => {
  const plan = { current: ['a'], outdated: [], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
});

test('exitCode is 1 for a gone skill even with nothing outdated', () => {
  const plan = { current: [], outdated: [], gone: [{ name: 'a' }], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 1);
});

test('exitCode is 1 for an unreachable source', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [{ name: 'a' }], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 1);
});

test('exitCode is 1 when the updater failed', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: true }), 1);
});

test('exitCode ignores local skills, which are informational', () => {
  const plan = { current: [], outdated: [], gone: [], unknown: [], local: ['mine'] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
});

test('exitCode is 0 for an outdated skill left alone — declining is not a failure', () => {
  const plan = { current: [], outdated: [{ name: 'a' }], gone: [], unknown: [], local: [] };
  assert.equal(exitCode({ plan, updateFailed: false }), 0);
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

test('--check reports outdated skills, exits 1, and updates nothing', async () => {
  let updated = false;
  let preserved = false;
  const code = await run(['--check'], baseDeps({
    runUpdate: async () => { updated = true; return true; },
    preserve: () => { preserved = true; return '/backup/path'; },
  }));
  assert.equal(code, 1);
  assert.equal(updated, false, '--check must never write');
  assert.equal(preserved, false, '--check must never take a backup either');
});

test('--check never prompts', async () => {
  let asked = false;
  await run(['--check'], baseDeps({ confirm: async () => { asked = true; return true; } }));
  assert.equal(asked, false);
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
    preserve: () => { order.push('backup'); return '/b'; },
    runUpdate: async () => { order.push('update'); return true; },
  });
  await run([], deps);
  assert.deepEqual(order, ['backup', 'update']);
});

test('declining changes nothing and exits 0', async () => {
  let updated = false;
  const deps = baseDeps({
    confirm: async () => false,
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 0);
  assert.equal(updated, false);
});

test('--yes skips the prompt entirely', async () => {
  let asked = false;
  const deps = baseDeps({ confirm: async () => { asked = true; return true; } });
  assert.equal(await run(['--yes'], deps), 0);
  assert.equal(asked, false);
});

test('no TTY without --yes refuses with exit 2 rather than hanging', async () => {
  let updated = false;
  const deps = baseDeps({
    confirm: async () => null,
    runUpdate: async () => { updated = true; return true; },
  });
  assert.equal(await run([], deps), 2);
  assert.equal(updated, false);
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

test('declining still exits 1 when a skill has gone missing upstream', async () => {
  const deps = baseDeps({
    confirm: async () => false,
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
    await run([], baseDeps());
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
      confirm: async () => true,
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
      confirm: async () => true,
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

test('gone with nothing outdated prints the capture pointer and --check exits 1', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--check'], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old'), fresh: entry('s/fresh', 'same') } }),
      installed: () => ['vanished', 'fresh'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null], ['s/fresh', 'same']]), skillPaths: [] }),
      confirm: async () => true,
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /nortuscc capture/);
  assert.doesNotMatch(out, /Run: nortuscc update/, 'nothing is outdated, so that suggestion must not appear');
});

test('gone with nothing outdated still prints the capture pointer outside --check, without prompting', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let asked = false;
  let code;
  try {
    code = await run([], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old'), fresh: entry('s/fresh', 'same') } }),
      installed: () => ['vanished', 'fresh'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null], ['s/fresh', 'same']]), skillPaths: [] }),
      confirm: async () => { asked = true; return true; },
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.equal(asked, false, 'nothing is outdated, so run must not prompt at all');
  assert.match(out, /nortuscc capture/);
});

test('gone and outdated together print both the capture pointer and the update suggestion', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  let code;
  try {
    code = await run(['--check'], {
      readLock: () => ({ skills: { stale: entry('s/stale', 'old'), vanished: entry('s/vanished', 'old2') } }),
      installed: () => ['stale', 'vanished'],
      inspectSource: async () => ({ trees: new Map([['s/stale', 'new'], ['s/vanished', null]]), skillPaths: [] }),
      confirm: async () => true,
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.equal(code, 1);
  assert.match(out, /Run: nortuscc update/);
  assert.match(out, /nortuscc capture/);
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
      confirm: async () => true,
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
  assert.equal(await run([], baseDeps()), 0);
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
      confirm: async () => true,
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  // The footer must say which skill it means, and must not be phrased so it
  // could be read as advice about the outdated one listed just above it.
  const footer = out.split('\n').filter((l) => /gone upstream|skills remove|nortuscc capture/.test(l)).join('\n');
  assert.match(footer, /vanished/, 'the footer must name the gone skill');
  assert.doesNotMatch(footer, /\bstale\b/, 'the footer must not name an outdated skill');
});

test('the gone footer offers a removal command, not only capture', async () => {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try {
    await run(['--check'], {
      readLock: () => ({ skills: { vanished: entry('s/vanished', 'old') } }),
      installed: () => ['vanished'],
      inspectSource: async () => ({ trees: new Map([['s/vanished', null]]), skillPaths: [] }),
      confirm: async () => true,
      preserve: () => '/b',
      runUpdate: async () => true,
    });
  } finally { process.stdout.write = orig; }
  const out = chunks.join('');
  assert.match(out, /skills remove/, 'a skill deleted upstream can only be removed locally');
  assert.match(out, /nortuscc capture/);
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
      confirm: async () => true,
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
