import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGED_SINCE_APPLY } from '../src/index.ts';
import { configMachine } from './config-machine.ts';

test('uninstalling a fresh-machine apply removes every file and baseline', async () => {
  const m = configMachine();
  await m.sync();
  const { notes, events } = await m.sync('uninstall');
  assert.deepEqual(events.at(-1)?.type, 'done');
  for (const path of [
    join(m.paths.claude, 'CLAUDE.md'), join(m.paths.claude, 'settings.json'), join(m.paths.codex, 'AGENTS.md'),
    join(m.paths.codexOpenRouter, 'config.toml'), join(m.paths.codexOpenRouter, 'models-static.json'),
  ]) assert.equal(existsSync(path), false, path);
  assert.deepEqual(m.state().files, {});
  assert.match(notes['config:claude:settings.json']!, /^ok: removed; backed up -> .*uninstall/);
});

test('originals come back, and unrelated edits and project tables stay', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# original\n');
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "original"\n');
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', mine: 'before' }));
  await m.sync();
  const settings = JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!);
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ ...settings, mine: 'after' }));
  m.write(join(m.paths.codexOpenRouter, 'config.toml'),
    `${m.read(join(m.paths.codexOpenRouter, 'config.toml'))}\n[projects."/added"]\ntrust_level = "trusted"\n`);

  const { events } = await m.sync('uninstall');
  assert.deepEqual(events.at(-1)?.type, 'done');
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# original\n');
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "original"\n\n[projects."/added"]\ntrust_level = "trusted"\n');
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'light', mine: 'after' });
});

test('a changed file is refused until forced, and the forced run keeps a copy of it', async () => {
  const m = configMachine();
  await m.sync();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# changed\n');
  const refused = m.plan(await m.report(), 'uninstall');
  assert.deepEqual(refused.skipped, [{ key: 'config:claude:CLAUDE.md', reason: CHANGED_SINCE_APPLY }]);
  assert.equal(refused.steps.some((s) => s.key === 'config:claude:CLAUDE.md'), false);

  const { notes } = await m.sync('uninstall', { force: true });
  const backup = notes['config:claude:CLAUDE.md']!.match(/^ok: removed; backed up -> (.+)$/)?.[1];
  assert.equal(m.read(backup!), '# changed\n');
  assert.equal(existsSync(join(m.paths.claude, 'CLAUDE.md')), false);
});

test('a pre-existing symlink is restored as the same link', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'mine.md'), '# mine\n');
  symlinkSync('mine.md', join(m.paths.claude, 'CLAUDE.md'));
  await m.sync();
  await m.sync('uninstall');
  const restored = join(m.paths.claude, 'CLAUDE.md');
  assert.ok(lstatSync(restored).isSymbolicLink());
  assert.equal(readlinkSync(restored), 'mine.md');
});

test('deleted managed files come back whole from their originals under force', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', mine: 'original' }));
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), 'model = "original"\n\n[projects."/o"]\ntrust_level = "trusted"\n');
  await m.sync();
  rmSync(join(m.paths.claude, 'settings.json'));
  rmSync(join(m.paths.codexOpenRouter, 'config.toml'));
  await m.sync('uninstall', { force: true });
  assert.deepEqual(JSON.parse(m.read(join(m.paths.claude, 'settings.json'))!), { theme: 'light', mine: 'original' });
  assert.equal(m.read(join(m.paths.codexOpenRouter, 'config.toml')), 'model = "original"\n\n[projects."/o"]\ntrust_level = "trusted"\n');
});

test('malformed settings are moved aside under force, and an empty original comes back empty', async () => {
  const broken = configMachine();
  await broken.sync();
  broken.write(join(broken.paths.claude, 'settings.json'), '{ malformed');
  const { notes } = await broken.sync('uninstall', { force: true });
  assert.equal(readFileSync(notes['config:claude:settings.json']!.match(/backed up -> (.+)$/)![1]!, 'utf8'), '{ malformed');
  assert.equal(existsSync(join(broken.paths.claude, 'settings.json')), false);

  const empty = configMachine();
  mkdirSync(empty.paths.claude, { recursive: true });
  empty.write(join(empty.paths.claude, 'settings.json'), '{}\n');
  await empty.sync();
  await empty.sync('uninstall');
  assert.deepEqual(JSON.parse(empty.read(join(empty.paths.claude, 'settings.json'))!), {});
});
