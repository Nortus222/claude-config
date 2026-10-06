import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hashText } from '../src/hash.ts';
import { hashValue } from '../src/config/file-state.ts';
import { configMachine, REPO_FILES } from './config-machine.ts';

const backupIn = (note: string | undefined) => note?.match(/^ok: copied; backed up -> (.+)$/)?.[1];

test('applying a fresh machine writes every file, records each baseline, and backs up nothing', async () => {
  const m = configMachine();
  const { events } = await m.sync();
  assert.deepEqual(events.at(-1), { type: 'done', ok: 6, failed: 0, backups: undefined });
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), REPO_FILES['claude/CLAUDE.md']);
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), REPO_FILES['codex/openrouter-glm/config.toml']);
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'dark', model: 'opus' });
  assert.deepEqual(Object.keys(m.state().files).sort(), [
    'claude:CLAUDE.md', 'claude:settings.json#model', 'claude:settings.json#theme',
    'codex:AGENTS.md', 'codex:config.toml', 'codex:models-static.json',
  ]);
  assert.deepEqual((await m.sync()).plan.steps, []);
});

test('a pre-existing file is backed up before it is replaced', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# mine\n');
  const { notes } = await m.sync();
  const backup = backupIn(notes['config:claude:CLAUDE.md']);
  assert.ok(backup?.endsWith(join('claude', 'CLAUDE.md')), notes['config:claude:CLAUDE.md']);
  assert.equal(m.read(backup!), '# mine\n');
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), REPO_FILES['claude/CLAUDE.md']);
});

test('settings keys are merged, leaving every other key alone, after a copy of the original', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ mine: 1, theme: 'light' }));
  const { notes } = await m.sync();
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { mine: 1, theme: 'dark', model: 'opus' });
  assert.deepEqual(JSON.parse(m.read(backupIn(notes['config:claude:settings.json#theme'])!)!), { mine: 1, theme: 'light' });
});

test('a conflict is skipped and left alone; --take-repo resolves it after backing up the local side', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# local moved\n');
  const refused = await m.sync();
  assert.match(refused.plan.skipped.find((s) => s.key === 'config:claude:CLAUDE.md')!.reason, /both sides/);
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# local moved\n');
  const forced = await m.sync('apply', { force: true });
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# repo moved\n');
  assert.equal(m.read(backupIn(forced.notes['config:claude:CLAUDE.md'])!), '# local moved\n');
});

test('apply carries local project tables through and hashes only the managed part', async () => {
  const m = configMachine();
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "old"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  await m.sync();
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "glm"\n\n[projects."/w"]\ntrust_level = "trusted"\n');
  assert.equal(m.state().files['codex:config.toml']!.hash, hashText('model = "glm"\n'));
});

test('a converged file only refreshes its baseline', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# new\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# new\n');
  const { plan } = await m.sync();
  assert.deepEqual(plan.steps.map((s) => s.summary), ['record CLAUDE.md as in sync']);
  assert.equal(m.state().files['claude:CLAUDE.md']!.hash, hashText('# new\n'));
  assert.deepEqual((await m.sync()).plan.steps, []);
});

test('a file edited after inspect is not overwritten: its step fails with a note', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  const report = await m.report();
  const plan = m.plan(report);
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# edited meanwhile\n');
  const events = await m.execute(plan, report);
  const finished = events.find((e) => e.type === 'finished' && e.key === 'config:claude:CLAUDE.md');
  assert.deepEqual(finished && finished.type === 'finished' ? [finished.outcome, finished.note] : [], ['failed', 'changed since it was inspected; inspect again']);
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# edited meanwhile\n');
});

test('a symlinked settings file stays a link, and its target gains the keys', async () => {
  const m = configMachine();
  const target = join(m.root, 'dotfiles', 'settings.json');
  m.write(target, '{"mine":1}');
  mkdirSync(m.paths.claude, { recursive: true });
  symlinkSync(target, join(m.paths.claude, 'settings.json'));
  const { notes } = await m.sync();
  assert.ok(lstatSync(join(m.paths.claude, 'settings.json')).isSymbolicLink());
  const backup = backupIn(notes['config:claude:settings.json#theme'])!;
  assert.equal(lstatSync(backup).isSymbolicLink(), false);
  assert.equal(readFileSync(backup, 'utf8'), '{"mine":1}');
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { mine: 1, theme: 'dark', model: 'opus' });
});

