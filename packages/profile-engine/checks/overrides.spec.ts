import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOverrides, overridesFromLegacyState } from '../src/overrides.ts';

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
    { version: 2 },
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
