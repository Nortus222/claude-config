import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloneArgs, buildRevParseArgs, buildLsTreeArgs, inspectSource } from '../src/git-trees.mjs';

// A real repository, so the SHAs compared below are the ones git actually
// produces rather than ones this test made up.
const origin = mkdtempSync(join(tmpdir(), 'nortuscc-origin-'));
mkdirSync(join(origin, 'skills', 'tdd'), { recursive: true });
writeFileSync(join(origin, 'skills', 'tdd', 'SKILL.md'), '# tdd\n');
writeFileSync(join(origin, 'skills', 'tdd', 'NOT-SKILL.md'), 'decoy\n');
const git = (...args) => execFileSync('git', args, { cwd: origin, encoding: 'utf8' }).trim();
git('init', '--quiet');
git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.');
git('-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--quiet', '-m', 'seed');
const EXPECTED = git('rev-parse', 'HEAD:skills/tdd');
// file:// keeps git from treating this as a local clone, where --depth and
// --filter are ignored with a warning.
const ORIGIN_URL = pathToFileURL(origin).href;

test.after(() => rmSync(origin, { recursive: true, force: true }));

test('buildCloneArgs fetches trees but no blobs and no working copy', () => {
  const args = buildCloneArgs('https://example.com/r.git', '/tmp/x');
  assert.deepEqual(args, [
    'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet',
    'https://example.com/r.git', '/tmp/x',
  ]);
});

test('buildRevParseArgs asks for the tree at HEAD', () => {
  assert.deepEqual(buildRevParseArgs('skills/tdd'), ['rev-parse', 'HEAD:skills/tdd']);
});

test('inspectSource returns the real tree SHA git reports', async () => {
  const res = await inspectSource(ORIGIN_URL, ['skills/tdd']);
  assert.equal(res.trees.get('skills/tdd'), EXPECTED);
});

test('inspectSource maps a path that does not exist upstream to null', async () => {
  const res = await inspectSource(ORIGIN_URL, ['skills/tdd', 'skills/gone']);
  assert.equal(res.trees.get('skills/tdd'), EXPECTED);
  assert.equal(res.trees.get('skills/gone'), null);
});

test('inspectSource returns null when the clone itself fails', async () => {
  const res = await inspectSource(join(origin, 'does-not-exist'), ['skills/tdd']);
  assert.equal(res, null);
});

test('inspectSource removes its temporary clone even when the clone fails', async () => {
  let dir;
  const run = async (args) => {
    if (args[0] === 'clone') {
      dir = args[args.length - 1];
      return { code: 128, out: '', err: 'fatal: could not clone' };
    }
    return { code: 0, out: 'deadbeef', err: '' };
  };
  const res = await inspectSource(ORIGIN_URL, ['skills/tdd'], { run });
  assert.equal(res, null);
  assert.equal(existsSync(dir), false, 'the temp clone must not survive a failed clone');
});

test('buildCloneArgs produces a shallow clone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nortuscc-shallow-'));
  try {
    execFileSync('git', buildCloneArgs(ORIGIN_URL, dir), { encoding: 'utf8' });
    // A shallow clone writes .git/shallow; a full clone does not. This is what
    // makes --depth 1 load-bearing rather than merely requested — the review
    // confirmed this distinction holds for file:// on this machine, whereas a
    // bare local path makes git ignore --depth entirely.
    assert.equal(existsSync(join(dir, '.git', 'shallow')), true, '--depth 1 should produce a shallow clone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspectSource removes its temporary clone', async () => {
  const dirs = [];
  const run = async (args) => {
    if (args[0] === 'clone') { dirs.push(args[args.length - 1]); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: 'deadbeef', err: '' };
  };
  await inspectSource(ORIGIN_URL, ['skills/tdd'], { run });
  assert.equal(dirs.length, 1);
  assert.equal(existsSync(dirs[0]), false, 'the temp clone must not survive the call');
});

test('buildLsTreeArgs lists every path at HEAD without checking anything out', () => {
  assert.deepEqual(buildLsTreeArgs(), ['ls-tree', '-r', 'HEAD', '--name-only']);
});

test('inspectSource returns every SKILL.md path in the repo', async () => {
  const res = await inspectSource(ORIGIN_URL, ['skills/tdd']);
  assert.deepEqual(res.skillPaths, ['skills/tdd/SKILL.md']);
});

test('inspectSource returns skill paths even when no tree paths were asked for', async () => {
  const res = await inspectSource(ORIGIN_URL, []);
  assert.deepEqual([...res.trees], []);
  assert.deepEqual(res.skillPaths, ['skills/tdd/SKILL.md'], 'the listing is independent of the SHA lookups');
});

test('inspectSource ignores files that merely contain SKILL.md in their name', async () => {
  const res = await inspectSource(ORIGIN_URL, []);
  assert.ok(!res.skillPaths.some((p) => p.endsWith('NOT-SKILL.md')));
});
