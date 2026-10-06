import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Effect } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { nodeFs, type Observed } from '@nortuscc/machine';
import { sortItems, type Snapshot } from '../src/index.ts';
import { desiredOf, hook, skill } from './support/desired.ts';

const repo = (files: Readonly<Record<string, string>> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-sort-'));
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), text);
  }
  return dir;
};
const snap = (desired: DesiredConfig, dir = repo()): Snapshot => ({ desired, repo: dir });
const observed = (key: string, disposition: Observed['disposition'] = 'apply', domain: Observed['domain'] = 'config'): Observed =>
  ({ key, domain, label: key, group: 'g', state: 's', disposition });
const sort = (items: Observed[], applied: Snapshot, effective: Snapshot) =>
  Effect.runPromise(sortItems({ desired: effective.desired, items, probeErrors: [] }, applied, effective).pipe(Effect.provide(nodeFs)));

const EFFORT_KEY = 'config:claude:settings.json#effortLevel';
const EFFORT = 'setting:claude:settings.json#effortLevel';

test('an accepted change of an inert key is pending and inert', async () => {
  const sorted = await sort([observed(EFFORT_KEY)], snap(desiredOf({ settings: { effortLevel: 'low' } })), snap(desiredOf({ settings: { effortLevel: 'high' } })));
  assert.deepEqual(sorted, { pending: [{ key: EFFORT_KEY, itemId: EFFORT, verdict: { kind: 'inert' } }], drift: [] });
});

test('a key whose desired value did not change, but differs on the machine, is drift', async () => {
  const desired = desiredOf({ settings: { effortLevel: 'high' } });
  assert.deepEqual(await sort([observed(EFFORT_KEY)], snap(desired), snap(desired)), { pending: [], drift: [EFFORT_KEY] });
});

test('a skipped item stays at its applied value, so it is drift', async () => {
  // The new revision moved effortLevel to "high"; the person skipped it, so effective keeps "low".
  const applied = desiredOf({ settings: { effortLevel: 'low' } });
  assert.deepEqual(await sort([observed(EFFORT_KEY)], snap(applied), snap(applied)), { pending: [], drift: [EFFORT_KEY] });
});

test('machine-local keys are drift; undeclared items are neither pending nor drift', async () => {
  const desired = desiredOf({ skills: [skill('tdd', 'mattpocock/skills')] });
  const items = [
    observed('skill-link:claude:tdd', 'apply', 'skills'),
    observed('skill:ghost', 'capture', 'skills'),
    observed('undeclared:claude:hooks:node /x.mjs', 'undeclared', 'integrations'),
  ];
  assert.deepEqual(await sort(items, snap(desired), snap(desired)), { pending: [], drift: ['skill-link:claude:tdd', 'skill:ghost'] });
});

test('an accepted hook is pending and held', async () => {
  const sorted = await sort([observed('integration:hk', 'apply', 'integrations')], snap(desiredOf()), snap(desiredOf({ integrations: [hook('hk')] })));
  assert.deepEqual(sorted.pending, [{ key: 'integration:hk', itemId: 'integration:hk', verdict: { kind: 'held', reason: 'integration' } }]);
});

test('a moved skill pin is pending and held', async () => {
  const applied = desiredOf({ skills: [skill('tdd', 'mattpocock/skills', 'a'.repeat(40))] });
  const effective = desiredOf({ skills: [skill('tdd', 'mattpocock/skills', 'b'.repeat(40))] });
  const sorted = await sort([observed('skill:tdd', 'apply', 'skills')], snap(applied), snap(effective));
  assert.deepEqual(sorted.pending, [{ key: 'skill:tdd', itemId: 'skill:mattpocock/skills/tdd', verdict: { kind: 'held', reason: 'skill' } }]);
});

test('an instruction file is pending when its content changed between the revisions', async () => {
  const key = 'config:claude:CLAUDE.md';
  const changed = await sort([observed(key)], snap(desiredOf(), repo({ 'claude/CLAUDE.md': '# old\n' })), snap(desiredOf(), repo({ 'claude/CLAUDE.md': '# new\n' })));
  assert.deepEqual(changed.pending, [{ key, itemId: 'file:claude:CLAUDE.md', verdict: { kind: 'inert' } }]);
  const same = await sort([observed(key)], snap(desiredOf(), repo({ 'claude/CLAUDE.md': '# same\n' })), snap(desiredOf(), repo({ 'claude/CLAUDE.md': '# same\n' })));
  assert.deepEqual(same, { pending: [], drift: [key] });
});

test('items in sync, blocked or excluded are neither pending nor drift', async () => {
  const items = [observed(EFFORT_KEY, 'in-sync'), observed('config:claude:CLAUDE.md', 'blocked'), observed('integration:hk', 'excluded', 'integrations')];
  assert.deepEqual(await sort(items, snap(desiredOf()), snap(desiredOf({ settings: { effortLevel: 'high' } }))), { pending: [], drift: [] });
});
