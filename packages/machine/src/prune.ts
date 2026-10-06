import { basename, dirname, join } from 'node:path';
import { Effect, Exit } from 'effect';
import { Fs } from './fs.ts';
import { HistoryStore, type Actor, type HistoryEvent } from './history.ts';
import { MachinePaths } from './paths.ts';

export const PRUNE_AFTER_DAYS = 90;
export const KEEP_NEWEST = 20;
const DAY_MS = 86_400_000;
const FOLDER = /^nortuscc-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

// When a run's backup folder was made, from the name backupsForRun gives it; undefined for any other name.
export const backupFolderTime = (name: string): number | undefined => {
  const m = FOLDER.exec(name);
  if (!m) return undefined;
  const time = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(time) ? undefined : time;
};

// Folders both older than 90 days and outside the newest 20, never `keep`, newest first. Names
// backupsForRun did not make are never chosen.
export const backupsToPrune = (names: ReadonlyArray<string>, now: Date, keep?: string): string[] =>
  names
    .flatMap((name) => {
      const time = backupFolderTime(name);
      return time === undefined ? [] : [{ name, time }];
    })
    .sort((a, b) => b.time - a.time)
    .slice(KEEP_NEWEST)
    .filter(({ name, time }) => now.getTime() - time > PRUNE_AFTER_DAYS * DAY_MS && name !== keep)
    .map(({ name }) => name);

const latestReferenced = (events: ReadonlyArray<HistoryEvent>): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'apply-finished' && e.backup !== null && e.backup !== 'pruned') return e.backup;
  }
  return undefined;
};

// Removes old run folders under MachinePaths.backups and names each one removed in a
// `backups-pruned` event. Deleting a backup is the retention policy itself, so nothing backs it up.
export const pruneBackups = (now: Date, actor: Actor) =>
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const history = yield* HistoryStore;
    const latest = latestReferenced(yield* history.read);
    const keep = latest !== undefined && dirname(latest) === paths.backups ? basename(latest) : undefined;
    const removed: string[] = [];
    for (const name of backupsToPrune((yield* fs.list(paths.backups)) ?? [], now, keep)) {
      const path = join(paths.backups, name);
      // Stop at the first failure; what was removed is still recorded.
      if (Exit.isFailure(yield* Effect.exit(fs.remove(path)))) break;
      removed.push(path);
    }
    if (removed.length > 0) yield* history.append({ kind: 'backups-pruned', actor, folders: removed });
    return removed as ReadonlyArray<string>;
  });
