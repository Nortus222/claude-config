import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseProfile } from '../src/base.ts';
import { resolveProfile } from '../src/resolve.ts';
import type { Input, MachineOverrides, Pins } from '../src/model.ts';

const manifest = '[a/core]\ntdd\nwizard\n[a/extra] optional\nexplain\n[b/other]\ntdd\n';
const integrations = JSON.stringify({
  version: 1,
  integrations: [
    { id: 'sp-claude', label: 'sp', target: 'claude', type: 'plugin', default: true, plugin: 'sp@x' },
    { id: 'sp-codex', label: 'sp', target: 'codex', type: 'plugin', default: false, plugin: 'sp@y' },
  ],
});
const settings = { 'claude:settings.json': '{"effortLevel":"high","theme":"auto"}' };
const base = buildBaseProfile({ skillsManifest: manifest, integrations, settings }, () => false);

const machine = (value: MachineOverrides, issues: Input<MachineOverrides>['issues'] = []): Input<MachineOverrides> =>
  ({ value, source: 'overrides.json', issues });
const pinned = (value: Pins): Input<Pins> => ({ value, source: 'skill-pins.json', issues: [] });
const M = { layer: 'machine', source: 'overrides.json' } as const;

test('with no pins or overrides every value comes from the base profile', () => {
  const config = resolveProfile({ base });
  assert.deepEqual(config.issues, []);
  assert.ok(config.files.every((f) => f.managed && f.from.layer === 'base' && f.from.source === 'built-in'));
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {
    effortLevel: { value: 'high', from: { layer: 'base', source: 'claude/settings.keys.json' } },
    theme: { value: 'auto', from: { layer: 'base', source: 'claude/settings.keys.json' } },
  });
  assert.equal(config.files.find((f) => f.id === 'claude:CLAUDE.md')!.keys, undefined);
  assert.deepEqual(
    config.skills.map((s) => [s.name, s.source, s.install, s.from.source, 'pin' in s]),
    [
      ['tdd', 'a/core', true, 'skills-manifest.txt', false],
      ['wizard', 'a/core', true, 'skills-manifest.txt', false],
      ['explain', 'a/extra', false, 'skills-manifest.txt', false],
      ['tdd', 'b/other', true, 'skills-manifest.txt', false],
    ],
  );
  assert.deepEqual(
    config.integrations.map((i) => [i.id, i.enabled, i.from]),
    [
      ['sp-claude', true, { layer: 'base', source: 'integrations.json' }],
      ['sp-codex', false, { layer: 'base', source: 'integrations.json' }],
    ],
  );
});

test('manageConfig false leaves every file unmanaged, decided by the machine', () => {
  const config = resolveProfile({ base, overrides: machine({ manageConfig: false }) });
  assert.ok(config.files.every((f) => !f.managed && f.from.layer === 'machine'));
});

test('configTargets manages only the named agents', () => {
  const config = resolveProfile({ base, overrides: machine({ configTargets: ['codex'] }) });
  for (const f of config.files) {
    assert.equal(f.managed, f.target === 'codex', f.id);
    assert.deepEqual(f.from, M);
  }
});

test('a settings override replaces an owned value and only that value', () => {
  const config = resolveProfile({
    base,
    overrides: machine({ settings: { 'claude:settings.json': { effortLevel: 'medium' } } }),
  });
  assert.deepEqual(config.issues, []);
  const keys = config.files.find((f) => f.id === 'claude:settings.json')!.keys!;
  assert.deepEqual(keys.effortLevel, { value: 'medium', from: M });
  assert.equal(keys.theme!.from.layer, 'base');
});

