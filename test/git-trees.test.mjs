import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCloneArgs, buildRevParseArgs, resolveTrees } from '../src/git-trees.mjs';

// A real repository, so the SHAs compared below are the ones git actually
// produces rather than ones this test made up.
const origin = mkdtempSync(join(tmpdir(), 'nortuscc-origin-'));
mkdirSync(join(origin, 'skills', 'tdd'), { recursive: true });
writeFileSync(join(origin, 'skills', 'tdd', 'SKILL.md'), '# tdd\n');
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

test('resolveTrees returns the real tree SHA git reports', async () => {
  const trees = await resolveTrees(ORIGIN_URL, ['skills/tdd']);
  assert.equal(trees.get('skills/tdd'), EXPECTED);
});

test('resolveTrees maps a path that does not exist upstream to null', async () => {
  const trees = await resolveTrees(ORIGIN_URL, ['skills/tdd', 'skills/gone']);
  assert.equal(trees.get('skills/tdd'), EXPECTED);
  assert.equal(trees.get('skills/gone'), null);
});

test('resolveTrees returns null when the clone itself fails', async () => {
  const trees = await resolveTrees(join(origin, 'does-not-exist'), ['skills/tdd']);
  assert.equal(trees, null);
});

test('resolveTrees with no paths clones nothing', async () => {
  let called = false;
  const trees = await resolveTrees(ORIGIN_URL, [], { run: async () => { called = true; } });
  assert.deepEqual([...trees], []);
  assert.equal(called, false, 'an empty path list has nothing to look up');
});

test('resolveTrees removes its temporary clone', async () => {
  const dirs = [];
  const run = async (args) => {
    if (args[0] === 'clone') { dirs.push(args[args.length - 1]); return { code: 0, out: '', err: '' }; }
    return { code: 0, out: 'deadbeef', err: '' };
  };
  await resolveTrees(ORIGIN_URL, ['skills/tdd'], { run });
  assert.equal(dirs.length, 1);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dirs[0]), false, 'the temp clone must not survive the call');
});
