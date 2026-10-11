import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Effect } from 'effect';
import { FileIntegrity, FsFailed, nodeFileIntegrity } from '../src/index.ts';

const fixture = (t: { after: (f: () => void) => void }) => {
  const home = mkdtempSync(join(tmpdir(), 'file-integrity-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = <A>(f: (service: FileIntegrity['Service']) => Effect.Effect<A, FsFailed>) => Effect.runPromise(FileIntegrity.use(f).pipe(Effect.provide(nodeFileIntegrity)));
  return { home, run };
};

test('tree digest is stable across directory entry order and detects file bytes and modes', async t => {
  const f = fixture(t); const left = join(f.home, 'left'), right = join(f.home, 'right'); mkdirSync(left); mkdirSync(right);
  writeFileSync(join(left, 'a'), Buffer.from([0, 255, 13])); writeFileSync(join(left, 'b'), 'second');
  writeFileSync(join(right, 'b'), 'second'); writeFileSync(join(right, 'a'), Buffer.from([0, 255, 13]));
  const original = await f.run(service => service.digestTree(left));
  assert.equal(await f.run(service => service.digestTree(right)), original);
  writeFileSync(join(right, 'a'), Buffer.from([0, 255, 14]));
  assert.notEqual(await f.run(service => service.digestTree(right)), original);
  if (process.platform !== 'win32') {
    writeFileSync(join(right, 'a'), Buffer.from([0, 255, 13])); chmodSync(join(right, 'a'), 0o700);
    assert.notEqual(await f.run(service => service.digestTree(right)), original);
  }
});

test('tree digest records symlink targets without following external content', { skip: process.platform === 'win32' ? 'symlink creation requires Windows privileges' : false }, async t => {
  const f = fixture(t); const tree = join(f.home, 'tree'), external = join(f.home, 'external'); mkdirSync(tree); mkdirSync(external);
  writeFileSync(join(external, 'value'), 'before'); symlinkSync(external, join(tree, 'link'));
  const original = await f.run(service => service.digestTree(tree));
  writeFileSync(join(external, 'value'), 'after'); assert.equal(await f.run(service => service.digestTree(tree)), original);
  unlinkSync(join(tree, 'link')); symlinkSync('missing', join(tree, 'link'));
  assert.notEqual(await f.run(service => service.digestTree(tree)), original);
});

test('file digest matches raw binary SHA256 and flushing supports the file and containing directory', async t => {
  const f = fixture(t); const path = join(f.home, 'binary'); const bytes = Buffer.from([255, 0, 254, 128, 10]); writeFileSync(path, bytes);
  assert.equal(await f.run(service => service.sha256File(path)), createHash('sha256').update(bytes).digest('hex'));
  await f.run(service => service.syncPath(path));
  if (process.platform !== 'win32') await f.run(service => service.syncPath(f.home));
});

test('missing files produce typed integrity failures with operation and path', async t => {
  const f = fixture(t); const path = join(f.home, 'missing');
  for (const operation of ['digestTree', 'sha256File', 'syncPath'] as const) {
    const result = await f.run(service => Effect.result(service[operation](path)));
    assert.equal(result._tag, 'Failure');
    if (result._tag === 'Failure') { assert.ok(result.failure instanceof FsFailed); assert.equal(result.failure.path, path); assert.match(result.failure.reason, /ENOENT/); assert.ok(result.failure.op.length > 0); }
  }
});