test('settings overrides of unowned keys or undeclared documents are issues and change nothing', () => {
  const config = resolveProfile({
    base,
    overrides: machine({ settings: { 'claude:settings.json': { permissions: {} }, 'codex:config.toml': { a: 1 } } }),
  });
  assert.equal(config.issues.length, 2);
  assert.ok(config.issues.every((i) => i.layer === 'machine' && i.source === 'overrides.json'));
  assert.deepEqual(config.issues.map((i) => i.path).sort(), ['settings.claude:settings.json.permissions', 'settings.codex:config.toml']);
  assert.deepEqual(Object.keys(config.files.find((f) => f.id === 'claude:settings.json')!.keys!), ['effortLevel', 'theme']);
});

test('a settings override hiding a credential is refused and the base value kept', () => {
  for (const value of ['sk-abcdef12', { nested: { token: 'x' } }]) {
    const config = resolveProfile({ base, overrides: machine({ settings: { 'claude:settings.json': { theme: value } } }) });
    assert.ok(config.issues.length > 0, JSON.stringify(value));
    assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys!.theme, {
      value: 'auto',
      from: { layer: 'base', source: 'claude/settings.keys.json' },
    });
  }
});

test('a refused settings document owns nothing, and overriding its keys is an issue per key', () => {
  const refused = buildBaseProfile({ skillsManifest: manifest, integrations, settings: { 'claude:settings.json': '{}' } }, () => false);
  const config = resolveProfile({
    base: refused,
    overrides: machine({ settings: { 'claude:settings.json': { effortLevel: 'low', theme: 'dark' } } }),
  });
  assert.deepEqual(config.files.find((f) => f.id === 'claude:settings.json')!.keys, {});
  assert.equal(config.issues.filter((i) => i.layer === 'machine').length, 2);
  assert.equal(config.issues.filter((i) => i.layer === 'base').length, 1);
});

test('skill overrides opt in, opt out, and apply to every source listing the name', () => {
  const config = resolveProfile({ base, overrides: machine({ skills: { explain: true, tdd: false, missing: true } }) });
  const byKey = new Map(config.skills.map((s) => [`${s.source}/${s.name}`, s]));
  assert.deepEqual([byKey.get('a/extra/explain')!.install, byKey.get('a/extra/explain')!.from], [true, M]);
  assert.equal(byKey.get('a/core/tdd')!.install, false);
  assert.equal(byKey.get('b/other/tdd')!.install, false);
  assert.equal(byKey.get('a/core/wizard')!.from.layer, 'base');
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['machine', 'skills.missing']]);
});

test('a pin stamps every skill from its source; a pin for an undeclared source is an issue', () => {
  const config = resolveProfile({ base, pins: pinned({ 'a/core': 'abc123', 'z/none': 'def' }) });
  const fromCore = config.skills.filter((s) => s.source === 'a/core');
  assert.ok(fromCore.every((s) => s.pin?.ref === 'abc123' && s.pin.from.layer === 'pin' && s.pin.from.source === 'skill-pins.json'));
  assert.ok(config.skills.filter((s) => s.source !== 'a/core').every((s) => !('pin' in s)));
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['pin', 'pins.z/none']]);
});

test('integration overrides enable or disable declared ids only', () => {
  const config = resolveProfile({ base, overrides: machine({ integrations: { 'sp-claude': false, 'sp-codex': true, ghost: true } }) });
  assert.deepEqual(config.integrations.map((i) => [i.id, i.enabled, i.from.layer]), [
    ['sp-claude', false, 'machine'],
    ['sp-codex', true, 'machine'],
  ]);
  assert.deepEqual(config.issues.map((i) => [i.layer, i.path]), [['machine', 'integrations.ghost']]);
});

test('issues from every input are carried through', () => {
  const broken = buildBaseProfile({ integrations: '{' }, () => false);
  const config = resolveProfile({
    base: broken,
    pins: { value: {}, source: 'skill-pins.json', issues: [{ layer: 'pin', source: 'skill-pins.json', path: '', message: 'p' }] },
    overrides: machine({}, [{ layer: 'machine', source: 'overrides.json', path: '', message: 'o' }]),
  });
  assert.deepEqual(config.issues.map((i) => i.layer), ['base', 'pin', 'machine']);
  assert.deepEqual(config.integrations, []);
});
