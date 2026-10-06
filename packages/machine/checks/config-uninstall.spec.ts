import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CHANGED_SINCE_APPLY, splitOutcome } from '../src/index.ts';
import { hashValue } from '../src/config/file-state.ts';
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

test('a symlinked settings file gets its original values back through the link', async () => {
  const m = configMachine();
  const target = join(m.root, 'dotfiles', 'settings.json');
  m.write(target, JSON.stringify({ theme: 'light', mine: 'x' }));
  mkdirSync(m.paths.claude, { recursive: true });
  const link = join(m.paths.claude, 'settings.json');
  symlinkSync(target, link);
  await m.sync();
  await m.sync('uninstall');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { theme: 'light', mine: 'x' });
});

test('the repo copy that capture displaces is never read as the original', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# mine\n');
  await m.sync('capture');
  const { notes } = await m.sync('uninstall');
  assert.equal(existsSync(join(m.paths.claude, 'CLAUDE.md')), false);
  const backup = notes['config:claude:CLAUDE.md']!.match(/^ok: removed; backed up -> (.+)$/)?.[1];
  assert.equal(m.read(backup!), '# mine\n');
});

test('the earliest run holds the original when a later run backed the file up again', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# first\n');
  await m.sync();
  m.write(join(m.paths.repo, 'claude/CLAUDE.md'), '# repo v2\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# second\n');
  m.baselines({});
  await m.sync();
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# repo v2\n');
  await m.sync('uninstall', { force: true });
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# first\n');
});

// Issue #72, hard cutoff: before #67 a capture backed the repo copy up where an original goes, so a backup
// from before then is never restored; the file is removed and that backup is named instead.
test('a file whose earliest backup predates the cutoff is removed, naming that backup', async () => {
  const m = configMachine();
  const old = join(m.paths.backups, 'nortuscc-2026-10-05T12-00-00-000Z', 'claude', 'CLAUDE.md');
  m.write(old, '# repo copy from an old capture\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# mine\n');
  await m.sync();
  const { notes } = await m.sync('uninstall');
  assert.equal(existsSync(join(m.paths.claude, 'CLAUDE.md')), false);
  const outcome = splitOutcome(notes['config:claude:CLAUDE.md']!.replace(/^ok: /, ''));
  assert.equal(outcome.action, 'removed');
  assert.equal(outcome.older, old);
  assert.equal(m.read(old), '# repo copy from an old capture\n');
  assert.equal(m.read(outcome.backedUp!), '# repo claude\n');
});

test('a file first backed up after the cutoff still gets its original back', async () => {
  const m = configMachine();
  m.write(join(m.paths.backups, 'nortuscc-2026-10-05T12-00-00-000Z', 'codex', 'AGENTS.md'), '# unrelated\n');
  m.write(join(m.paths.claude, 'CLAUDE.md'), '# mine\n');
  await m.sync();
  const { notes } = await m.sync('uninstall');
  assert.equal(m.read(join(m.paths.claude, 'CLAUDE.md')), '# mine\n');
  assert.equal(splitOutcome(notes['config:claude:CLAUDE.md']!.replace(/^ok: /, '')).older, undefined);
});

// A key recorded at apply time that the repo has since dropped still belongs to uninstall.
const dropKey = (m: ReturnType<typeof configMachine>, extra: Record<string, string>) =>
  m.baselines({ ...Object.fromEntries(Object.entries(m.state().files).map(([k, v]) => [k, v.hash])), ...extra });

test('a locally edited key the repo no longer owns refuses uninstall until forced', async () => {
  const m = configMachine();
  await m.sync();
  dropKey(m, { 'claude:settings.json#zzStale': hashValue('applied')! });
  const settings = join(m.paths.claude, 'settings.json');
  m.write(settings, JSON.stringify({ ...JSON.parse(m.read(settings)!), zzStale: 'edited' }));

  const refused = m.plan(await m.report(), 'uninstall');
  assert.deepEqual(refused.skipped, [{ key: 'config:claude:settings.json', reason: CHANGED_SINCE_APPLY }]);

  await m.sync('uninstall', { force: true });
  assert.equal(existsSync(settings), false);
  assert.deepEqual(m.state().files, {});
});

test('a document whose only baseline is a dropped key is still uninstalled', async () => {
  const m = configMachine();
  const settings = join(m.paths.claude, 'settings.json');
  m.write(settings, JSON.stringify({ zzStale: 'applied', mine: 1 }));
  m.baselines({ 'claude:settings.json#zzStale': hashValue('applied')! });

  const { plan } = await m.sync('uninstall');
  assert.deepEqual(plan.steps.map((s) => s.key), ['config:claude:settings.json']);
  assert.deepEqual(JSON.parse(m.read(settings)!), { mine: 1 });
  assert.deepEqual(m.state().files, {});
});

// An old run could back a symlinked settings file up as the link itself: it points at the live file.
for (const force of [false, true]) {
  test(`a link backup of a settings file is refused, changing nothing${force ? ', even forced' : ''}`, async () => {
    const m = configMachine();
    await m.sync();
    const settings = join(m.paths.claude, 'settings.json');
    const before = m.read(settings);
    const baselines = m.state().files;
    const backup = join(m.paths.backups, 'nortuscc-2026-10-06T00-00-00-000Z', 'claude', 'settings.json');
    mkdirSync(join(backup, '..'), { recursive: true });
    symlinkSync(settings, backup);

    const { notes } = await m.sync('uninstall', { force });
    assert.match(notes['config:claude:settings.json']!, /^failed: .*is a link/);
    assert.equal(m.read(settings), before);
    assert.ok(lstatSync(backup).isSymbolicLink());
    assert.deepEqual(
      Object.keys(m.state().files).filter((k) => k.startsWith('claude:settings.json#')),
      Object.keys(baselines).filter((k) => k.startsWith('claude:settings.json#')),
    );
  });
}
