import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-update-'));
mkdirSync(claude, { recursive: true });
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { run, exitCode, reportLines } = await import('../src/commands/update.mjs');

const URL = 'https://github.com/o/r.git';
const entry = (path, hash) => ({
  source: 'o/r', sourceUrl: URL, skillPath: `${path}/SKILL.md`, skillFolderHash: hash,
});

// Two installed skills: `stale` has moved upstream, `fresh` has not.
function baseDeps(overrides = {}) {
  return {
    readLock: () => ({ skills: { stale: entry('s/stale', 'old'), fresh: entry('s/fresh', 'same') } }),
    installed: () => ['fresh', 'stale'],
    resolveTrees: async () => new Map([['s/stale', 'new'], ['s/fresh', 'same']]),
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
  const code = await run(['--check'], baseDeps({ runUpdate: async () => { updated = true; return true; } }));
  assert.equal(code, 1);
  assert.equal(updated, false, '--check must never write');
});

test('--check never prompts', async () => {
  let asked = false;
  await run(['--check'], baseDeps({ confirm: async () => { asked = true; return true; } }));
  assert.equal(asked, false);
});

test('an all-current machine exits 0 and updates nothing', async () => {
  let updated = false;
  const deps = baseDeps({
    resolveTrees: async () => new Map([['s/stale', 'old'], ['s/fresh', 'same']]),
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
  const deps = baseDeps({ resolveTrees: async () => null });
  assert.equal(await run(['--yes'], deps), 1);
});

test('a failing updater exits 1', async () => {
  const deps = baseDeps({ runUpdate: async () => false });
  assert.equal(await run(['--yes'], deps), 1);
});

test('a skill whose folder vanished upstream is never sent to the updater', async () => {
  const sent = [];
  const deps = baseDeps({
    resolveTrees: async () => new Map([['s/stale', null], ['s/fresh', 'same']]),
    runUpdate: async (names) => { sent.push(...names); return true; },
  });
  const code = await run(['--yes'], deps);
  assert.equal(code, 1);
  assert.deepEqual(sent, [], 'a gone skill has nowhere to update from');
});
