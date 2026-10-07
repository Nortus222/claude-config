import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillGroup } from '@nortuscc/profile-engine';
import { checkoutGroups } from '../src/index.ts';

const SHA = 'a'.repeat(40);
const g = (source: string, skills: string[], markers: Partial<SkillGroup> = {}): SkillGroup =>
  ({ source, skills, exact: false, optional: false, ...markers });

test('without holds the machine groups are returned unchanged', () => {
  const machine = [g('a/b', ['x', 'y'])];
  assert.deepEqual(checkoutGroups(machine, [g('a/b', ['x'])], {}), machine);
});

test('a held skill the checkout dropped is not written back', () => {
  const out = checkoutGroups([g('a/b', ['kept', 'old'])], [g('a/b', ['kept'])], { 'skill:a/b/old': SHA });
  assert.deepEqual(out, [g('a/b', ['kept'])]);
});

test('a held skill the checkout added stays listed though it is not installed here', () => {
  const out = checkoutGroups([g('a/b', ['kept'])], [g('a/b', ['kept', 'new']), g('c/d', ['solo'], { optional: true })],
    { 'skill:a/b/new': SHA, 'skill:c/d/solo': SHA });
  assert.deepEqual(out, [g('a/b', ['kept', 'new']), g('c/d', ['solo'], { optional: true })]);
});

test('a group left empty is dropped, and holds on other kinds are ignored', () => {
  const out = checkoutGroups([g('a/b', ['old']), g('c/d', ['z'])], [g('c/d', ['z'])],
    { 'skill:a/b/old': SHA, 'setting:claude:settings.json#theme': SHA });
  assert.deepEqual(out, [g('c/d', ['z'])]);
});
