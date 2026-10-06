import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { backupsForRun, machinePaths, nodeFs } from '../src/index.ts';
import { hookCommand, inspectHook, installHook } from '../src/integrations/hooks.ts';
import type { Declaration } from '../src/integrations/declaration.ts';

const ITEM: Declaration = {
  id: 'nortuscc-demo-hook', label: 'demo hook', target: 'claude', type: 'hook', default: false,
  event: 'SessionStart', file: 'claude/hooks/nortuscc-hook.mjs',
};

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-hooks-'));
  const repo = join(home, 'repo');
  const claude = join(home, '.claude');
  mkdirSync(join(repo, 'claude', 'hooks'), { recursive: true });
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(repo, 'claude', 'hooks', 'nortuscc-hook.mjs'), '// hook body\n');
  const paths = {
    repo, claude, codex: join(home, '.codex'), codexOpenRouter: join(home, '.codex-openrouter'),
    agentsSkills: join(home, 'skills'), stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  const layer = backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const settings = join(claude, 'settings.json');
  return {
    repo, claude, settings, paths,
    install: () => Effect.runPromise(installHook({ repo, claude }, ITEM).pipe(Effect.provide(layer))),
    inspect: () => Effect.runPromise(inspectHook(claude, ITEM).pipe(Effect.provide(nodeFs))),
    read: () => JSON.parse(readFileSync(settings, 'utf8')),
    backups: () => (existsSync(paths.backups) ? readdirSync(paths.backups) : []),
  };
};

test('hook registration preserves every unrelated key and hook', async () => {
  const fx = fixture();
  const before = {
    theme: 'dark', permissions: { allow: ['Bash(gh pr view:*)'] }, enabledPlugins: { 'a@b': true },
    hooks: { Stop: [{ hooks: [{ command: 'mine' }] }] },
  };
  writeFileSync(fx.settings, JSON.stringify(before));
  await fx.install();
  const after = fx.read();
  for (const key of ['theme', 'permissions', 'enabledPlugins'] as const) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(after.hooks.Stop, before.hooks.Stop);
  assert.match(JSON.stringify(after.hooks.SessionStart), /nortuscc-hook/);
});

test('the settings file is backed up in the legacy layout before it changes', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, JSON.stringify({ theme: 'dark' }));
  await fx.install();
  const [run] = fx.backups();
  assert.ok(run?.startsWith('nortuscc-'));
  assert.equal(readFileSync(join(fx.paths.backups, run!, 'claude', 'settings.json'), 'utf8'), JSON.stringify({ theme: 'dark' }));
});

test('the hook file is copied into the Claude hooks directory', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  assert.equal((await fx.install()).ok, true);
  assert.equal(readFileSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'), 'utf8'), '// hook body\n');
});

// Re-running must not make the hook fire twice.
test('registering twice does not duplicate the entry', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  await fx.install();
  assert.deepEqual(await fx.install(), { ok: true, note: 'already registered' });
  const commands = fx.read().hooks.SessionStart.flatMap((g: { hooks?: { command: string }[] }) => g.hooks ?? [])
    .filter((h: { command: string }) => h.command.endsWith('nortuscc-hook.mjs'));
  assert.equal(commands.length, 1);
});

test('an existing hook on the same event is kept alongside the new one', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'someone-elses-hook' }] }] } }));
  await fx.install();
  const json = JSON.stringify(fx.read().hooks.SessionStart);
  assert.match(json, /someone-elses-hook/);
  assert.match(json, /nortuscc-hook/);
});

test('a missing settings file is created, with nothing to back up', async () => {
  const fx = fixture();
  assert.equal((await fx.install()).ok, true);
  assert.deepEqual(fx.backups(), []);
  assert.match(JSON.stringify(fx.read()), /nortuscc-hook/);
});

// The user's file, possibly mid-edit: never replaced, and nothing else is touched either.
test('a corrupt settings file is refused and nothing is written or copied', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{ not json');
  const result = await fx.install();
  assert.equal(result.ok, false);
  assert.match(result.note ?? '', /settings\.json could not be parsed/);
  assert.equal(readFileSync(fx.settings, 'utf8'), '{ not json');
  assert.equal(existsSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs')), false);
  assert.equal((await fx.inspect()).state, 'blocked');
});

test('inspection reads missing, then installed once registered', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  assert.equal((await fx.inspect()).state, 'missing');
  await fx.install();
  assert.equal((await fx.inspect()).state, 'installed');
});

// Registered but the file was deleted: missing again, and a reinstall restores the file without a second entry.
test('a registered hook whose file is gone reads as missing', async () => {
  const fx = fixture();
  writeFileSync(fx.settings, '{}');
  await fx.install();
  rmSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'));
  assert.equal((await fx.inspect()).state, 'missing');
  assert.deepEqual(await fx.install(), { ok: true, note: 'already registered' });
  assert.equal(existsSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs')), true);
});

test('the registered command points at the installed copy, not the repo', () => {
  const fx = fixture();
  const command = hookCommand(fx.claude, ITEM);
  assert.equal(command, `node ${join(fx.claude, 'hooks', 'nortuscc-hook.mjs')}`);
  assert.ok(!command.includes(fx.repo));
});

test('an existing hook file with other content is backed up, then replaced', async () => {
  const fx = fixture();
  mkdirSync(join(fx.claude, 'hooks'), { recursive: true });
  writeFileSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'), '// my own hook\n');
  await fx.install();
  assert.equal(readFileSync(join(fx.claude, 'hooks', 'nortuscc-hook.mjs'), 'utf8'), '// hook body\n');
  const run = fx.backups();
  assert.equal(run.length, 1);
  const found = readdirSync(join(fx.paths.backups, run[0]!), { recursive: true }).map(String).filter((p) => p.endsWith('nortuscc-hook.mjs'));
  assert.equal(found.length, 1);
  assert.equal(readFileSync(join(fx.paths.backups, run[0]!, found[0]!), 'utf8'), '// my own hook\n');
});

test('an identical installed hook is left alone, with nothing backed up', async () => {
  const fx = fixture();
  await fx.install();
  // First install on a bare machine displaces nothing, so no backup exists yet.
  assert.deepEqual(fx.backups(), []);
  await fx.install();
  assert.deepEqual(fx.backups(), []);
});
