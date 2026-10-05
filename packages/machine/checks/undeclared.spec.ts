import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import type { DesiredConfig, Integration } from '@nortuscc/profile-engine';
import {
  BUILTIN_MARKETPLACES, declaredIds, machinePaths, manifestDefects, marketplaceOf, nodeFs, observedAgents,
  observedHooks, observedSkillLinks, probeUndeclared,
} from '../src/index.ts';

const machine = () => {
  const home = mkdtempSync(join(tmpdir(), 'machine-undeclared-'));
  const paths = {
    repo: join(home, 'repo'), claude: join(home, '.claude'), codex: join(home, '.codex'),
    codexOpenRouter: join(home, '.codex-openrouter'), agentsSkills: join(home, '.agents', 'skills'),
    stateRoot: join(home, 'state'), backups: join(home, 'state', 'backups'),
  };
  mkdirSync(join(paths.claude, 'skills'), { recursive: true });
  mkdirSync(paths.agentsSkills, { recursive: true });
  const layer = Layer.mergeAll(machinePaths(paths), nodeFs);
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(layer)) as Effect.Effect<A, E>);
  return { home, paths, run, layer };
};

const plugin = (id: string, name: string): Integration => ({ id, label: id, target: 'claude', type: 'plugin', default: true, plugin: name });
const market = (id: string, name: string): Integration =>
  ({ id, label: id, target: 'claude', type: 'marketplace', default: true, marketplace: `o/${name}`, name });

test('marketplaceOf splits the marketplace off a plugin id', () => {
  assert.equal(marketplaceOf('superpowers@claude-plugins-official'), 'claude-plugins-official');
  assert.equal(marketplaceOf('bare-name'), null);
  assert.equal(marketplaceOf('@leading'), null);
});

test('declaredIds collects plugins, marketplaces and hook commands', () => {
  const declared = declaredIds([plugin('a', 'foo@bar'), market('b', 'bar')], ['node /h/x.mjs']);
  assert.ok(declared.plugins.has('foo@bar'));
  assert.ok(declared.marketplaces.has('bar'));
  assert.ok(declared.hooks.has('node /h/x.mjs'));
});

test('both agents built-in marketplaces count as declared', () => {
  for (const name of ['claude-plugins-official', 'openai-curated']) {
    assert.ok(BUILTIN_MARKETPLACES.has(name));
    assert.ok(declaredIds([], []).marketplaces.has(name));
  }
});

test('a declared plugin whose marketplace is undeclared is a manifest defect', () => {
  assert.deepEqual(manifestDefects([plugin('a', 'foo@bar')]), [
    { key: 'foo@bar', label: 'foo@bar', note: "marketplace 'bar' is not declared" },
  ]);
  assert.deepEqual(manifestDefects([plugin('a', 'foo@bar'), market('b', 'bar')]), []);
  assert.deepEqual(manifestDefects([plugin('a', 'superpowers@claude-plugins-official')]), []);
});

test('a missing agents directory observes nothing and is not an error', async () => {
  const { run } = machine();
  assert.deepEqual(await run(observedAgents), { items: [], errors: [] });
});

test('an agents symlink is observed and reports its target; dot entries are skipped', async () => {
  const { home, paths, run } = machine();
  mkdirSync(join(paths.claude, 'agents', '.internal'), { recursive: true });
  mkdirSync(join(home, 'elsewhere'));
  symlinkSync(join(home, 'elsewhere'), join(paths.claude, 'agents', 'awesome-claude-agents'));
  writeFileSync(join(paths.claude, 'agents', 'plain.md'), 'x');
  assert.deepEqual(await run(observedAgents), {
    items: [
      { key: 'awesome-claude-agents', label: 'awesome-claude-agents', note: `-> ${join(home, 'elsewhere')}` },
      { key: 'plain.md', label: 'plain.md', note: '' },
    ],
    errors: [],
  });
});

