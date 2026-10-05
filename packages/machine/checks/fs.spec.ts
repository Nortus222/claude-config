import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
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
