import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import {
  ProfileFiles, loadProfile, loadNamedProfile, listProfiles, memoryFiles, nodeFiles,
  resolveNamedProfile, profilesUsingPath, parseProfileDocument, decodeOverrides,
} from '../src/index.ts';

const root = {
  'skills-manifest.txt': '[a/core] exact\ntdd\nwizard\n',
  'claude/settings.keys.json': '{"effortLevel":"high"}',
  'integrations.json': JSON.stringify({ version: 1, integrations: [
    { id: 'on', label: 'On', target: 'claude', type: 'plugin', default: true, plugin: 'on@x' },
    { id: 'off', label: 'Off', target: 'claude', type: 'plugin', default: false, plugin: 'off@x' },
  ] }),
};
const doc = (value: unknown) => JSON.stringify(value);
const run = <A, E>(effect: Effect.Effect<A, E, ProfileFiles>, documents: Readonly<Record<string, string>> = root) =>
  Effect.runPromise(effect.pipe(Effect.provide(memoryFiles(Object.fromEntries(
    Object.entries(documents).map(([path, text]) => [join('/repo', path), text]),
  )))));
const resolve = (documents: Readonly<Record<string, string>>, name = 'personal') => resolveNamedProfile({ documents: { ...root, ...documents }, name });
const origin = (name: string) => ({ layer: 'profile', source: `profiles/${name}.json` });

test('a repo without profiles/ has exactly the default profile and resolves like today', async () => {
  assert.deepEqual(await run(listProfiles('/repo')), ['default']);
  assert.deepEqual(await run(loadNamedProfile('/repo', 'default')), await run(loadProfile('/repo')));
  assert.deepEqual(resolveNamedProfile({ documents: root, name: 'default' }), await run(loadProfile('/repo')));
  const error = await run(Effect.flip(loadNamedProfile('/repo', 'personal')));
  assert.equal(error._tag, 'ProfileInvalid');
});

test('profiles/default.json containing {} resolves like the implicit default', async () => {
  const documents = { ...root, 'profiles/default.json': '{}' };
  assert.deepEqual(await run(listProfiles('/repo'), documents), ['default']);
  assert.deepEqual(await run(loadNamedProfile('/repo', 'default'), documents), await run(loadProfile('/repo')));
});

test('an empty profiles/ directory is invalid, not the implicit default', async () => {
  const fixtures: Readonly<Record<string, string>>[] = [{ 'profiles/': '' }, { 'profiles/readme.txt': 'notes' }];
  for (const documents of fixtures) {
    const error = await run(Effect.flip(listProfiles('/repo')), documents);
    assert.equal(error._tag, 'ProfileInvalid');
    assert.match(error.issues[0]!.message, /profiles\/ has no profiles/);
    const loadError = await run(Effect.flip(loadNamedProfile('/repo', 'default')), documents);
    assert.equal(loadError._tag, 'ProfileInvalid');
  }
});

test('a child inherits its parent\'s skills and removes one', () => {
  const config = resolve({
    'profiles/base.json': doc({ skills: { add: [{ source: 'b/extra', names: ['explain'] }] } }),
    'profiles/personal.json': doc({ extends: 'base', skills: { remove: [{ source: 'a/core', names: ['wizard'] }] } }),
  });
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills.filter(s => s.install).map(s => s.name), ['tdd', 'explain']);
  assert.deepEqual(config.skills.find(s => s.name === 'wizard')!.from, origin('personal'));
  assert.deepEqual(config.skills.find(s => s.name === 'explain')!.from, origin('base'));
});

test('a child replaces one file\'s repo path and excludes another', () => {
  const config = resolve({
    'profiles/base.json': '{}',
    'profiles/personal.json': doc({ extends: 'base', files: { 'claude:CLAUDE.md': 'claude/personal.md', 'codex:config.toml': null } }),
  });
  assert.deepEqual(config.issues, []);
  assert.equal(config.files.find(f => f.id === 'claude:CLAUDE.md')!.src, 'claude/personal.md');
  assert.equal(config.files.find(f => f.id === 'codex:config.toml')!.managed, false);
  assert.equal(config.files.find(f => f.id === 'codex:AGENTS.md')!.managed, true);
});

