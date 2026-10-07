import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, pushUpstream, readJson, runCli, syncedMachine, type Machine } from './support/cli.ts';

// `nortuscc sync` from the outside: B's checkout behind a bare origin that another clone advances.

const EFFORT = 'setting:claude:settings.json#effortLevel';
const THEME = 'setting:claude:settings.json#theme';
const origin = (m: Machine) => join(m.home, 'origin.git');
const originHead = (m: Machine) => git(origin(m), 'rev-parse', 'main');
const keys = (m: Machine) => readJson(join(m.repo, 'claude', 'settings.keys.json'));
const settingsWith = (m: Machine, changes: Record<string, unknown>) => JSON.stringify({ ...keys(m), ...changes }, null, 2) + '\n';
const sync = (m: Machine, ...args: string[]) => runCli(m, ['sync', ...args]);
const state = (m: Machine) => readJson(join(m.state, 'state.json'));
const writeOverrides = (m: Machine, value: unknown) => {
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'overrides.json'), JSON.stringify({ version: 1, ...(value as object) }, null, 2) + '\n');
};

test('with nothing new, sync still applies and records the applied commit', async () => {
  const m = machine();
  const result = await sync(m);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /setup\s+current\s+nothing new since the last sync/);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), true);
  assert.equal(state(m).applied.commit, git(m.repo, 'rev-parse', 'HEAD'));
});

test('--check previews and exits 1 when items wait, changing nothing but the remote ref', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  const result = await sync(m, '--check');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /file:claude:CLAUDE\.md\s+changed\s+sha256:\w{7} → sha256:\w{7}/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
});

test('--yes takes every item, records decisions and the applied commit, and holds nothing', async () => {
  const m = machine();
  const head = pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { effortLevel: 'medium' }), 'claude/CLAUDE.md': '# new\n' });
  const result = await sync(m, '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# new\n');
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, 'medium');
  assert.equal(state(m).applied.commit, head);
  assert.equal(existsSync(join(m.state, 'sync.json')), false);
  const decisions = readJson(join(m.state, 'decisions.json')).decisions;
  assert.deepEqual(decisions.map((d: { itemId: string; decision: string; commit: string }) => [d.itemId, d.decision, d.commit]).sort(), [
    ['file:claude:CLAUDE.md', 'accept', head], [EFFORT, 'accept', head],
  ]);
});

test('--skip holds an item at the applied commit; --release takes it back', async () => {
  const m = machine();
  await syncedMachine(m);
  const first = git(m.repo, 'rev-parse', 'HEAD');
  const before = keys(m).effortLevel;
  pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { effortLevel: 'medium' }) });
  const skipped = await sync(m, '--skip', EFFORT);
  assert.equal(skipped.code, 0, skipped.stderr);
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, before);
  assert.deepEqual(readJson(join(m.state, 'sync.json')).held, { [EFFORT]: first });

  const released = await sync(m, '--release', EFFORT);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, 'medium');
  assert.deepEqual(readJson(join(m.state, 'sync.json')).held, {});
  assert.equal((await sync(m, '--release', EFFORT)).code, 2);
});

test('a held item that upstream changes again comes back, from its held value', async () => {
  const m = machine();
  const before = keys(m).effortLevel;
  pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { effortLevel: 'medium' }) });
  assert.equal((await sync(m, '--skip', EFFORT)).code, 0);
  pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { effortLevel: 'max' }) });
  const result = await sync(m, '--check');
  assert.equal(result.code, 1);
  assert.match(result.stdout, new RegExp(`${EFFORT}\\s+changed\\s+"${before}" → "max"`));
});

