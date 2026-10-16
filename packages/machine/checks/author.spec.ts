import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { bindAuthorCheckout, validateAuthorBinding, executeAuthorEdit, nodeProcesses, authorDigest } from '../src/index.ts';

import { authorMachine } from './author-machine.ts';
const files = ['claude/CLAUDE.md', 'codex/AGENTS.md'];
test('configured author tolerates unrelated dirty and staged bytes and detects selected index mode changes', async () => {
  const m = authorMachine(); const binding = await m.run(bindAuthorCheckout(m.paths, files));
  m.write(join(m.paths.repo, 'unrelated'), 'dirty'); m.git('add', 'unrelated');
  await m.run(validateAuthorBinding(binding));
  m.git('update-index', '--chmod=+x', files[0]!);
  await assert.rejects(m.run(validateAuthorBinding(binding)), /Author checkout/);
});
test('author refuses changed HEAD, selected bytes, symlinks and invalid UTF-8', async () => {
  const m = authorMachine(); const binding = await m.run(bindAuthorCheckout(m.paths, files));
  m.write(join(m.paths.repo, files[0]!), 'moved'); await assert.rejects(m.run(validateAuthorBinding(binding)));
  m.git('checkout', '--', files[0]!);
  m.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'moved');
  await assert.rejects(m.run(validateAuthorBinding(binding)));
  symlinkSync(m.paths.claude, join(m.paths.repo, 'escape'));
  await assert.rejects(m.run(bindAuthorCheckout(m.paths, ['escape/file'])));
  writeFileSync(join(m.paths.repo, files[0]!), Buffer.from([0xff]));
  await assert.rejects(m.run(bindAuthorCheckout(m.paths, files)));
});
test('author git ignores inherited redirection and configured core.worktree', async () => {
  const m = authorMachine(); const other = authorMachine();
  m.git('config', 'core.worktree', other.paths.repo);
  const effect = bindAuthorCheckout(m.paths, files).pipe(Effect.provide(Layer.mergeAll(m.layer(), nodeProcesses({ env: { PATH: process.env.PATH, GIT_DIR: join(other.paths.repo, '.git'), GIT_WORK_TREE: other.paths.repo, GIT_INDEX_FILE: join(other.paths.repo, '.git/index') } }))));
  const binding = await Effect.runPromise(effect);
  assert.equal(binding.realCheckout, realpathSync(m.paths.repo)); assert.equal(binding.gitDir, realpathSync(join(m.paths.repo, '.git')));
});
test('two author replacements preserve original index and accept only observed own writes', async () => {
  const m = authorMachine(); const author = await m.run(bindAuthorCheckout(m.paths, files));
  const index = readFileSync(join(m.paths.repo, '.git/index'));
  const documents = author.files.map(file => ({ path: file.path, beforeSha256: file.sha256, text: 'replacement\n', afterSha256: authorDigest('replacement\n')! }));
  const committed: string[] = [];
  const result = await m.run(executeAuthorEdit({ author, documents }, new AbortController().signal, { pending: () => Effect.void, committed: key => Effect.sync(() => { committed.push(key); }) }));
  assert.deepEqual(result.committedPaths, files); assert.deepEqual(committed, files);
  assert.deepEqual(readFileSync(join(m.paths.repo, '.git/index')), index);
});
test('external edit after first author replacement refuses second and retains observed first effect', async () => {
  const m = authorMachine(); const author = await m.run(bindAuthorCheckout(m.paths, files)); const commits: string[] = [];
  const documents = author.files.map(file => ({ path: file.path, beforeSha256: file.sha256, text: 'replacement\n', afterSha256: authorDigest('replacement\n')! }));
  await assert.rejects(m.run(executeAuthorEdit({ author, documents }, new AbortController().signal, { pending: () => Effect.void, committed: key => Effect.sync(() => { commits.push(key); m.write(join(m.paths.repo, files[0]!), 'external'); }) })));
  assert.deepEqual(commits, [files[0]]); assert.equal(m.read(join(m.paths.repo, files[1]!)), '# repo codex\n');
});

test('a Git-dir redirect invalidates the author even with unchanged HEAD and document bytes', async () => {
 const m = authorMachine(); const binding = await m.run(bindAuthorCheckout(m.paths, files));
 renameSync(join(m.paths.repo, '.git'), join(m.paths.repo, '.original-git'));
 m.write(join(m.paths.repo, '.git'), 'gitdir: .original-git\n');
 await assert.rejects(m.run(validateAuthorBinding(binding)));
});
