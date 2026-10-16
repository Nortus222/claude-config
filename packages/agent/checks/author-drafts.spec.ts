import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupsForRun, machinePaths, nodeFs } from '@nortuscc/machine';
import { Effect, Layer } from 'effect';
import { DraftStore, draftStore, type Draft } from '../src/author/drafts.ts';

const draft: Draft = { version: 1, id: '6e337d7a-9600-479a-959d-32cd83363942', repoUrl: 'https://github.com/example/setup', createdAt: '2026-10-16T12:00:00.000Z', intents: [{ kind: 'createProfile', profile: 'personal', extends: null }] };

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'author-drafts-'));
  const paths = machinePaths({ repo: join(root, 'repo'), claude: join(root, 'claude'), codex: join(root, 'codex'), codexOpenRouter: join(root, 'codex-router'), agentsSkills: join(root, 'skills'), stateRoot: root, backups: join(root, 'backups') });
  const base = Layer.merge(nodeFs, paths);
  const backups = backupsForRun(new Date('2026-10-16T12:00:00.000Z')).pipe(Layer.provide(base));
  const services = draftStore.pipe(Layer.provide(Layer.merge(base, backups)));
  const run = <A, E>(effect: Effect.Effect<A, E, DraftStore>) => Effect.runPromise(effect.pipe(Effect.provide(services)));
  const path = join(root, 'agent', 'author', 'drafts', `${draft.id}.json`);
  return { root, path, run };
};

test('a draft can be written, listed, read and deleted', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run(DraftStore.use(store => Effect.gen(function* () {
    assert.deepEqual(yield* store.list(), []);
    assert.equal(yield* store.read(draft.id), undefined);
    yield* store.delete(draft.id);
    yield* store.write(draft);
    assert.deepEqual(yield* store.list(), [draft]);
    assert.deepEqual(yield* store.read(draft.id), draft);
    yield* store.delete(draft.id);
    assert.deepEqual(yield* store.list(), []);
    yield* store.delete(draft.id);
  })));
  const backupFiles = await readdir(join(f.root, 'backups', 'nortuscc-2026-10-16T12-00-00-000Z', 'agent', 'author', 'drafts'));
  assert.deepEqual(backupFiles, [`${draft.id}.json`]);
});

test('replacement backs up the old draft and readers see complete atomic snapshots', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run(DraftStore.use(store => store.write(draft)));
  const replacement: Draft = { ...draft, intents: [{ kind: 'captureFile', profile: 'default', fileId: 'claude:CLAUDE.md', text: 'frozen'.repeat(20_000), choice: { kind: 'updateShared' } }] };
  await Promise.all([
    f.run(DraftStore.use(store => store.write(replacement))),
    (async () => {
      for (let i = 0; i < 20; i++) {
        const read = JSON.parse(await readFile(f.path, 'utf8'));
        assert.ok(JSON.stringify(read) === JSON.stringify(draft) || JSON.stringify(read) === JSON.stringify(replacement));
      }
    })(),
  ]);
  assert.deepEqual(await f.run(DraftStore.use(store => store.read(draft.id))), replacement);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'backups', 'nortuscc-2026-10-16T12-00-00-000Z', 'agent', 'author', 'drafts', `${draft.id}.json`), 'utf8')), draft);
});

test('a corrupt draft is listed by id and can be deleted while other drafts still list', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run(DraftStore.use(store => store.write(draft)));
  const other: Draft = { ...draft, id: '11111111-1111-4111-8111-111111111111' };
  await f.run(DraftStore.use(store => store.write(other)));
  await writeFile(f.path, JSON.stringify({ ...draft, id: '11111111-1111-4111-8111-111111111111' }));
  await assert.rejects(f.run(DraftStore.use(store => store.read(draft.id))), /identity mismatch/);
  const mismatched = await f.run(DraftStore.use(store => store.list()));
  assert.deepEqual(mismatched.find(entry => entry.id === other.id), other);
  const entry = mismatched.find(entry => entry.id === draft.id);
  assert.ok(entry && 'error' in entry);
  assert.match(String(entry.error), /identity mismatch/);
  await writeFile(f.path, '{broken');
  const listed = await f.run(DraftStore.use(store => store.list()));
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.find(entry => entry.id === other.id), other);
  const corrupt = listed.find(entry => entry.id === draft.id);
  assert.ok(corrupt && 'error' in corrupt);
  assert.equal(typeof corrupt.error, 'string');
  assert.ok(corrupt.error.length > 0);
  await f.run(DraftStore.use(store => store.delete(draft.id)));
  assert.deepEqual(await f.run(DraftStore.use(store => store.list())), [other]);
  assert.equal(await readFile(join(f.root, 'backups', 'nortuscc-2026-10-16T12-00-00-000Z', 'agent', 'author', 'drafts', `${draft.id}.json`), 'utf8'), '{broken');
});

test('draft IDs cannot escape the draft directory', async t => {
  const f = await fixture();
  t.after(() => rm(f.root, { recursive: true, force: true }));
  await f.run(DraftStore.use(store => Effect.gen(function* () {
    assert.match((yield* Effect.flip(store.read('../outside'))).message, /Invalid draft ID/);
    assert.match((yield* Effect.flip(store.delete('../outside'))).message, /Invalid draft ID/);
  })));
});