test('--take-theirs drops the override after backing up overrides.json', async () => {
  const m = machine();
  writeOverrides(m, { settings: { 'claude:settings.json': { theme: 'dark' } } });
  await syncedMachine(m);
  pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { theme: 'light' }) });
  const result = await sync(m, '--take-theirs', THEME);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readJson(join(m.state, 'overrides.json')), { version: 1 });
  assert.equal(readJson(join(m.claude, 'settings.json')).theme, 'light');
  const backups = readdirSync(join(m.state, 'backups')).map((d) => join(m.state, 'backups', d, 'overrides.json')).filter(existsSync);
  assert.equal(backups.length, 1);
  assert.match(readFileSync(backups[0]!, 'utf8'), /"dark"/);
});

test('a diverged remote exits 1, leaves the checkout alone, applies and records nothing', async () => {
  const m = machine();
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# local unpushed change\n');
  git(m.repo, 'commit', '-qam', 'local unpushed change');
  const head = git(m.repo, 'rev-parse', 'HEAD');
  const result = await sync(m, '--yes');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /The remote has diverged; resolve it in the repo before applying\./);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
});

test('an unreachable origin exits 1 and changes nothing', async () => {
  const m = machine();
  git(m.repo, 'remote', 'set-url', 'origin', join(m.home, 'gone.git'));
  const result = await sync(m);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not fetch origin\/main; nothing was changed/);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

test('a checkout with no upstream is reported and left alone', async () => {
  const m = machine();
  git(m.repo, 'branch', '--unset-upstream');
  const result = await sync(m);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /tracks no upstream branch/);
});

// Review Focus 1.
test('local edits the fast-forward would overwrite stop sync before anything is recorded', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# being edited\n');
  const result = await sync(m, '--yes');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /git merge --ff-only failed/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
});

// Review Focus 2.
test('a --skip or --take-theirs id that is not waiting exits 2 and accepts nothing', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  for (const args of [['--skip', 'file:claude:CLAUDE.mdd'], ['--take-theirs', 'file:claude:CLAUDE.md']]) {
    const result = await sync(m, ...args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /is not waiting|has no override to take/);
  }
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
});

// Review Focus 3.
test('an applied commit the checkout no longer has is reported, and sync measures from HEAD', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'state.json'), JSON.stringify({ version: 1, repo: null, files: {}, applied: { commit: 'f'.repeat(40), at: '2026-10-07T00:00:00.000Z' } }) + '\n');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  const result = await sync(m, '--yes');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /the applied commit fffffff is not in this checkout; measuring from/);
  assert.equal(state(m).applied.commit, originHead(m));
});

test('pull is sync', async () => {
  const m = machine();
  const original = readFileSync(join(m.repo, 'claude', 'CLAUDE.md'), 'utf8');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  const checked = await runCli(m, ['pull', '--check']);
  assert.equal(checked.code, 1);
  assert.match(checked.stdout, /^sync$/m);
  const pulled = await runCli(m, ['pull', '--skip', 'file:claude:CLAUDE.md']);
  assert.equal(pulled.code, 0, pulled.stderr);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), originHead(m));
  // The checkout moved, but the skipped file stays at the value it had.
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), original);
  assert.deepEqual(Object.keys(readJson(join(m.state, 'sync.json')).held), ['file:claude:CLAUDE.md']);
});

test('an invalid sync.json refuses sync before the repo moves', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'sync.json'), '{ broken');
  const result = await sync(m);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sync\.json is not valid/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
});

test('an id both skipped and taken theirs is refused before the repo moves', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/settings.keys.json': settingsWith(m, { effortLevel: 'medium' }) });
  const result = await sync(m, '--skip', EFFORT, '--take-theirs', EFFORT);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /setting:claude:settings\.json#effortLevel.*both --skip and --take-theirs/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
});

test('an unknown flag is refused before the repo moves, not forwarded to apply', async () => {
  const m = machine();
  const head = git(m.repo, 'rev-parse', 'HEAD');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  const result = await sync(m, '--chek');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option --chek/);
  assert.equal(git(m.repo, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(m.state, 'state.json')), false);
  assert.equal(existsSync(join(m.state, 'decisions.json')), false);
});
