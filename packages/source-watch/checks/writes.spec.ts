import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { ignoreRevision } from '../src/ignores.ts';
import { pinSource } from '../src/pins.ts';
import { tempDir } from './fixtures.ts';

const SHA = 'a'.repeat(40);
const pins = (entries: object) => JSON.stringify({ version: 1, pins: entries }, null, 2) + '\n';
const ignored = (entries: object) => JSON.stringify({ version: 1, ignored: entries }, null, 2) + '\n';

function setup(t: TestContext, pinsText?: string) {
  const root = tempDir(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  if (pinsText !== undefined) writeFileSync(join(repo, 'skill-pins.json'), pinsText);
  return { root, repo, options: { backupDir: join(root, 'backups') } };
}
const read = (repo: string, file = 'skill-pins.json') => readFileSync(join(repo, file), 'utf8');
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect));

test('pinning in a repo without a pin file creates it, with no backup', async (t) => {
  const { repo, options } = setup(t);
  assert.deepEqual(await Effect.runPromise(pinSource(repo, 'ada/skills', 'v1', options)), {});
  assert.equal(read(repo), pins({ 'ada/skills': 'v1' }));
  assert.equal(existsSync(options.backupDir), false);
  assert.deepEqual(readdirSync(repo), ['skill-pins.json']);
});

test('changing a pin backs up the old file first and reports the previous ref', async (t) => {
  const original = pins({ 'ada/skills': 'v1', 'bob/tools': 'v3' });
  const { repo, options } = setup(t, original);
  const written = await Effect.runPromise(pinSource(repo, 'ada/skills', 'v2', options));
  assert.equal(written.previous, 'v1');
  assert.match(written.backup!, /skill-pins\.json\.\d{8}T\d{9}Z(-\d+)?$/);
  assert.ok(written.backup!.startsWith(options.backupDir));
  assert.equal(readFileSync(written.backup!, 'utf8'), original);
  assert.equal(read(repo), pins({ 'ada/skills': 'v2', 'bob/tools': 'v3' }));
  assert.deepEqual(readdirSync(repo), ['skill-pins.json']);
});

test('calling again with the previous value undoes a change and a first pin', async (t) => {
  const original = pins({ 'ada/skills': 'v1', 'bob/tools': 'v3' });
  const { repo, options } = setup(t, original);
  const changed = await Effect.runPromise(pinSource(repo, 'ada/skills', 'v2', options));
  await Effect.runPromise(pinSource(repo, 'ada/skills', changed.previous, options));
  assert.equal(read(repo), original);

  const first = await Effect.runPromise(pinSource(repo, 'new/source', 'v9', options));
  assert.equal(first.previous, undefined);
  await Effect.runPromise(pinSource(repo, 'new/source', first.previous, options));
  assert.equal(read(repo), original);
});

test('two changes in a row keep two distinct backups', async (t) => {
  const { repo, options } = setup(t, pins({ a: 'v1' }));
  const one = await Effect.runPromise(pinSource(repo, 'a', 'v2', options));
  const two = await Effect.runPromise(pinSource(repo, 'a', 'v3', options));
  assert.notEqual(one.backup, two.backup);
  assert.equal(readdirSync(options.backupDir).length, 2);
  assert.equal(readFileSync(two.backup!, 'utf8'), pins({ a: 'v2' }));
});

test('an unchanged pin, or removing a pin from a repo without a pin file, writes nothing', async (t) => {
  const { repo, options } = setup(t, pins({ a: 'v1' }));
  assert.deepEqual(await Effect.runPromise(pinSource(repo, 'a', 'v1', options)), { previous: 'v1' });
  assert.equal(existsSync(options.backupDir), false);

  const empty = setup(t);
  assert.deepEqual(await Effect.runPromise(pinSource(empty.repo, 'a', undefined, empty.options)), {});
  assert.equal(existsSync(join(empty.repo, 'skill-pins.json')), false);
});

test('an invalid pin file is left untouched and not backed up', async (t) => {
  const broken = '{"version":2,"pins":{"a":"v1"}}';
  const { repo, options } = setup(t, broken);
  const error = await failure(pinSource(repo, 'a', 'v2', options));
  assert.equal(error._tag, 'DocumentInvalid');
  assert.equal(read(repo), broken);
  assert.equal(existsSync(options.backupDir), false);
});

test('empty sources and refs that are empty or read as options are refused', async (t) => {
  const { repo, options } = setup(t);
  for (const [source, ref] of [['a', ''], ['a', '--upload-pack=x'], ['', 'v1']] as const) {
    const error = await failure(pinSource(repo, source, ref, options));
    assert.equal(error._tag, 'DocumentInvalid');
  }
  assert.deepEqual(readdirSync(repo), []);
});

test('a write that cannot happen is a WriteFailed', async (t) => {
  const { root, options } = setup(t);
  const error = await failure(pinSource(join(root, 'missing'), 'a', 'v1', options));
  assert.equal(error._tag, 'WriteFailed');
});

test('ignoring a revision writes source-ignores.json, and removing it backs up first', async (t) => {
  const { repo, options } = setup(t);
  assert.deepEqual(await Effect.runPromise(ignoreRevision(repo, 'ada/skills', SHA, options)), {});
  assert.equal(read(repo, 'source-ignores.json'), ignored({ 'ada/skills': SHA }));

  const removed = await Effect.runPromise(ignoreRevision(repo, 'ada/skills', undefined, options));
  assert.equal(removed.previous, SHA);
  assert.match(removed.backup!, /source-ignores\.json\.\d{8}T\d{9}Z(-\d+)?$/);
  assert.equal(read(repo, 'source-ignores.json'), ignored({}));
});

test('only full commit shas can be ignored', async (t) => {
  const { repo, options } = setup(t);
  for (const sha of ['v1', 'abc123', 'g'.repeat(40)]) {
    const error = await failure(ignoreRevision(repo, 'a', sha, options));
    assert.equal(error._tag, 'DocumentInvalid');
  }
  await Effect.runPromise(ignoreRevision(repo, 'a', 'B'.repeat(40), options));
  await Effect.runPromise(ignoreRevision(repo, 'b', 'c'.repeat(64), options));
  assert.equal(read(repo, 'source-ignores.json'), ignored({ a: 'B'.repeat(40), b: 'c'.repeat(64) }));
});
