import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Effect } from 'effect';
import { resolveProfile, type BaseProfile } from '@nortuscc/profile-engine';
import { proposeMachineIntent } from '../src/intent.ts';

const base: BaseProfile = { files: [{ id: 'settings', target: 'claude', home: 'claude', src: 'settings.json', dest: 'settings.json', mode: 'merge-keys', preserveProjects: false, capture: true }], settings: { settings: { theme: 'dark' } }, skills: [{ source: 'a/b', skills: ['shared'], exact: true, optional: false }], integrations: [{ id: 'hook', default: true }], allow: {}, issues: [] };
const desired = (value = {}) => resolveProfile({ base, overrides: { value, source: '/state/overrides.json', issues: [] } });
test('reset reveals inherited settings and disable retains the declared shared skill', async () => {
  const current = { settings: { settings: { theme: 'light' } } };
  const next = await Effect.runPromise(proposeMachineIntent(desired(current), current, { kind: 'setting', fileId: 'settings', key: 'theme', action: 'reset' }));
  assert.equal(desired(next).files[0]!.keys!.theme!.value, 'dark');
  const disabled = await Effect.runPromise(proposeMachineIntent(desired(), {}, { kind: 'skill', source: 'a/b', name: 'shared', action: 'disable' }));
  assert.equal(desired(disabled).skills[0]!.install, false); assert.equal(desired(disabled).skills.length, 1);
});
test('unknown identities and secret or non-finite settings refuse', async () => {
  for (const patch of [
    { kind: 'setting', fileId: 'settings', key: 'unknown', action: 'set', value: 1 },
    { kind: 'setting', fileId: 'settings', key: 'theme', action: 'set', value: { token: 'private' } },
    { kind: 'setting', fileId: 'settings', key: 'theme', action: 'set', value: Infinity },
    { kind: 'integration', id: 'unknown', action: 'enable' },
    { kind: 'skill', source: 'other/repo', name: 'shared', action: 'disable' },
  ] as const) await assert.rejects(Effect.runPromise(proposeMachineIntent(desired(), {}, patch)));
});
test('bounded setting validation refuses bytes, depth and nodes before recursive owner validation', async () => {
  for (const value of ['x'.repeat(32769), Array.from({ length: 4097 }, () => null), Array.from({ length: 17 }).reduce<unknown>(v => [v], null)]) {
    const error = await Effect.runPromise(Effect.flip(proposeMachineIntent(desired(), {}, { kind: 'setting', fileId: 'settings', key: 'theme', action: 'set', value })));
    assert.equal(error.reason, 'limit');
  }
});
test('removing an explicit declaration removes orphaned choices and retains base-overlay choices', async () => {
  for (const name of ['shared', 'personal']) {
    const current = { skillAdditions: [{ source: 'a/b', name, targets: ['claude' as const] }], skills: { [name]: false } };
    const next = await Effect.runPromise(proposeMachineIntent(desired(current), current, { kind: 'removeSkillDeclaration', source: 'a/b', name }));
    assert.equal(next.skillAdditions?.length ?? 0, 0);
    assert.equal(Object.hasOwn(next.skills ?? {}, name), name === 'shared');
  }
});
test('source-qualified collisions refuse even when the requested name matches', async () => {
  const invalid = resolveProfile({ base: { ...base, skills: [...base.skills, { source: 'other/repo', skills: ['shared'], exact: true, optional: false }] } });
  await assert.rejects(Effect.runPromise(proposeMachineIntent(invalid, {}, { kind: 'skill', source: 'a/b', name: 'shared', action: 'enable' })));
});

test('valid empty config targets retain current engine semantics', async () => {
  const next = await Effect.runPromise(proposeMachineIntent(desired(), {}, { kind: 'configTargets', action: 'set', value: [] }));
  assert.deepEqual(desired(next).issues, []); assert.equal(desired(next).files[0]!.managed, false);
});

test('resetting choices restores inherited integration, skill and management intent', async () => {
  const current = { manageConfig: false, configTargets: ['codex' as const], skills: { shared: false }, integrations: { hook: false } };
  for (const patch of [{ kind: 'integration', id: 'hook', action: 'reset' }, { kind: 'skill', source: 'a/b', name: 'shared', action: 'reset' }, { kind: 'manageConfig', action: 'reset' }, { kind: 'configTargets', action: 'reset' }] as const) {
    const next = await Effect.runPromise(proposeMachineIntent(desired(current), current, patch));
    const resolved = desired(next);
    if (patch.kind === 'integration') assert.equal(resolved.integrations[0]!.enabled, true);
    if (patch.kind === 'skill') assert.equal(resolved.skills[0]!.install, true);
    if (patch.kind === 'manageConfig') assert.equal(next.manageConfig, undefined);
    if (patch.kind === 'configTargets') assert.equal(next.configTargets, undefined);
  }
});
