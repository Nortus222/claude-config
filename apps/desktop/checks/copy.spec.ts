import test from 'node:test';
import assert from 'node:assert/strict';
import { causeText, changeTitle, errorText, itemLabel, relativeTime, runReport } from '../src/copy.ts';

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
  assert.equal(errorText(coded('NO_REPORT')), 'The agent hasn’t checked this Mac yet. Wait a moment, then reload.');
  assert.equal(errorText(coded('MALFORMED')), 'Lost the connection to the agent. Reconnect the agent.');
});

test('errorText keeps the agent\'s UNAUTHORIZED sentence and adds what to do', () => {
  assert.equal(errorText('UNAUTHORIZED: No access to repository https://github.com/o/r.git'),
    'No access to repository https://github.com/o/r.git. Check that your GitHub account can push to it, then try again.');
  assert.equal(errorText(Object.assign(new Error(''), { code: 'UNAUTHORIZED' })),
    'GitHub refused access to the repository. Check that your GitHub account can push to it, then try again.');
});

test('errorText drops the agent\'s closing inspect advice as causeText does', () => {
  assert.equal(errorText('UNKNOWN_KEY: \'skill:tdd\' is not an item of the last inspection; inspect again'), '\'skill:tdd\' is not an item of the last inspection');
  assert.equal(errorText('Instructions changed since inspection; inspect the machine before trying again'), 'Instructions changed since inspection');
  assert.equal(errorText('Couldn\'t inspect the file'), 'Couldn\'t inspect the file');
});

test('causeText says why a run stopped without the agent\'s inspect advice', () => {
  assert.equal(causeText('Operation stopped; inspect before retrying'), 'It stopped before finishing, and the agent didn’t record why.');
  assert.equal(causeText('Agent stopped while applying skill tdd; inspect before trying again'), 'Agent stopped while applying skill tdd.');
  assert.equal(causeText('Run receipt could not be saved; inspect the machine before trying again'), 'Run receipt could not be saved.');
  assert.equal(causeText('Couldn\'t write Claude setting theme: EACCES'), 'Couldn\'t write Claude setting theme: EACCES.');
  assert.equal(causeText('EACCES: permission denied'), 'EACCES: permission denied.');
  assert.equal(causeText('Couldn\'t inspect the file'), 'Couldn\'t inspect the file.');
  assert.equal(causeText(''), ''); assert.equal(causeText(undefined), ''); assert.equal(causeText('; inspect before retrying'), '');
});

test('runReport is plain text naming the change, cause, failed steps, run ID, backups and the agent log', () => {
  const text = runReport({ title: 'Apply changes to this Mac', state: 'Failed', cause: 'Couldn\'t write Claude setting theme: EACCES.', runId: 'run-1',
    failed: [{ label: 'Claude setting theme', key: 'config:claude:settings.json#theme', note: 'EACCES: permission denied' }], written: 2, notWritten: 3, backupIds: ['b-1'] });
  assert.equal(text, [
    'Apply changes to this Mac: Failed',
    'Cause: Couldn\'t write Claude setting theme: EACCES.',
    'Failed steps:',
    '- Claude setting theme (config:claude:settings.json#theme): EACCES: permission denied',
    'Written: 2, not written: 3',
    'Run ID: run-1',
    'Backups: ~/.config/nortuscc/backups/b-1',
    'Agent log: ~/.config/nortuscc/agent/agent.log',
  ].join('\n'));
  assert.doesNotMatch(runReport({ title: 'T', state: 'Failed', cause: '', runId: 'r', failed: [], written: 0, notWritten: null, backupIds: [] }), /Cause|Failed steps|Backups|not written/);
});

test('errorText shows the agent\'s own OVERSIZED sentence, with a fallback only when it has none', () => {
  assert.equal(errorText('OVERSIZED: Setup preview exceeds supported limits'), 'Setup preview exceeds supported limits');
  assert.equal(errorText(Object.assign(new Error('Result exceeds 1048576 bytes'), { code: 'OVERSIZED' })), 'Result exceeds 1048576 bytes');
  assert.equal(errorText('OVERSIZED: '), 'Too much to show at once.');
  assert.equal(errorText(Object.assign(new Error(''), { code: 'OVERSIZED' })), 'Too much to show at once.');
});

test('errorText keeps other messages without their code prefix', () => {
  assert.equal(errorText('APP_UNAVAILABLE: Follow your setup repository first'), 'Follow your setup repository first');
  assert.equal(errorText(Object.assign(new Error('INVALID_INPUT: Choose at least one item.'), { code: 'INVALID_INPUT' })), 'Choose at least one item.');
  assert.equal(errorText(new Error('Disk is full.')), 'Disk is full.');
  assert.equal(errorText({ message: 'BUSY: Another run is in progress.' }), 'Another run is in progress.');
  const unknown = 'The agent stopped without saying why. Try again, and if it keeps happening use Reconnect agent in Settings.';
  assert.equal(errorText(undefined), unknown);
  assert.equal(errorText(new Error('CODE: ')), unknown);
  assert.equal(errorText(new Error('first line\n  second line')), 'first line second line');
});
