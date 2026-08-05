import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'nortuscc-link-'));
process.env.NORTUSCC_CLAUDE_DIR = join(home, '.claude');
mkdirSync(process.env.NORTUSCC_CLAUDE_DIR, { recursive: true });

const { inspectLink, ensureLink } = await import('../src/link.mjs');

// A stand-in for the repo's claude/bin directory.
const repoBin = join(home, 'repo', 'claude', 'bin');
mkdirSync(repoBin, { recursive: true });
writeFileSync(join(repoBin, 'sp'), 'echo sp\n');

test('a missing destination reports missing', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-a');
  assert.equal(inspectLink(dest, repoBin).state, 'missing');
});

test('ensureLink creates a working link and the content is readable through it', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-b');
  const res = ensureLink(dest, repoBin, 'bin-b');
  assert.equal(res.state, 'linked');
  assert.equal(res.backedUp, null);
  assert.ok(lstatSync(dest).isSymbolicLink());
  assert.equal(readFileSync(join(dest, 'sp'), 'utf8'), 'echo sp\n');
  assert.equal(inspectLink(dest, repoBin).state, 'linked');
});

test('ensureLink is idempotent', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-c');
  ensureLink(dest, repoBin, 'bin-c');
  const second = ensureLink(dest, repoBin, 'bin-c');
  assert.equal(second.state, 'linked');
  assert.equal(second.backedUp, null, 'a clean re-run must not back anything up');
});

test('a real directory in the way is clobbered, and ensureLink backs it up', () => {
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-d');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'local-only.sh'), 'precious\n');
  assert.equal(inspectLink(dest, repoBin).state, 'clobbered');

  const res = ensureLink(dest, repoBin, 'bin-d');
  assert.equal(res.state, 'linked');
  assert.ok(res.backedUp, 'the displaced directory must be backed up');
  assert.equal(readFileSync(join(res.backedUp, 'local-only.sh'), 'utf8'), 'precious\n');
  assert.equal(readFileSync(join(dest, 'sp'), 'utf8'), 'echo sp\n');
});

test('a link to the wrong target is repointed', () => {
  const other = join(home, 'other');
  mkdirSync(other, { recursive: true });
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-e');
  ensureLink(dest, other, 'bin-e');
  assert.equal(inspectLink(dest, repoBin).state, 'wrong-target');

  const res = ensureLink(dest, repoBin, 'bin-e');
  assert.equal(res.state, 'linked');
  assert.equal(inspectLink(dest, repoBin).state, 'linked');
});

test('nothing is left behind in the claude dir that was not asked for', () => {
  assert.ok(existsSync(process.env.NORTUSCC_CLAUDE_DIR));
});
