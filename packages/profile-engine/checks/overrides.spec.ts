import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOverrides, normalizeSkillSource, serializeOverrides, overridesFromLegacyState } from '../src/overrides.ts';

test('decodes a full overrides document without its version', () => {
  const value = {
    version: 1,
    manageConfig: true,
    configTargets: ['claude'],
    settings: { 'claude:settings.json': { effortLevel: 'medium' } },
    skills: { explain: true, wizard: false },
    integrations: { 'superpowers-codex': false },
  };
  const { version: _version, ...expected } = value;
  assert.deepEqual(decodeOverrides(value, 'overrides.json'), { value: expected, source: 'overrides.json', issues: [] });
});

test('every field but version is optional', () => {
  assert.deepEqual(decodeOverrides({ version: 1 }, 'o'), { value: {}, source: 'o', issues: [] });
});

test('a malformed document overrides nothing and reports one machine issue', () => {
  for (const value of [
    {},
    { version: 3 },
    { version: 1, extra: true },
    { version: 1, configTargets: ['cursor'] },
    { version: 1, skills: { explain: 'yes' } },
    { version: 1, settings: { 'claude:settings.json': 'x' } },
    [],
  ]) {
    const decoded = decodeOverrides(value, 'o');
    assert.deepEqual(decoded.value, {}, JSON.stringify(value));
    assert.equal(decoded.issues.length, 1, JSON.stringify(value));
    assert.equal(decoded.issues[0]!.layer, 'machine');
    assert.equal(decoded.issues[0]!.source, 'o');
  }
});

test('legacy state yields only the choices parseState honours', () => {
  const cases: Array<[string | undefined, object]> = [
    [undefined, {}],
    ['{', {}],
    ['{"skillsOnly":true}', {}],
    ['{"files":[],"skillsOnly":true}', {}],
    ['{"files":{}}', {}],
    ['{"files":{},"skillsOnly":true}', { manageConfig: false }],
    ['{"files":{},"skillsOnly":"true"}', {}],
    ['{"files":{},"skillsOnly":false}', {}],
    ['{"files":{},"configTargets":["codex","codex"]}', { configTargets: ['codex'] }],
    ['{"files":{},"configTargets":[]}', { configTargets: [] }],
    ['{"files":{},"configTargets":["codex","cursor"]}', {}],
    ['{"files":{},"configTargets":"codex"}', {}],
  ];
  for (const [text, expected] of cases) {
    assert.deepEqual(overridesFromLegacyState(text), { value: expected, source: 'state.json', issues: [] }, String(text));
  }
});

test('version 2 decodes only known fields, while version 1 remains strict', () => {
  const addition = { source: 'https://github.com/Owner/Repo.git', name: 'personal', targets: ['claude'], revision: 'a'.repeat(40) };
  const decoded = decodeOverrides({ version: 2, skillAdditions: [addition], future: { private: true } }, 'o');
  assert.deepEqual(decoded.issues, []);
  assert.deepEqual(decoded.value, { skillAdditions: [{ ...addition, source: 'owner/repo' }] });
  assert.equal(decodeOverrides({ version: 1, skillAdditions: [] }, 'o').issues.length, 1);
});

test('new declarations reject unsafe names, sources, targets and revisions', () => {
  const valid = { source: 'owner/repo', name: 'personal', targets: ['codex'] };
  const invalid = [
    ...['', '.', '..', '/abs', 'a/b', 'a\\b', '-flag', 'bad\nname', 'bad\u0085name', 'C:drive', 'x'.repeat(256)].map(name => ({ name })),
    ...['/tmp/repo', './repo', '../repo', 'git@github.com:owner/repo', 'https://user:secret@github.com/a/b',
      'https://gitlab.com/a/b', 'https://github.com/a/b?token=secret', 'https://github.com/a/b/tree/main'].map(source => ({ source })),
    { targets: [] }, { targets: ['cursor'] }, { revision: 'main' }, { revision: 'A'.repeat(40) }, { extra: true },
  ];
  for (const change of invalid) {
    const decoded = decodeOverrides({ version: 2, skillAdditions: [{ ...valid, ...change }] }, 'o');
    assert.equal(decoded.issues.length, 1, JSON.stringify(change));
    assert.deepEqual(decoded.value, {});
  }
});

test('serializer retains future fields while replacing the validated known projection', () => {
  const result = serializeOverrides({ manageConfig: true }, { version: 2, manageConfig: false, skills: { old: true }, future: { version: 99 } }, 'o');
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(JSON.parse(result.text), { version: 2, manageConfig: true, future: { version: 99 } });
  for (const proposed of [{ version: 1 }, { future: true }, { skills: { bad: 'yes' } }]) {
    assert.equal(serializeOverrides(proposed as never, { version: 2 }, 'o').ok, false);
  }
});

test('new declaration names are canonical installed names, not native selector labels', () => {
  const decodeName = (name: string) => decodeOverrides({ version: 2,
    skillAdditions: [{ source: 'owner/repo', name, targets: ['claude'] }],
  }, 'o');
  for (const name of ['Uppercase', 'two words', '.hidden', 'trailing.', '-leading', 'trailing-', 'a--b']) {
    assert.equal(decodeName(name).issues.length, 1, name);
  }
  for (const name of ['a', '_', '_skill_', 'a.b-c_d', 'x'.repeat(255)]) {
    assert.deepEqual(decodeName(name).issues, [], name);
    assert.equal(decodeName(name).value.skillAdditions?.[0]?.name, name);
  }
});


test('every supported source identity is a normalization fixed point and repeated suffixes refuse', () => {
  for (const source of ['Owner/Repo', 'owner/repo.git', 'owner/repo/', 'owner/repo.git/', 'https://github.com/Owner/Repo', 'https://github.com/Owner/Repo.git/', 'owner/repo.git-tools']) {
    const canonical = normalizeSkillSource(source); assert.ok(canonical); assert.equal(normalizeSkillSource(canonical), canonical);
    const input = decodeOverrides({ version: 2, skillAdditions: [{ source, name: 'skill', targets: ['claude'] }] }, 'overrides.json');
    assert.deepEqual(input.issues, []); const serialized = serializeOverrides(input.value, undefined, 'overrides.json'); assert.ok(serialized.ok);
    assert.deepEqual(decodeOverrides(JSON.parse(serialized.text), 'overrides.json').value, input.value);
  }
  for (const source of ['owner/repo.git.git', 'owner/repo.git.git/', 'https://github.com/owner/repo.git.git', 'owner/repo.git.git.git', 'owner/repo.GIT', 'owner/repo.GIT.git']) {
    assert.equal(normalizeSkillSource(source), undefined);
    const input = decodeOverrides({ version: 2, skillAdditions: [{ source, name: 'skill', targets: ['claude'] }] }, 'overrides.json'); assert.ok(input.issues.length > 0);
    assert.equal(serializeOverrides({ skillAdditions: [{ source, name: 'skill', targets: ['claude'] }] }, undefined, 'overrides.json').ok, false);
  }
});