test('an extends cycle reports the whole chain', () => {
  const config = resolve({ 'profiles/personal.json': '{"extends":"base"}', 'profiles/base.json': '{"extends":"personal"}' });
  assert.match(config.issues[0]!.message, /personal -> base -> personal/);
});

test('a missing parent is reported with its name', () => {
  assert.match(resolve({ 'profiles/personal.json': '{"extends":"missing"}' }).issues[0]!.message, /personal -> missing/);
});

test('inheritance is limited to eight profiles', () => {
  const documents = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`profiles/p${i}.json`, doc(i === 8 ? {} : { extends: `p${i + 1}` })]));
  assert.deepEqual(resolve(documents, 'p1').issues, []);
  assert.match(resolve(documents, 'p0').issues[0]!.message, /p0 -> p1 -> p2 -> p3 -> p4 -> p5 -> p6 -> p7 -> p8/);
});

test('a pin for a source only another profile uses is not an issue', () => {
  const config = resolve({
    'profiles/personal.json': '{}',
    'profiles/team.json': doc({ skills: { add: [{ source: 'b/team', names: ['review'] }] } }),
    'skill-pins.json': doc({ version: 1, pins: { 'b/team': 'a'.repeat(40) } }),
  });
  assert.deepEqual(config.issues, []);
  assert.ok(config.skills.every(s => s.pin === undefined));
});

test('profilesUsingPath lists every profile that resolves a file to that path', () => {
  const documents = { ...root,
    'profiles/base.json': doc({ files: { 'claude:CLAUDE.md': 'claude/shared.md' } }),
    'profiles/personal.json': '{"extends":"base"}',
    'profiles/team.json': doc({ extends: 'base', files: { 'claude:CLAUDE.md': null } }),
  };
  assert.deepEqual(profilesUsingPath(documents, 'claude/shared.md'), ['base', 'personal']);
  assert.deepEqual(profilesUsingPath(root, 'codex/AGENTS.md'), ['default']);
});

test('profilesUsingPath retains profiles with unrelated skill pin issues', () => {
  const documents = { ...root,
    'profiles/base.json': doc({ files: { 'claude:CLAUDE.md': 'claude/shared.md' } }),
    'profiles/personal.json': '{"extends":"base"}',
    'profiles/team.json': doc({ extends: 'base', files: { 'claude:CLAUDE.md': null } }),
    'skill-pins.json': '{',
  };
  assert.ok(resolveNamedProfile({ documents, name: 'personal' }).issues.some(issue => issue.source === 'skill-pins.json'));
  assert.deepEqual(profilesUsingPath(documents, 'claude/shared.md'), ['base', 'personal']);
  assert.deepEqual(profilesUsingPath({ ...root, 'skill-pins.json': '{' }, 'codex/AGENTS.md'), ['default']);
});

test('profilesUsingPath includes root file references returned for unresolved chains', () => {
  const documents = { ...root,
    'profiles/cycle.json': '{"extends":"cycle"}',
    'profiles/orphan.json': '{"extends":"missing"}',
  };
  assert.deepEqual(profilesUsingPath(documents, 'codex/AGENTS.md'), ['cycle', 'orphan']);
});

test('profile-declared values carry the profile file as their origin', () => {
  const config = resolve({
    'profiles/personal.json': doc({
      skills: { add: [{ source: 'a/core', names: ['tdd'] }] },
      files: { 'claude:settings.json': 'claude/personal.keys.json' },
      integrations: { add: ['off'], remove: ['on'] },
    }),
    'claude/personal.keys.json': '{"effortLevel":"low"}',
  });
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills.find(s => s.name === 'tdd')!.from, origin('personal'));
  const file = config.files.find(f => f.id === 'claude:settings.json')!;
  assert.deepEqual(file.from, origin('personal'));
  assert.deepEqual(file.keys!.effortLevel, { value: 'low', from: origin('personal') });
  assert.deepEqual(config.integrations.map(i => [i.enabled, i.from]), [[false, origin('personal')], [true, origin('personal')]]);
});

