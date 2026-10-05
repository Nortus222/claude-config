import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Exit } from 'effect';
import { Fs, nodeFs } from '../src/index.ts';

const run = <A, E>(effect: Effect.Effect<A, E, Fs>) => Effect.runPromise(effect.pipe(Effect.provide(nodeFs)));
const scratch = () => mkdtempSync(join(tmpdir(), 'machine-fs-'));

test('readText returns undefined for an absent file', async () => {
  assert.equal(await run(Fs.use((fs) => fs.readText(join(scratch(), 'nope')))), undefined);
});

test('writeTextAtomic creates parents and leaves no temp file', async () => {
  const dir = scratch();
  const target = join(dir, 'a', 'b', 'state.json');
  await run(Fs.use((fs) => fs.writeTextAtomic(target, '{"x":1}\n')));
  assert.equal(readFileSync(target, 'utf8'), '{"x":1}\n');
  assert.deepEqual(readdirSync(join(dir, 'a', 'b')), ['state.json']);
});

test('copy keeps a symlink a symlink', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'real'), 'r');
  symlinkSync(join(dir, 'real'), join(dir, 'link'));
  await run(Fs.use((fs) => fs.copy(join(dir, 'link'), join(dir, 'out', 'link'))));
  assert.ok(lstatSync(join(dir, 'out', 'link')).isSymbolicLink());
  assert.equal(readlinkSync(join(dir, 'out', 'link')), join(dir, 'real'));
});

test('move relocates a directory and remove tolerates absence', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'f'), 'x');
  await run(Effect.gen(function* () {
    const fs = yield* Fs;
    yield* fs.move(join(dir, 'src'), join(dir, 'deep', 'dst'));
    yield* fs.remove(join(dir, 'never-existed'));
  }));
  assert.equal(existsSync(join(dir, 'src')), false);
  assert.equal(readFileSync(join(dir, 'deep', 'dst', 'f'), 'utf8'), 'x');
});

test('exists sees a dangling symlink', async () => {
  const dir = scratch();
  symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
  assert.equal(await run(Fs.use((fs) => fs.exists(join(dir, 'dangling')))), true);
});

test('a failed writeTextAtomic fails with FsFailed and leaves no temp file', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'target'));
  const exit = await Effect.runPromiseExit(Fs.use((fs) => fs.writeTextAtomic(join(dir, 'target'), 'x')).pipe(Effect.provide(nodeFs)));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('FsFailed'));
  assert.deepEqual(readdirSync(dir), ['target']);
});

test('move onto an existing non-empty directory fails and keeps the source', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'f'), 'x');
  mkdirSync(join(dir, 'dst'));
  writeFileSync(join(dir, 'dst', 'g'), 'y');
  const exit = await Effect.runPromiseExit(Fs.use((fs) => fs.move(join(dir, 'src'), join(dir, 'dst'))).pipe(Effect.provide(nodeFs)));
  assert.ok(Exit.isFailure(exit));
  assert.equal(readFileSync(join(dir, 'src', 'f'), 'utf8'), 'x');
  assert.equal(existsSync(join(dir, 'dst', 'f')), false);
});

test('writeTextAtomic through a symlink keeps the link and writes its target', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'repo'));
  writeFileSync(join(dir, 'repo', 'CLAUDE.md'), 'old');
  symlinkSync(join(dir, 'repo', 'CLAUDE.md'), join(dir, 'CLAUDE.md'));
  await run(Fs.use((fs) => fs.writeTextAtomic(join(dir, 'CLAUDE.md'), 'new')));
  assert.ok(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink());
  assert.equal(readFileSync(join(dir, 'repo', 'CLAUDE.md'), 'utf8'), 'new');
  assert.deepEqual(readdirSync(join(dir, 'repo')), ['CLAUDE.md']);
});

test('writeTextAtomic keeps an existing file mode', { skip: process.platform === 'win32' }, async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'auth.json'), '{}');
  chmodSync(join(dir, 'auth.json'), 0o600);
  await run(Fs.use((fs) => fs.writeTextAtomic(join(dir, 'auth.json'), '{"k":1}')));
  assert.equal(statSync(join(dir, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"k":1}');
});

test('list returns sorted entry names, or undefined when absent', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'b'), '');
  mkdirSync(join(dir, 'a'));
  assert.deepEqual(await run(Fs.use((fs) => fs.list(dir))), ['a', 'b']);
  assert.equal(await run(Fs.use((fs) => fs.list(join(dir, 'nope')))), undefined);
});

test('stat reports the kind without following links, or undefined when absent', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'f'), '');
  mkdirSync(join(dir, 'd'));
  symlinkSync(join(dir, 'missing'), join(dir, 'l'));
  const kinds = await run(Effect.gen(function* () {
    const fs = yield* Fs;
    return [yield* fs.stat(join(dir, 'f')), yield* fs.stat(join(dir, 'd')), yield* fs.stat(join(dir, 'l')), yield* fs.stat(join(dir, 'x'))];
  }));
  assert.deepEqual(kinds, [{ kind: 'file' }, { kind: 'directory' }, { kind: 'symlink' }, undefined]);
});

test('readLink returns a link target and fails with FsFailed on a regular file', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'f'), '');
  symlinkSync(join(dir, 'f'), join(dir, 'l'));
  assert.equal(await run(Fs.use((fs) => fs.readLink(join(dir, 'l')))), join(dir, 'f'));
  const exit = await Effect.runPromiseExit(Fs.use((fs) => fs.readLink(join(dir, 'f'))).pipe(Effect.provide(nodeFs)));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('FsFailed'));
});

test('symlink creates parents and the link', async () => {
  const dir = scratch();
  await run(Fs.use((fs) => fs.symlink(join(dir, 'target'), join(dir, 'a', 'b', 'link'))));
  assert.equal(readlinkSync(join(dir, 'a', 'b', 'link')), join(dir, 'target'));
});

test('realPath follows links and reads a dangling or absent path as undefined', async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'target'));
  symlinkSync(join(dir, 'target'), join(dir, 'link'));
  symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
  const real = (p: string) => run(Fs.use((fs) => fs.realPath(p)));
  assert.equal(await real(join(dir, 'link')), realpathSync(join(dir, 'target')));
  assert.equal(await real(join(dir, 'dangling')), undefined);
  assert.equal(await real(join(dir, 'absent')), undefined);
});
