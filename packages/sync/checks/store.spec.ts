import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { machinePaths, nodeFs } from '@nortuscc/machine';
import { SyncStore, syncStore } from '../src/index.ts';

const EFFORT = 'setting:claude:settings.json#effortLevel';
const COMMIT = 'c'.repeat(40);

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-store-'));
  const stateRoot = join(root, 'state');
  const paths = {
    repo: join(root, 'repo'), claude: join(root, '.claude'), codex: join(root, '.codex'), codexOpenRouter: join(root, '.codex-openrouter'),
    agentsSkills: join(root, '.agents'), stateRoot, backups: join(stateRoot, 'backups'),
  };
  const path = join(stateRoot, 'sync.json');
  const layer = syncStore.pipe(Layer.provide(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(f: (store: SyncStore['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.result(SyncStore.use(f)).pipe(Effect.provide(layer)));
  const write = (text: string) => {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(path, text);
  };
  return { path, run, write };
};

test('an absent sync.json holds nothing', async () => {
  const m = machine();
  const read = await m.run((s) => s.read);
  assert.ok(read._tag === 'Success');
  assert.deepEqual(read.success, {});
});

test('holds round-trip, sorted by item id', async () => {
  const m = machine();
  await m.run((s) => s.write({ [EFFORT]: COMMIT, 'file:claude:CLAUDE.md': COMMIT }));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(m.path, 'utf8')).held), ['file:claude:CLAUDE.md', EFFORT]);
  const read = await m.run((s) => s.read);
  assert.ok(read._tag === 'Success');
  assert.deepEqual(read.success, { 'file:claude:CLAUDE.md': COMMIT, [EFFORT]: COMMIT });
});

const invalid: ReadonlyArray<readonly [string, string]> = [
  ['not JSON', '{ "version": 1, '],
  ['another version', JSON.stringify({ version: 2, held: {} })],
  ['no held map', JSON.stringify({ version: 1, held: [] })],
  ['an unknown item id', JSON.stringify({ version: 1, held: { 'undeclared:x': COMMIT } })],
  ['a held value that is not a commit', JSON.stringify({ version: 1, held: { [EFFORT]: 'main' } })],
];

for (const [what, text] of invalid) {
  test(`a sync.json with ${what} is SyncStateInvalid and is left as it was`, async () => {
    const m = machine();
    m.write(text);
    const read = await m.run((s) => s.read);
    assert.ok(read._tag === 'Failure');
    assert.equal(read.failure._tag, 'SyncStateInvalid');
    assert.match(read.failure.message, /sync\.json is not valid/);
    assert.equal(readFileSync(m.path, 'utf8'), text);
  });
}

test('write over an invalid sync.json fails and leaves it byte-identical', async () => {
  const m = machine();
  m.write('{ nope');
  const res = await m.run((s) => s.write({ [EFFORT]: COMMIT }));
  assert.ok(res._tag === 'Failure');
  assert.equal(res.failure._tag, 'SyncStateInvalid');
  assert.equal(readFileSync(m.path, 'utf8'), '{ nope');
});

test('write refuses invalid holds without creating a file', async () => {
  for (const held of ([{ bogus: 'main' }, { [EFFORT]: 'main' }, { [EFFORT]: 5 as unknown as string }] as Array<Record<string, string>>)) {
    const m = machine();
    const res = await m.run((s) => s.write(held));
    assert.ok(res._tag === 'Failure');
    assert.equal(res.failure._tag, 'SyncStateInvalid');
    assert.equal(existsSync(m.path), false);
  }
});

test('commit validation: 64-hex accepted; 39-char, uppercase, non-string rejected', async () => {
  const m = machine();
  const ok = await m.run((s) => s.write({ [EFFORT]: 'a'.repeat(64) }));
  assert.ok(ok._tag === 'Success');
  for (const bad of ['a'.repeat(39), 'A'.repeat(40), 7]) {
    const n = machine();
    n.write(JSON.stringify({ version: 1, held: { [EFFORT]: bad } }));
    const read = await n.run((s) => s.read);
    assert.ok(read._tag === 'Failure');
    assert.equal(read.failure._tag, 'SyncStateInvalid');
  }
});
