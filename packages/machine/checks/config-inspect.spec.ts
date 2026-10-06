import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashText } from '../src/hash.ts';
import { hashValue } from '../src/config/file-state.ts';
import { splitProjectTrust } from '../src/config/project-trust.ts';
import { configMachine, REPO_FILES } from './config-machine.ts';

const find = <T extends { key: string }>(items: ReadonlyArray<T>, key: string): T => items.find((i) => i.key === key)!;

test('a fresh machine reports every managed file and settings key as unmanaged, to apply', async () => {
  const m = configMachine();
  const { items, probeErrors } = await m.observe();
  assert.deepEqual(probeErrors, []);
  assert.deepEqual(items.map((i) => [i.key, i.state, i.disposition, i.facts]), [
    ['config:claude:CLAUDE.md', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:AGENTS.md', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:models-static.json', 'unmanaged', 'apply', ['local-absent']],
    ['config:codex:config.toml', 'unmanaged', 'apply', ['local-absent']],
    ['config:claude:settings.json#theme', 'unmanaged', 'apply', ['local-absent']],
    ['config:claude:settings.json#model', 'unmanaged', 'apply', ['local-absent']],
  ]);
  assert.deepEqual([items[0]!.label, items[0]!.group, items[0]!.domain, items[0]!.target], ['CLAUDE.md', 'claude', 'config', 'claude']);
  assert.equal(items[4]!.label, 'settings.json#theme');
});

test('recorded files: clean, converged with a stale baseline, edited locally, deleted locally', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'CLAUDE.md'), REPO_FILES['claude/CLAUDE.md']!);
  m.write(join(m.paths.codex, 'AGENTS.md'), REPO_FILES['codex/AGENTS.md']!);
  m.write(join(m.paths.codexOpenRouter, 'models-static.json'), '{"mine":true}\n');
  m.baselines({
    'claude:CLAUDE.md': hashText(REPO_FILES['claude/CLAUDE.md']!),
    'codex:AGENTS.md': hashText('# older\n'),
    'codex:models-static.json': hashText(REPO_FILES['codex/openrouter-glm/models-static.json']!),
    'codex:config.toml': hashText(REPO_FILES['codex/openrouter-glm/config.toml']!),
  });
  const { items } = await m.observe();
  const view = (key: string) => { const i = find(items, key); return [i.state, i.disposition, i.facts]; };
  assert.deepEqual(view('config:claude:CLAUDE.md'), ['clean', 'in-sync', ['recorded']]);
  assert.deepEqual(view('config:codex:AGENTS.md'), ['clean', 'in-sync', ['recorded', 'local-changed', 'baseline-stale']]);
  assert.deepEqual(view('config:codex:models-static.json'), ['local-ahead', 'capture', ['recorded', 'local-changed']]);
  assert.deepEqual(view('config:codex:config.toml'), ['repo-ahead', 'apply', ['recorded', 'local-changed', 'local-absent']]);
});

test('project tables never count as drift', async () => {
  const m = configMachine();
  const repo = REPO_FILES['codex/openrouter-glm/config.toml']!;
  m.write(join(m.paths.codexOpenRouter, 'config.toml'), `${repo}\n[projects."/w"]\ntrust_level = "trusted"\n`);
  m.baselines({ 'codex:config.toml': hashText(splitProjectTrust(repo).managed) });
  const { items } = await m.observe();
  assert.equal(find(items, 'config:codex:config.toml').state, 'clean');
});

test('settings keys: an edited key is local-ahead, and keys the repo does not name are not items', async () => {
  const m = configMachine();
  m.write(join(m.paths.claude, 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus', mine: 1 }));
  m.baselines({ 'claude:settings.json#theme': hashValue('dark')!, 'claude:settings.json#model': hashValue('opus')! });
  const { items } = await m.observe();
  const settings = items.filter((i) => i.key.startsWith('config:claude:settings.json'));
  assert.deepEqual(settings.map((i) => [i.key, i.state, i.disposition, i.facts]), [
    ['config:claude:settings.json#theme', 'local-ahead', 'capture', ['recorded', 'local-changed']],
    ['config:claude:settings.json#model', 'clean', 'in-sync', ['recorded']],
  ]);
});

test('an invalid, absent or locally unparseable settings document is one blocked item', async () => {
  const invalid = configMachine({ ...REPO_FILES, 'claude/settings.keys.json': '{"env":{"API_KEY":"x"}}' });
  const one = find((await invalid.observe()).items, 'config:claude:settings.json');
  assert.deepEqual([one.state, one.disposition], ['invalid', 'blocked']);
  assert.match(one.note ?? '', /looks like a secret/);

  const { 'claude/settings.keys.json': _dropped, ...withoutSettings } = REPO_FILES;
  const absent = configMachine(withoutSettings);
  assert.equal(find((await absent.observe()).items, 'config:claude:settings.json').state, 'missing-repo');

  const broken = configMachine();
  broken.write(join(broken.paths.claude, 'settings.json'), '{ broken');
  const items = (await broken.observe()).items.filter((i) => i.key.startsWith('config:claude:settings.json'));
  assert.deepEqual(items.map((i) => [i.key, i.state, i.disposition]), [['config:claude:settings.json', 'unparseable-local', 'blocked']]);

  // Valid JSON that is not an object is just as unusable.
  broken.write(join(broken.paths.claude, 'settings.json'), '["theme"]');
  assert.equal(find((await broken.observe()).items, 'config:claude:settings.json').state, 'unparseable-local');
});

test('a skills-only machine still reads every file but excludes it', async () => {
  const m = configMachine();
  const { items } = await m.observe({ value: { manageConfig: false }, source: 'overrides.json', issues: [] });
  assert.ok(items.length === 6 && items.every((i) => i.disposition === 'excluded' && i.state === 'unmanaged'));
  assert.deepEqual(items[0]!.from, { layer: 'machine', source: 'overrides.json' });
});

test('unreadable machine state is a probe error, not a guess', async () => {
  const m = configMachine();
  mkdirSync(join(m.paths.stateRoot, 'state.json'), { recursive: true });
  const { items, probeErrors } = await m.observe();
  assert.deepEqual(items, []);
  assert.equal(probeErrors.length, 1);
  assert.match(probeErrors[0]!, /^config: /);
});
