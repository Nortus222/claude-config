import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-backup-'));
process.env.NORTUSCC_CLAUDE_DIR = claude;
// Backups moved out of ~/.claude along with the rest of nortuscc's state.
process.env.NORTUSCC_STATE_DIR = mkdtempSync(join(tmpdir(), 'nortuscc-backup-state-'));

const { preserveCopy, backupOnce, backupPath } = await import('../src/backup.mjs');
const { backupRoot, stateRoot } = await import('../src/resolve.mjs');

function skillFolder(name) {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-skill-'));
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}\n`);
  return join(dir, name);
}

test('preserveCopy leaves the original in place', () => {
  const src = skillFolder('tdd');
  const target = preserveCopy(src, 'skills/tdd');
  assert.ok(existsSync(src), 'the skill must stay where the updater expects it');
  assert.ok(existsSync(target));
});

test('preserveCopy copies the folder contents', () => {
  const src = skillFolder('research');
  const target = preserveCopy(src, 'skills/research');
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), '# research\n');
});

test('preserveCopy returns null when there is nothing to preserve', () => {
  assert.equal(preserveCopy(join(claude, 'nope'), 'skills/nope'), null);
});

test('backupOnce still moves, so the two are not interchangeable', () => {
  const src = skillFolder('moved');
  backupOnce(src, 'skills/moved');
  assert.equal(existsSync(src), false, 'backupOnce is a move and must stay one');
});

// Backups follow the state file out of ~/.claude. Leaving them behind would
// put Codex's displaced files inside the Claude directory.
test('backups live under the state root, not under any agent directory', () => {
  assert.equal(backupRoot(), join(stateRoot(), 'backups'));
  assert.ok(!backupRoot().startsWith(claude));
});

// A single `--target all` run displaces one file per agent, and the two can
// carry the same relative name. Without the agent segment the second would
// overwrite the first inside the backup directory — losing exactly the copy
// the backup existed to keep.
test('an agent segment keeps two targets\' displaced files apart', () => {
  const claudeSide = backupPath('CLAUDE.md', 'claude');
  const codexSide = backupPath('AGENTS.md', 'codex');

  assert.match(claudeSide, /[/\\]claude[/\\]CLAUDE\.md$/);
  assert.match(codexSide, /[/\\]codex[/\\]AGENTS\.md$/);
  assert.notEqual(claudeSide, codexSide);

  // Same relative name, different agents: still two distinct paths.
  assert.notEqual(backupPath('NOTES.md', 'claude'), backupPath('NOTES.md', 'codex'));
});

// Skills belong to no single agent, so they keep sitting directly under the
// run directory rather than being filed under an arbitrary one.
test('omitting the agent leaves the path directly under the run directory', () => {
  assert.match(backupPath('skills/tdd'), /[/\\]skills[/\\]tdd$/);
  assert.doesNotMatch(backupPath('skills/tdd'), /[/\\](claude|codex)[/\\]/);
});
