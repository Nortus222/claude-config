import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSetupChoices, setupPinGroups, validateSetupPinChoices } from '../src/setup-choices.ts';
import { itemValues, patchItem } from '../src/index.ts';
const source = 'owner/repo';
const one = `skill:${source}/one`, two = `skill:${source}/two`;
const pin = (value: string, skills = 'one\ntwo') => ({ 'skills-manifest.txt': `[${source}]\n${skills}\n`, 'skill-pins.json': JSON.stringify({ version: 1, pins: { [source]: value.repeat(40) } }) });
const hook = (ids: string[], body: string, path = 'hooks/session.mjs') => ({
  'integrations.json': JSON.stringify({ version: 1, integrations: ids.map(id => ({ id, label: id, type: 'hook', target: 'claude', default: true, event: 'SessionStart', file: path })) }),
  [path]: body,
});

test('skills sharing a source pin require the same explicit action for every sibling', () => {
  const groups = setupPinGroups(pin('1'), pin('2'));
  assert.deepEqual(groups, [{ source, itemIds: [one, two] }]);
  assert.throws(() => validateSetupPinChoices(groups, [{ itemId: one, action: 'accept' }, { itemId: two, action: 'hold' }]), /Choices for owner\/repo must match: its items share one pin\./);
  assert.throws(() => validateSetupPinChoices(groups, [{ itemId: one, action: 'accept' }]), /must match/);
  assert.doesNotThrow(() => validateSetupPinChoices(groups, [{ itemId: one, action: 'accept' }, { itemId: two, action: 'accept' }]));
});

test('a held source pin retains every sibling current value', () => {
  const current = pin('1'), offered = pin('2');
  const result = composeSetupChoices({ current, offered, accepted: [], holds: { [one]: 'old' } });
  assert.deepEqual([...itemValues(result)], [...itemValues(current)]);
});

test('mixed skill origins cannot overwrite a retained sibling source pin', () => {
  assert.throws(() => composeSetupChoices({ current: pin('1'), offered: pin('2'), accepted: [one], holds: { [two]: 'old' } }), /share one pin/);
});

test('accepting all source siblings adopts the offered pin together', () => {
  const offered = pin('2');
  assert.deepEqual([...itemValues(composeSetupChoices({ current: pin('1'), offered, accepted: [one, two], holds: {} }))], [...itemValues(offered)]);
});

test('absent held skills retain their actual source pin during partial adoption', () => {
  assert.throws(() => composeSetupChoices({ current: {}, offered: pin('2'), accepted: [one], holds: { [two]: 'old' } }), /share one pin/);
});

test('retaining a hook keeps its origin bytes when offered metadata or paths change', () => {
  const current = hook(['one'], 'old\n');
  for (const offered of [hook(['one'], 'new\n'), hook(['one'], 'new\n', 'hooks/new.mjs'), {}]) {
    const result = composeSetupChoices({ current, offered, accepted: [], holds: {} });
    assert.equal(result['hooks/session.mjs'], 'old\n');
    assert.deepEqual([...itemValues(result)], [...itemValues(current)]);
  }
});

test('accepting a hook chooses its offered bytes', () => {
  const result = composeSetupChoices({ current: hook(['one'], 'old\n'), offered: hook(['one'], 'new\n'), accepted: ['integration:one'], holds: {} });
  assert.equal(result['hooks/session.mjs'], 'new\n');
});

test('selected hook declarations cannot require contradictory bytes for one path', () => {
  assert.throws(() => composeSetupChoices({ current: hook(['one', 'two'], 'old\n'), offered: hook(['one', 'two'], 'new\n'), accepted: ['integration:one'], holds: {} }), /hook/);
});

test('retained item values preserve independent settings and removals', () => {
  const current = { 'claude/settings.keys.json': '{"theme":"dark","effortLevel":"high"}', 'claude/CLAUDE.md': 'old rules' };
  const offered = { 'claude/settings.keys.json': '{"theme":"light","effortLevel":"low"}' };
  const result = composeSetupChoices({ current, offered, accepted: ['setting:claude:settings.json#effortLevel'], holds: {} });
  assert.equal(result['claude/CLAUDE.md'], 'old rules');
  assert.deepEqual(JSON.parse(result['claude/settings.keys.json']!), { theme: 'dark', effortLevel: 'low' });
});

test('an existing held origin is preserved when a different incoming item is accepted', () => {
  const raw = { 'claude/settings.keys.json': '{"theme":"dark","effortLevel":"high"}' };
  const held = { 'claude/settings.keys.json': '{"theme":"older"}' };
  const current = patchItem(raw, 'setting:claude:settings.json#theme', held);
  const result = composeSetupChoices({ current, offered: { 'claude/settings.keys.json': '{"theme":"light","effortLevel":"low"}' }, accepted: ['setting:claude:settings.json#effortLevel'], holds: { 'setting:claude:settings.json#theme': 'older-origin' } });
  assert.deepEqual(JSON.parse(result['claude/settings.keys.json']!), { theme: 'older', effortLevel: 'low' });
});

test('different held origins with the same actual pin remain compatible', () => {
  const current = pin('1'), offered = pin('2');
  const result = composeSetupChoices({ current, offered, accepted: [], holds: { [one]: 'origin-one', [two]: 'origin-two' } });
  assert.deepEqual([...itemValues(result)], [...itemValues(current)]);
});

test('first pins and pin removal both require every source sibling', () => {
  const unpinned = { 'skills-manifest.txt': `[${source}]\none\ntwo\n` };
  for (const [current, offered] of [[unpinned, pin('2')], [pin('1'), unpinned]]) {
    const groups = setupPinGroups(current!, offered!);
    assert.throws(() => validateSetupPinChoices(groups, [{ itemId: one, action: 'accept' }]), /must match/);
    const result = composeSetupChoices({ current: current!, offered: offered!, accepted: [one, two], holds: {} });
    assert.deepEqual([...itemValues(result)], [...itemValues(offered!)]);
  }
});

test('removing one skill cannot change a retained sibling pin', () => {
  const current = pin('1'), offered = pin('2', 'two');
  assert.throws(() => composeSetupChoices({ current, offered, accepted: [two], holds: { [one]: 'origin' } }), /share one pin/);
});

test('independent validation refuses different hook bytes after composition', async () => {
  const { validateSetupComposition } = await import('../src/setup-choices.ts');
  const current = hook(['one'], 'old\n'), offered = hook(['one'], 'new\n');
  const expected = composeSetupChoices({ current, offered, accepted: [], holds: { 'integration:one': 'origin' } });
  const replayed = patchItem(offered, 'integration:one', current);
  assert.equal(replayed['hooks/session.mjs'], 'old\n');
  assert.throws(() => validateSetupComposition(expected, { ...replayed, 'hooks/session.mjs': 'new\n' }), /hook bytes/);
});

test('independent validation accepts equal hook bytes at the offered path', async () => {
  const { validateSetupComposition } = await import('../src/setup-choices.ts');
  const current = hook(['one'], 'same\n'), offered = hook(['one', 'two'], 'same\n');
  const expected = composeSetupChoices({ current, offered, accepted: ['integration:two'], holds: {} });
  assert.doesNotThrow(() => validateSetupComposition(expected, expected));
});

test('pin groups include an absent held sibling so its pin consequences remain explicit', () => {
  const groups = setupPinGroups({}, pin('2', 'two'), [one]);
  assert.deepEqual(groups, [{ source, itemIds: [one, two] }]);
  assert.throws(() => validateSetupPinChoices(groups, [{ itemId: two, action: 'accept' }]), /share one pin/);
});
