import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const claude = mkdtempSync(join(tmpdir(), 'nortuscc-backup-'));
process.env.NORTUSCC_CLAUDE_DIR = claude;

const { preserveCopy, backupOnce } = await import('../src/backup.mjs');

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
