import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitDocuments, desiredOfDocuments, revParse, worktreeDocuments, writeDocuments } from '../src/index.ts';
import { BASE, failureOf, json, load, runSync, tempRepo } from './support/repo.ts';

test("a commit's documents come from git objects, hook files included, never the working tree", async () => {
  const repo = tempRepo();
  repo.write({ 'claude/CLAUDE.md': '# uncommitted\n' });
  assert.deepEqual(await runSync(commitDocuments(repo.dir, repo.first)), BASE);
});

test("the working tree's documents include uncommitted edits", async () => {
  const repo = tempRepo();
  repo.write({ 'claude/CLAUDE.md': '# uncommitted\n' });
  assert.deepEqual(await runSync(worktreeDocuments(repo.dir)), { ...BASE, 'claude/CLAUDE.md': '# uncommitted\n' });
});

test('documents resolve exactly as loadProfile resolves the same files', async () => {
  const repo = tempRepo();
  assert.deepEqual(desiredOfDocuments(await runSync(worktreeDocuments(repo.dir))), await load(repo.dir));
});

test('written documents replace the directory and resolve the same', async () => {
  const repo = tempRepo();
  const dir = join(repo.root, 'out');
  await runSync(writeDocuments(dir, { 'stale.txt': 'x' }));
  await runSync(writeDocuments(dir, BASE));
  assert.deepEqual(await runSync(worktreeDocuments(dir)), BASE);
  assert.throws(() => readFileSync(join(dir, 'stale.txt')));
});

// Review Focus 4: the git path and the working tree must agree byte for byte on non-ASCII text.
test('a large non-ASCII instruction file reads the same from git as from disk', async () => {
  const text = `# règles — ${'é'.repeat(100000)}\n`;
  const repo = tempRepo({ ...BASE, 'claude/CLAUDE.md': text });
  assert.equal((await runSync(commitDocuments(repo.dir, repo.first)))['claude/CLAUDE.md'], text);
});

// Review Focus 5: a hook path that leaves the repository is never read.
test('a hook file outside the repository is never read', async () => {
  const repo = tempRepo();
  writeFileSync(join(repo.root, 'outside.mjs'), 'secret\n');
  repo.commit({
    'integrations.json': json({
      version: 1,
      integrations: [{ id: 'x', label: 'x', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: '../outside.mjs' }],
    }),
  });
  const documents = await runSync(worktreeDocuments(repo.dir));
  assert.equal(Object.hasOwn(documents, '../outside.mjs'), false);
});

test('an unknown commit is RevisionUnavailable', async () => {
  const repo = tempRepo();
  const failure = await failureOf(commitDocuments(repo.dir, 'f'.repeat(40)));
  assert.equal(failure._tag, 'RevisionUnavailable');
});

test('revParse answers the full SHA, or nothing for an unknown or option-like revision', async () => {
  const repo = tempRepo();
  assert.equal(await runSync(revParse(repo.dir, 'HEAD')), repo.first);
  assert.equal(await runSync(revParse(repo.dir, repo.first.slice(0, 7))), repo.first);
  assert.equal(await runSync(revParse(repo.dir, 'no-such-branch')), undefined);
  assert.equal(await runSync(revParse(repo.dir, '--all')), undefined);
});