test('skill links resolve, so relative and absolute forms both read as the store', async () => {
  const { home, paths, run } = machine();
  for (const name of ['relative-one', 'absolute-one']) mkdirSync(join(paths.agentsSkills, name));
  symlinkSync('../../.agents/skills/relative-one', join(paths.claude, 'skills', 'relative-one'));
  symlinkSync(join(home, '.agents', 'skills', 'absolute-one'), join(paths.claude, 'skills', 'absolute-one'));
  assert.deepEqual(await run(observedSkillLinks), { items: [], errors: [] });
});

test('a real directory, or a link outside the store, did not come from the store', async () => {
  const { home, paths, run } = machine();
  mkdirSync(join(paths.claude, 'skills', 'wayfinder'));
  mkdirSync(join(home, 'other-skills', 'stray'), { recursive: true });
  symlinkSync(join(home, 'other-skills', 'stray'), join(paths.claude, 'skills', 'stray'));
  const { items, errors } = await run(observedSkillLinks);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => i.key), ['stray', 'wayfinder']);
  assert.match(items[1]!.note, /^not from the shared store \(-> .*wayfinder\)$/);
});

test('a broken link is observed as broken rather than silently skipped', async () => {
  const { paths, run } = machine();
  symlinkSync(join(paths.agentsSkills, 'gone'), join(paths.claude, 'skills', 'gone'));
  assert.deepEqual((await run(observedSkillLinks)).items, [{ key: 'gone', label: 'gone', note: 'broken link' }]);
});

test('with no store at all, every entry came from somewhere else', async () => {
  const { paths, run } = machine();
  rmSync(paths.agentsSkills, { recursive: true });
  mkdirSync(join(paths.claude, 'skills', 'mine'));
  assert.deepEqual((await run(observedSkillLinks)).items.map((i) => i.key), ['mine']);
});

// Fs.realPath reads ENOTDIR as absent, so the unusable store here is one behind an unreadable directory.
test('a store that cannot be resolved is an error, not "everything is undeclared"', async (t) => {
  const { home, paths, run } = machine();
  if (process.getuid?.() === 0) return t.skip('permissions are not enforced for root');
  const locked = join(home, 'locked');
  mkdirSync(join(locked, 'skills'), { recursive: true });
  mkdirSync(join(paths.claude, 'skills', 'have'));
  chmodSync(locked, 0o000);
  try {
    const result = await Effect.runPromise(observedSkillLinks.pipe(
      Effect.provide(Layer.mergeAll(machinePaths({ ...paths, agentsSkills: join(locked, 'skills') }), nodeFs)),
    ));
    assert.deepEqual(result.items, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!, new RegExp(`^could not resolve ${join(locked, 'skills')}: `));
  } finally {
    chmodSync(locked, 0o755);
  }
});

test('an unreadable agents directory is an error, never an empty observation', async () => {
  const { paths, run } = machine();
  writeFileSync(join(paths.claude, 'agents'), 'not a directory');
  const { items, errors } = await run(observedAgents);
  assert.deepEqual(items, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, new RegExp(`^could not read ${join(paths.claude, 'agents')}: `));
});