test('a child can include files and skills excluded by its parent', () => {
  const config = resolve({
    'profiles/base.json': doc({ skills: { remove: [{ source: 'a/core', names: ['tdd'] }] }, files: { 'claude:CLAUDE.md': null } }),
    'profiles/personal.json': doc({ extends: 'base', skills: { add: [{ source: 'a/core', names: ['tdd'] }] }, files: { 'claude:CLAUDE.md': 'claude/back.md' } }),
  });
  assert.deepEqual(config.issues, []);
  assert.equal(config.skills.find(s => s.name === 'tdd')!.install, true);
  assert.equal(config.files.find(f => f.id === 'claude:CLAUDE.md')!.managed, true);
});

test('machine choices and shared pins layer over profile declarations', () => {
  const config = resolveNamedProfile({ documents: { ...root,
    'profiles/personal.json': doc({ skills: { add: [{ source: 'b/extra', names: ['explain'] }] }, integrations: { add: ['off'] } }),
    'skill-pins.json': doc({ version: 1, pins: { 'b/extra': 'a'.repeat(40) } }),
  }, name: 'personal', overrides: decodeOverrides({ version: 1, skills: { explain: false }, integrations: { off: false } }, 'machine.json') });
  assert.deepEqual(config.issues, []);
  const skill = config.skills.find(s => s.name === 'explain')!;
  assert.equal(skill.install, false);
  assert.deepEqual(skill.from, { layer: 'machine', source: 'machine.json' });
  assert.equal(skill.pin!.ref, 'a'.repeat(40));
  assert.equal(config.integrations.find(i => i.id === 'off')!.from.layer, 'machine');
});

test('profile settings retain owned-key and secret checks', () => {
  const config = resolveNamedProfile({ documents: { ...root,
    'profiles/personal.json': doc({ files: { 'claude:settings.json': 'personal.keys.json' } }),
    'personal.keys.json': '{"effortLevel":"low"}',
  }, name: 'personal', overrides: decodeOverrides({ version: 1, settings: { 'claude:settings.json': { effortLevel: 'sk-abcdef12', theme: 'dark' } } }, 'o.json') });
  assert.equal(config.issues.length, 2);
  assert.equal(config.files.find(f => f.id === 'claude:settings.json')!.keys!.effortLevel!.value, 'low');
  const refused = resolve({ 'profiles/personal.json': doc({ files: { 'claude:settings.json': 'bad.json' } }), 'bad.json': '{"apiKey":"secret"}' });
  assert.ok(refused.issues.length > 0);
  assert.deepEqual(refused.files.find(f => f.id === 'claude:settings.json')!.keys, {});
});

test('profile documents reject invalid names, unknown items and unsafe repo paths', () => {
  for (const value of [
    { extends: '../base' }, { files: { unknown: 'a' } }, { integrations: { add: ['missing'] } },
    { files: { 'claude:CLAUDE.md': '../outside' } }, { files: { 'claude:CLAUDE.md': '/outside' } },
    { skills: { add: [{ source: 'https://user:secret@example.com/repo', names: ['tdd'] }] } },
    { skills: { add: [{ source: 'a/core', names: ['../bad'] }] } }, { unknown: true },
  ]) assert.ok(resolve({ 'profiles/personal.json': doc(value) }).issues.length > 0, doc(value));
  for (const text of ['{', 'null', '{"extends":2}']) assert.ok(parseProfileDocument(text, 'profiles/bad.json').issues.length > 0);
});

