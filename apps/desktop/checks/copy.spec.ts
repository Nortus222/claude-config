import test from 'node:test';
import assert from 'node:assert/strict';
import { changeTitle, errorText, itemLabel, relativeTime } from '../src/copy.ts';

test('itemLabel names settings by agent and key, with the key as the name', () => {
  assert.deepEqual(itemLabel('setting:claude:settings.json#model'), { lead: 'Claude setting ', name: 'model', tail: '', text: 'Claude setting model' });
  assert.equal(itemLabel('setting:claude:settings.json#env.FOO').text, 'Claude setting env.FOO');
  assert.equal(itemLabel('setting:codex:config.toml#model').text, 'Codex setting model');
});

test('itemLabel names every managed file by agent and purpose', () => {
  assert.deepEqual(itemLabel('file:claude:CLAUDE.md'), { lead: 'Claude instructions (', name: 'CLAUDE.md', tail: ')', text: 'Claude instructions (CLAUDE.md)' });
  assert.equal(itemLabel('file:claude:settings.json').text, 'Claude settings (settings.json)');
  assert.equal(itemLabel('file:codex:AGENTS.md').text, 'Codex instructions (AGENTS.md)');
  assert.equal(itemLabel('file:codex:config.toml').text, 'Codex configuration (config.toml)');
  assert.equal(itemLabel('file:codex:models-static.json').text, 'Codex model list (models-static.json)');
  assert.equal(itemLabel('file:claude:notes.md').text, 'Claude file (notes.md)');
});

test('itemLabel names skills with their source and integrations by id', () => {
  assert.deepEqual(itemLabel('skill:mattpocock/skills/tdd'), { lead: 'Skill ', name: 'tdd', tail: ' from mattpocock/skills', text: 'Skill tdd from mattpocock/skills' });
  assert.equal(itemLabel('skill:tdd').text, 'Skill tdd');
  assert.deepEqual(itemLabel('integration:x'), { lead: 'Integration ', name: 'x', tail: '', text: 'Integration x' });
});

test('itemLabel never shows an unknown or malformed key', () => {
  for (const key of ['', 'undeclared:claude:mcp:x', 'setting:claude:settings.json', 'setting:#model', 'file:', 'skill:', 'skill:/tdd', 'skill:a/b/', 'integration:']) {
    assert.deepEqual(itemLabel(key), { lead: 'Item', name: '', tail: '', text: 'Item' }, key);
  }
});

test('changeTitle uses the plan wording for run kinds', () => {
  assert.equal(changeTitle('setupApply'), 'Apply incoming changes');
  assert.equal(changeTitle('followProfile'), 'Follow profile');
  assert.equal(changeTitle('reconcile'), 'Apply changes to this Mac');
  assert.equal(changeTitle('machineIntent'), 'Save skill choice');
  assert.equal(changeTitle('update'), 'Update skills');
  assert.equal(changeTitle('addSkill'), 'Add a skill');
  assert.equal(changeTitle('uninstallConfig'), 'Restore configuration');
  assert.equal(changeTitle('publishDraft'), 'Publish draft');
  assert.equal(changeTitle('announcePublication'), 'Announce publication');
});

test('relativeTime counts minutes, hours and days, then shows a short date', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  assert.equal(relativeTime(ago(0), now), 'just now');
  assert.equal(relativeTime(ago(59_000), now), 'just now');
  assert.equal(relativeTime(ago(-30_000), now), 'just now');
  assert.equal(relativeTime(ago(60_000), now), '1 minute ago');
  assert.equal(relativeTime(ago(42 * 60_000), now), '42 minutes ago');
  assert.equal(relativeTime(ago(3_600_000), now), '1 hour ago');
  assert.equal(relativeTime(ago(23 * 3_600_000), now), '23 hours ago');
  assert.equal(relativeTime(ago(86_400_000), now), '1 day ago');
  assert.equal(relativeTime(ago(6 * 86_400_000), now), '6 days ago');
  assert.equal(relativeTime('2026-10-03T12:00:00Z', now), 'Oct 3');
  assert.equal(relativeTime('2025-10-03T12:00:00Z', now), 'Oct 3, 2025');
  assert.equal(relativeTime('not a time', now), '');
});

test('errorText picks text by code for codes the app special-cases', () => {
  const coded = (code: string, message = 'raw detail') => Object.assign(new Error(message), { code });
  assert.equal(errorText(coded('NOT_SIGNED_IN')), 'Not signed in to GitHub, or GitHub is unreachable. Sign in, then retry.');
  assert.equal(errorText(coded('UNAUTHORIZED')), 'Access was refused. Check your permissions, then retry.');
  assert.equal(errorText(coded('NO_REPORT')), 'Waiting for the agent’s first inspection.');
  assert.equal(errorText(coded('MALFORMED')), 'Lost the connection to the agent. Reconnect the agent.');
  assert.equal(errorText(coded('OVERSIZED')), 'Too much to show at once. Select fewer items.');
  assert.equal(errorText('OVERSIZED: Setup preview exceeds supported limits'), 'Too much to show at once. Select fewer items.');
  assert.equal(errorText('UNAUTHORIZED: refused'), 'Access was refused. Check your permissions, then retry.');
});

test('errorText keeps other messages without their code prefix', () => {
  assert.equal(errorText('APP_UNAVAILABLE: Follow your setup repository first'), 'Follow your setup repository first');
  assert.equal(errorText(Object.assign(new Error('INVALID_INPUT: Choose at least one item.'), { code: 'INVALID_INPUT' })), 'Choose at least one item.');
  assert.equal(errorText(new Error('Disk is full.')), 'Disk is full.');
  assert.equal(errorText({ message: 'BUSY: Another run is in progress.' }), 'Another run is in progress.');
  assert.equal(errorText(undefined), 'Something went wrong.');
  assert.equal(errorText(new Error('CODE: ')), 'Something went wrong.');
});