test('no settings file, and settings without hooks, observe nothing', async () => {
  const { paths, run } = machine();
  assert.deepEqual(await run(observedHooks), { items: [], errors: [] });
  writeFileSync(join(paths.claude, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  assert.deepEqual(await run(observedHooks), { items: [], errors: [] });
});

test('a hook registration is keyed on its command and labelled by event', async () => {
  const { paths, run } = machine();
  writeFileSync(join(paths.claude, 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /h/x.mjs' }, { type: 'command' }] }], Bad: 'nope' },
  }));
  assert.deepEqual(await run(observedHooks), {
    items: [{ key: 'node /h/x.mjs', label: 'SessionStart', note: 'node /h/x.mjs' }],
    errors: [],
  });
});

test('unparseable settings is an error, not an empty observation', async () => {
  const { paths, run } = machine();
  writeFileSync(join(paths.claude, 'settings.json'), '{ not json');
  assert.deepEqual(await run(observedHooks), { items: [], errors: [`could not parse ${join(paths.claude, 'settings.json')}`] });
});

const desired = (integrations: Integration[], allow: DesiredConfig['allow'] = {}): DesiredConfig => ({
  files: [], skills: [], allow, issues: [],
  integrations: integrations.map((declaration) => ({
    id: declaration.id, declaration, enabled: true, from: { layer: 'base', source: 'integrations.json' },
  })),
});

test('probeUndeclared reports what no declaration or allow entry names, in category order', async () => {
  const { paths, run } = machine();
  mkdirSync(join(paths.claude, 'agents'));
  writeFileSync(join(paths.claude, 'agents', 'allowed.md'), 'x');
  writeFileSync(join(paths.claude, 'agents', 'stray.md'), 'x');
  mkdirSync(join(paths.claude, 'skills', 'hand-made'));
  writeFileSync(join(paths.claude, 'settings.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: 'node /h/mine.mjs' }, { command: 'node /h/other.mjs' }] }] },
  }));
  const result = await run(probeUndeclared(
    desired([plugin('d', 'declared@dm')], { agents: ['allowed.md'] }),
    {
      targets: ['claude', 'codex'],
      installed: [
        { target: 'claude', plugins: ['declared@dm'], marketplaces: ['dm'] },
        { target: 'codex', plugins: ['p@m'], marketplaces: ['openai-curated'] },
      ],
      hookCommands: ['node /h/mine.mjs'],
    },
  ));
  assert.deepEqual(result.probeErrors, []);
  const item = (o: object) => ({ state: 'undeclared', disposition: 'undeclared', ...o });
  assert.deepEqual(result.items, [
    item({ key: 'undeclared:agents:stray.md', domain: 'config', target: 'claude', group: 'agents', label: 'stray.md', note: '' }),
    item({ key: 'undeclared:plugins:p@m', domain: 'integrations', target: 'codex', group: 'plugins', label: 'p@m', note: '' }),
    item({ key: 'undeclared:marketplaces:dm', domain: 'integrations', target: 'claude', group: 'marketplaces', label: 'dm', note: '' }),
    item({ key: 'undeclared:hooks:node /h/other.mjs', domain: 'integrations', target: 'claude', group: 'hooks', label: 'Stop', note: 'node /h/other.mjs' }),
    item({
      key: 'undeclared:skills:hand-made', domain: 'skills', target: 'claude', group: 'skills', label: 'hand-made',
      note: `not from the shared store (-> ${realpathSync(join(paths.claude, 'skills', 'hand-made'))})`,
    }),
    { key: 'undeclared:manifest:declared@dm', domain: 'integrations', target: 'claude', group: 'manifest', label: 'declared@dm',
      state: 'defect', disposition: 'undeclared', note: "marketplace 'dm' is not declared" },
  ]);
});

test('claude-side categories are not walked for a codex-only probe, and errors name their category', async () => {
  const { paths, run } = machine();
  mkdirSync(join(paths.claude, 'agents', 'stray'), { recursive: true });
  const codexOnly = await run(probeUndeclared(desired([]), {
    targets: ['codex'], installed: [{ target: 'codex', plugins: ['c@cm'], marketplaces: [] }], hookCommands: [],
  }));
  assert.deepEqual(codexOnly.items.map((i) => i.key), ['undeclared:plugins:c@cm']);

  writeFileSync(join(paths.claude, 'settings.json'), '{ not json');
  const broken = await run(probeUndeclared(desired([]), { targets: ['claude'], installed: [], hookCommands: [] }));
  assert.deepEqual(broken.probeErrors, [`hooks: could not parse ${join(paths.claude, 'settings.json')}`]);
});
