import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  backupFolderTime, backupsToPrune, HistoryStore, historyStore, machinePaths, nodeFs, pruneBackups,
  type Fs, type MachinePaths,
} from '../src/index.ts';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
// The name backupsForRun gives a run's folder.
const folderAt = (date: Date) => `nortuscc-${date.toISOString().replace(/[:.]/g, '-')}`;

test('backupFolderTime reads only the names backupsForRun makes', () => {
  assert.equal(backupFolderTime(folderAt(NOW)), NOW.getTime());
  assert.equal(backupFolderTime('nortuscc-not-a-date'), undefined);
  assert.equal(backupFolderTime('.DS_Store'), undefined);
});

test('only folders older than 90 days and outside the newest 20 are chosen', () => {
  const old = Array.from({ length: 25 }, (_, i) => folderAt(daysAgo(100 + i)));
  assert.deepEqual(backupsToPrune(old, NOW), old.slice(20));
  const recent = Array.from({ length: 25 }, (_, i) => folderAt(daysAgo(i)));
  assert.deepEqual(backupsToPrune(recent, NOW), []);
  const mixed = [...Array.from({ length: 20 }, (_, i) => folderAt(daysAgo(i))), ...[50, 60, 95, 100, 200].map((d) => folderAt(daysAgo(d)))];
  assert.deepEqual(backupsToPrune(mixed, NOW), [95, 100, 200].map((d) => folderAt(daysAgo(d))));
});

test('the kept folder and names backupsForRun did not make are never chosen', () => {
  const names = [...Array.from({ length: 21 }, (_, i) => folderAt(daysAgo(100 + i))), 'manual-copy'];
  assert.deepEqual(backupsToPrune(names, NOW, names[20]), []);
});

const machine = () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-prune-'));
  const stateRoot = join(root, 'state');
  const paths = {
    repo: root, claude: root, codex: root, codexOpenRouter: root, agentsSkills: root, stateRoot, backups: join(stateRoot, 'backups'),
  };
  const layer = historyStore().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs)));
  const run = <A, E>(effect: Effect.Effect<A, E, HistoryStore | MachinePaths | Fs>) => Effect.runPromise(effect.pipe(Effect.provide(layer)));
  return { paths, run };
};

const finished = (backup: string) => ({ kind: 'apply-finished', actor: 'agent', runId: backup, steps: [], backup, result: 'done' } as const);

test('pruneBackups removes old folders, keeps the latest one History references, and records what it removed', async () => {
  const { paths, run } = machine();
  const names = Array.from({ length: 22 }, (_, i) => folderAt(daysAgo(100 + i)));
  for (const name of names) mkdirSync(join(paths.backups, name), { recursive: true });
  // The oldest run first, then the run whose folder is History's latest reference.
  await run(HistoryStore.use((h) => Effect.andThen(
    h.append(finished(join(paths.backups, names[21]!))),
    h.append(finished(join(paths.backups, names[20]!))),
  )));

  const removed = await run(pruneBackups(NOW, 'agent'));

  assert.deepEqual(removed, [join(paths.backups, names[21]!)]);
  assert.deepEqual(readdirSync(paths.backups).sort(), names.slice(0, 21).sort());
  const [older, latest, pruned] = await run(HistoryStore.use((h) => h.read));
  assert.ok(pruned?.kind === 'backups-pruned');
  assert.deepEqual(pruned.folders, removed);
  assert.ok(older?.kind === 'apply-finished' && latest?.kind === 'apply-finished');
  assert.equal(older.backup, 'pruned');
  assert.equal(latest.backup, join(paths.backups, names[20]!));
});

test('pruneBackups with nothing to remove records nothing', async () => {
  const { paths, run } = machine();
  mkdirSync(join(paths.backups, folderAt(daysAgo(200))), { recursive: true });
  assert.deepEqual(await run(pruneBackups(NOW, 'agent')), []);
  assert.deepEqual(await run(HistoryStore.use((h) => h.read)), []);
});
