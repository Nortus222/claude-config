import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS } from '@nortuscc/profile-engine';
import { configuredTargets } from '../src/configured-targets.ts';

const choices = (value: object, issues: unknown[] = []) => ({ value, source: 'overrides.json', issues }) as Parameters<typeof configuredTargets>[0];

test('the configured targets are the chosen ones, all of them by default, and none while choices are invalid or config is unmanaged', () => {
  assert.deepEqual(configuredTargets(choices({ configTargets: ['codex'] }), true), ['codex']);
  assert.deepEqual(configuredTargets(choices({}), true), TARGETS);
  assert.deepEqual(configuredTargets(choices({}), false), [], 'nothing is known before the first inspection');
  assert.deepEqual(configuredTargets(choices({ manageConfig: false, configTargets: ['codex'] }), true), []);
  assert.deepEqual(configuredTargets(choices({ configTargets: ['codex'] }, [{ message: 'invalid' }]), true), []);
});