test('a key the repo no longer owns loses its baseline at the next write of its document', async () => {
  const m = configMachine();
  await m.sync();
  const state = m.state();
  m.baselines({ ...Object.fromEntries(Object.entries(state.files).map(([k, v]) => [k, v.hash])), 'claude:settings.json#gone': hashValue(1)! });
  m.write(join(m.paths.repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
  await m.sync();
  assert.equal(Object.hasOwn(m.state().files, 'claude:settings.json#gone'), false);
  assert.equal(m.state().files['claude:settings.json#theme']!.hash, hashValue('light'));
});

test('a clean apply prunes the baseline of a key the repo no longer owns', async () => {
  const m = configMachine();
  await m.sync();
  const files = Object.fromEntries(Object.entries(m.state().files).map(([k, v]) => [k, v.hash]));
  // A whole-document baseline only shares the key prefix; pruning leaves it alone.
  const kept = { ...files, 'claude:settings.json': 'sha256:whole' };
  m.baselines({ ...kept, 'claude:settings.json#gone': hashValue(1)! });
  const { plan, notes } = await m.sync();
  assert.deepEqual(plan.steps.map((s) => [s.key, s.action, s.summary]), [
    ['config:claude:settings.json#theme', 'merge-keys', 'forget dropped keys of settings.json'],
  ]);
  assert.equal(notes['config:claude:settings.json#theme']?.startsWith('ok:'), true);
  assert.deepEqual(Object.keys(m.state().files).sort(), Object.keys(kept).sort());
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'dark', model: 'opus' });
  assert.deepEqual((await m.sync()).plan.steps, []);
});

test('capture takes a local edit into the repo after backing up the repo file', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# from machine\n');
  const { notes } = await m.sync('capture');
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# from machine\n');
  const backup = backupIn(notes['config:claude:CLAUDE.md'])!;
  assert.ok(backup.endsWith(join('claude', 'CLAUDE.md.repo')), backup);
  assert.equal(m.read(backup), REPO_FILES['claude/CLAUDE.md']);
  assert.equal(m.state().files['claude:CLAUDE.md']!.hash, hashText('# from machine\n'));
  assert.deepEqual((await m.sync('capture')).plan.steps, []);
});

test('capture on a fresh machine plans nothing and never publishes OpenRouter files', async () => {
  const m = configMachine();
  const { plan } = await m.sync('capture');
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.skipped.map((s) => s.key), ['config:codex:models-static.json', 'config:codex:config.toml']);
});

test('capture writes back only the locally edited settings key', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus', mine: 1 }));
  const { notes } = await m.sync('capture');
  assert.deepEqual(JSON.parse(m.read(join(m.paths.repo, 'claude/settings.keys.json'))!), { theme: 'light', model: 'opus' });
  assert.ok(backupIn(notes['config:claude:settings.json#theme'])?.endsWith(join('claude', 'settings.json.repo')));
});

test('capture refuses a credential-looking value and leaves the repo alone', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'ghp_abcdefgh123', model: 'opus' }));
  const { notes } = await m.sync('capture');
  assert.match(notes['config:claude:settings.json#theme']!, /^failed: refused: .*secret/);
  assert.equal(m.read(join(m.paths.repo, 'claude/settings.keys.json')), REPO_FILES['claude/settings.keys.json']);
});

test('a capture conflict is skipped, and --take-local resolves it', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo moved\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# local moved\n');
  assert.match((await m.sync('capture')).plan.skipped.find((s) => s.key === 'config:claude:CLAUDE.md')!.reason, /--take-local/);
  await m.sync('capture', { force: true });
  assert.equal(m.read(join(m.paths.repo, 'claude/CLAUDE.md')), '# local moved\n');
});

test('a conflicting key is skipped while its repo-ahead sibling is written', async () => {
  const m = configMachine();
  await m.sync();
  const settings = join(m.paths.claude, 'settings.json');
  m.write(settings, JSON.stringify({ theme: 'local', model: 'opus' }));
  m.write(join(m.paths.repo, 'claude/settings.keys.json'), JSON.stringify({ theme: 'light', model: 'sonnet' }));
  const { plan } = await m.sync();
  assert.deepEqual(JSON.parse(m.read(settings)!), { theme: 'local', model: 'sonnet' });
  assert.deepEqual(plan.steps.map((s) => s.key), ['config:claude:settings.json#model']);
  assert.deepEqual(plan.skipped.map((s) => s.key), ['config:claude:settings.json#theme']);
});
