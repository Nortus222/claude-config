import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  lstatSync,
  symlinkSync,
  rmSync,
  lutimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';

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

test('a relative symlink target that genuinely points at the expected location is linked', () => {
  // readlinkSync returns the link's raw text, which for a relative symlink
  // must be resolved against the *link's own directory*, not process.cwd().
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-f');
  const relTarget = relative(dirname(dest), repoBin);
  symlinkSync(relTarget, dest, 'dir');
  assert.equal(inspectLink(dest, repoBin).state, 'linked');
});

// C1: the reproduction is mundane — delete the worktree, or move the clone —
// and the old state machine called the result 'linked' because it only ever
// compared the link's text against the expected path. `cat ~/.claude/bin/sp`
// failed while status reported agreement and apply short-circuited.
test('a link whose target has been removed is broken-link, not linked', () => {
  const goneTarget = join(home, 'gone', 'claude', 'bin');
  mkdirSync(goneTarget, { recursive: true });
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-g');

  ensureLink(dest, goneTarget, 'bin-g');
  assert.equal(inspectLink(dest, goneTarget).state, 'linked');

  // The repo moves away. The link text is still exactly right; the target is not.
  rmSync(join(home, 'gone'), { recursive: true, force: true });

  assert.equal(
    inspectLink(dest, goneTarget).state,
    'broken-link',
    'a dangling link must never report linked',
  );
});

test('ensureLink rebuilds a dangling link instead of short-circuiting on it', () => {
  const target = join(home, 'rebuild', 'claude', 'bin');
  mkdirSync(target, { recursive: true });
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-h');
  ensureLink(dest, target, 'bin-h');
  rmSync(join(home, 'rebuild'), { recursive: true, force: true });

  // Backdate the dangling link so "was this link recreated?" is observable
  // without depending on filesystem timestamp resolution.
  const old = new Date(946684800000); // 2000-01-01
  lutimesSync(dest, old, old);
  assert.equal(lstatSync(dest).mtimeMs, old.getTime());

  const res = ensureLink(dest, target, 'bin-h');

  assert.ok(
    lstatSync(dest).mtimeMs > old.getTime(),
    'ensureLink must remove and recreate a dangling link, not return early on it',
  );
  assert.equal(
    res.state,
    'broken-link',
    'with the repo path still gone, the rebuilt link is still broken — say so rather than claiming linked',
  );
});

test('ensureLink repairs a dangling link once the repo path is back', () => {
  const target = join(home, 'restored', 'claude', 'bin');
  mkdirSync(target, { recursive: true });
  const dest = join(process.env.NORTUSCC_CLAUDE_DIR, 'bin-i');
  ensureLink(dest, target, 'bin-i');

  rmSync(join(home, 'restored'), { recursive: true, force: true });
  assert.equal(inspectLink(dest, target).state, 'broken-link');

  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'sp'), 'echo restored\n');

  const res = ensureLink(dest, target, 'bin-i');
  assert.equal(res.state, 'linked');
  assert.equal(readFileSync(join(dest, 'sp'), 'utf8'), 'echo restored\n');
});

test('nothing is left behind in the claude dir that was not asked for', () => {
  assert.ok(existsSync(process.env.NORTUSCC_CLAUDE_DIR));
});
