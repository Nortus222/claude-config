import assert from 'node:assert/strict';
import { test } from 'node:test';
import { additionCommand, addCommand } from '../src/skills/installer.ts';

test('new additions use the fixed native installer and metadata selector at the accepted revision', () => {
  const revision = 'a'.repeat(40);
  assert.deepEqual(additionCommand({ source: 'fixture/source', revision, selectorName: 'Design Review', targets: ['claude', 'codex'] }), {
    cmd: 'npx', args: ['-y', 'skills@1.7.2', 'add', `https://github.com/fixture/source/tree/${revision}`, '--skill', 'Design Review', '--agent', 'claude-code', 'codex', '--global', '--yes'], output: 'inherit',
  });
  assert.equal(addCommand({ source: 'fixture/source', skills: ['legacy'], targets: ['claude'] }).args[1], 'skills');
});

for (const change of [
  { source: 'https://user:secret@github.com/o/r' }, { revision: '--help' }, { selectorName: '--all' },
  { selectorName: '*' }, { selectorName: 'a/b' }, { selectorName: 'a\nhelp' }, { targets: [] }, { targets: ['other'] },
]) {
  test(`addition command refuses invalid input ${Object.keys(change)[0]}`, () => {
    assert.throws(() => additionCommand({ source: 'fixture/source', revision: 'a'.repeat(40), selectorName: 'Design Review', targets: ['claude'], ...change } as Parameters<typeof additionCommand>[0]), /invalid skill addition command/);
  });
}
