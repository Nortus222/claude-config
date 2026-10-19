import test from 'node:test';
import assert from 'node:assert/strict';
import { composeSetupChoices, itemValues } from '../src/index.ts';

test('after switching to a profile newer than the applied commit, declining an incoming item is a valid hold', () => {
  const offered = { 'profiles/personal.json': '{}', 'claude/settings.keys.json': '{"theme":"dark"}', 'skills-manifest.txt': '[owner/skills]\ntdd\n' };
  const result = composeSetupChoices({ current: {}, offered, accepted: [], holds: {}, profile: 'personal' });
  assert.equal(itemValues(result, 'personal').size, 0);
});
