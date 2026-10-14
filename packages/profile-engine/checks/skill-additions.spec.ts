import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseProfile, decodeOverrides, resolveProfile } from '../src/index.ts';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const addition = { source: 'owner/repo', name: 'personal', targets: ['claude'] };
const machine = { layer: 'machine', source: 'overrides.json' };
const baseFrom = { layer: 'base', source: 'skills-manifest.txt' };
const resolve = (additions: unknown[], manifest?: string, choices = {}, pins = {}) => resolveProfile({
  base: buildBaseProfile({ skillsManifest: manifest }, () => false),
  overrides: decodeOverrides({ version: 2, skillAdditions: additions, ...choices }, 'overrides.json'),
  pins: { value: pins, issues: [], source: 'skill-pins.json' },
});

test('an undeclared personal skill retains its targets and declaration provenance', () => {
  const config = resolve([addition], undefined, { skills: { personal: false } });
  assert.deepEqual(config.issues, []);
  assert.deepEqual(config.skills, [{ name: 'personal', source: 'owner/repo', exact: true, optional: false,
    install: false, from: machine, declaredFrom: machine, targets: ['claude'] }]);
});

test('equivalent declarations collapse and union required targets', () => {
  const config = resolve([addition, { ...addition, source: 'https://github.com/OWNER/REPO.git', targets: ['codex', 'claude'] }]);
  assert.deepEqual(config.issues, []);
  assert.equal(config.skills.length, 1);
  assert.deepEqual(config.skills[0]!.targets, ['claude', 'codex']);
});

test('an inherited duplicate resolves once and keeps base declaration provenance', () => {
  const config = resolve([addition], '[Owner/Repo] optional\npersonal\n', { skills: { personal: true } });
  assert.deepEqual(config.issues, []);
  assert.equal(config.skills.length, 1);
  assert.deepEqual(config.skills[0]!.declaredFrom, baseFrom);
  assert.deepEqual(config.skills[0]!.from, machine);
  assert.deepEqual(config.skills[0]!.targets, ['claude']);
});

test('the same name from another source is a conflict', () => {
  for (const config of [resolve([addition, { ...addition, source: 'other/repo' }]), resolve([addition], '[other/repo]\npersonal\n')]) {
    assert.ok(config.issues.some(i => /source/.test(i.message)));
  }
});

test('machine revisions stay source-wide without moving inherited skills silently', () => {
  const config = resolve([{ ...addition, revision: sha }, { ...addition, name: 'second' }]);
  assert.deepEqual(config.issues, []);
  assert.ok(config.skills.every(s => s.pin?.ref === sha && s.pin.from.layer === 'machine'));
  for (const conflict of [
    resolve([{ ...addition, revision: sha }, { ...addition, name: 'second', revision: otherSha }]),
    resolve([{ ...addition, revision: sha }], undefined, {}, { 'OWNER/REPO': otherSha }),
    resolve([{ ...addition, revision: sha }], '[owner/repo]\ninherited\n'),
  ]) assert.ok(conflict.issues.some(i => /revision/.test(i.message)));
});

test('equivalent base and pin sources share the existing approved revision', () => {
  const config = resolve([{ ...addition, revision: sha }], '[Owner/Repo]\ninherited\n', {}, { 'https://github.com/owner/repo.git': sha });
  assert.deepEqual(config.issues, []);
  assert.ok(config.skills.every(s => s.pin?.ref === sha && s.pin.from.layer === 'pin'));
});

test('declarations do not widen settings, integrations, or boolean-only allowlists', () => {
  const config = resolve([addition], undefined, { skills: { missing: true }, integrations: { missing: true }, settings: { missing: { any: true } } });
  assert.deepEqual(config.issues.map(i => i.path).sort(), ['integrations.missing', 'settings.missing', 'skills.missing']);
});

test('an explicit inherited optional declaration opts in but a false boolean still wins', () => {
  for (const install of [true, false]) {
    const config = resolve([addition], '[owner/repo] optional\npersonal\n', install ? {} : { skills: { personal: false } });
    assert.deepEqual(config.issues, []);
    assert.equal(config.skills[0]!.install, install);
    assert.deepEqual(config.skills[0]!.from, machine);
    assert.deepEqual(config.skills[0]!.declaredFrom, baseFrom);
  }
});

test('any inherited same-name source conflict is reported even if the last source matches', () => {
  const config = resolve([addition], '[other/repo]\npersonal\n[owner/repo]\npersonal\n');
  assert.ok(config.issues.some(i => /conflicting sources/.test(i.message)));
});