test('profile listing is sorted and rejects invalid profile filenames', async () => {
  assert.deepEqual(await run(listProfiles('/repo'), { 'profiles/z.json': '{}', 'profiles/a.json': '{}' }), ['a', 'z']);
  const error = await run(Effect.flip(listProfiles('/repo')), { 'profiles/Bad.json': '{}' });
  assert.equal(error._tag, 'ProfileInvalid');
});

test('nodeFiles distinguishes missing directories, empty directories and unreadable listings', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'profiles-'));
  const runNode = <A, E>(effect: Effect.Effect<A, E, ProfileFiles>) => Effect.runPromise(effect.pipe(Effect.provide(nodeFiles)));
  try {
    assert.deepEqual(await runNode(listProfiles(repo)), ['default']);
    await mkdir(join(repo, 'profiles'));
    assert.equal((await runNode(Effect.flip(listProfiles(repo))))._tag, 'ProfileInvalid');
    await writeFile(join(repo, 'profiles/default.json'), '{}');
    assert.deepEqual(await runNode(listProfiles(repo)), ['default']);
    await rm(join(repo, 'profiles'), { recursive: true });
    await writeFile(join(repo, 'profiles'), 'not a directory');
    assert.equal((await runNode(Effect.flip(listProfiles(repo))))._tag, 'ReadFailed');
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('a machine declaration of an inherited profile skill keeps its declaration origin', () => {
  const config = resolveNamedProfile({ documents: { ...root,
    'profiles/personal.json': doc({ skills: { add: [{ source: 'b/extra', names: ['explain'] }] } }),
  }, name: 'personal', overrides: decodeOverrides({ version: 2, skillAdditions: [
    { source: 'b/extra', name: 'explain', targets: ['codex'] },
  ] }, 'machine.json') });
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills.find(s => s.name === 'explain')!.declaredFrom, origin('personal'));
  const collision = resolveNamedProfile({ documents: { ...root, 'profiles/personal.json': '{}' }, name: 'personal',
    overrides: decodeOverrides({ version: 2, skillAdditions: [{ source: 'other/repo', name: 'tdd', targets: ['codex'] }] }, 'o.json') });
  assert.ok(collision.issues.some(i => i.message.includes('conflicting sources')));
});

test('named loading reads inherited settings paths and preserves hook document contents', async () => {
  const documents = { ...root,
    'profiles/base.json': doc({ files: { 'claude:settings.json': 'custom.keys.json' } }),
    'profiles/personal.json': '{"extends":"base"}',
    'custom.keys.json': '{"effortLevel":"low"}',
    'integrations.json': doc({ version: 1, integrations: [
      { id: 'hook', label: 'Hook', target: 'claude', type: 'hook', default: true, event: 'Stop', file: 'profiles/base.json' },
    ] }),
  };
  assert.deepEqual(await run(loadNamedProfile('/repo', 'personal'), documents), resolveNamedProfile({ documents, name: 'personal' }));
});

test('named loading reads only the selected profile\'s settings files', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'profile-settings-'));
  try {
    await mkdir(join(repo, 'profiles'));
    await mkdir(join(repo, 'claude/settings.keys.json'), { recursive: true });
    await writeFile(join(repo, 'profiles/personal.json'), doc({ files: { 'claude:settings.json': 'personal.keys.json' } }));
    await writeFile(join(repo, 'profiles/team.json'), doc({ files: { 'claude:settings.json': 'unreadable.keys.json' } }));
    await mkdir(join(repo, 'unreadable.keys.json'));
    await writeFile(join(repo, 'personal.keys.json'), '{"effortLevel":"low"}');
    const config = await Effect.runPromise(loadNamedProfile(repo, 'personal').pipe(Effect.provide(nodeFiles)));
    assert.deepEqual(config.issues, []);
    assert.equal(config.files.find(f => f.id === 'claude:settings.json')!.keys!.effortLevel!.value, 'low');
  } finally { await rm(repo, { recursive: true, force: true }); }
});
