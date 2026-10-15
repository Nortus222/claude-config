import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireApplyLock } from './apply-lock.ts';
import { FsFailed } from './errors.ts';
import { Effect, Exit } from 'effect';
import { Fs } from './fs.ts';
import { HistoryStore, type Actor, type HistoryEvent, type MutationObserver } from './history.ts';
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
  return Number.isNaN(time) || `nortuscc-${new Date(time).toISOString().replace(/[:.]/g, '-')}` !== name ? undefined : time;
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
    if (e.kind === 'apply-finished' && typeof e.backup === 'string' && e.backup !== 'pruned') return e.backup;
  }
  return undefined;
};

export type BackupFolder = { readonly id: string; readonly createdAt: string; readonly latestReferenced: boolean };
export type BackupPrunePlan = { readonly folderIds: readonly string[]; readonly inventoryDigest: string; readonly keepId: string | null; readonly evaluatedAt: string; readonly limited: boolean };
export type BackupPruneResult = { readonly removed: readonly string[]; readonly remaining: readonly string[]; readonly failedId?: string };

export const inspectBackupFolders = (): Effect.Effect<readonly BackupFolder[], FsFailed, Fs | MachinePaths | HistoryStore> => Effect.gen(function* () {
  const paths = yield* MachinePaths, fs = yield* Fs;
  const latest = latestReferenced(yield* (yield* HistoryStore).read);
  const keep = typeof latest === 'string' && dirname(latest) === paths.backups ? basename(latest) : undefined;
  if ((yield* fs.stat(paths.backups))?.kind !== 'directory') return [];
  const root = yield* fs.realPath(paths.backups);
  if (!root) return [];
  const folders: BackupFolder[] = [];
  for (const id of (yield* fs.list(paths.backups)) ?? []) {
    const time = backupFolderTime(id);
    if (time === undefined) continue;
    const path = join(paths.backups, id);
    if ((yield* fs.stat(path))?.kind !== 'directory' || (yield* fs.realPath(path)) !== join(root, id)) continue;
    folders.push({ id, createdAt: new Date(time).toISOString(), latestReferenced: id === keep });
  }
  return folders.sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
});

export const planBackupPrune = (now: Date): Effect.Effect<BackupPrunePlan, FsFailed, Fs | MachinePaths | HistoryStore> => Effect.gen(function* () {
  const folders = yield* inspectBackupFolders();
  const paths = yield* MachinePaths, fs = yield* Fs;
  const keepId = folders.find(f => f.latestReferenced)?.id ?? null;
  const eligible = backupsToPrune(folders.map(f => f.id), now, keepId ?? undefined);
  const inventoryDigest = createHash('sha256').update(JSON.stringify({root: yield* fs.realPath(paths.backups), folders})).digest('hex');
  return { folderIds: eligible.slice(0,100), inventoryDigest, keepId, evaluatedAt: now.toISOString(), limited: eligible.length > 100 };
});

// Called under apply.lock. Retention intentionally does not back up the backups it removes.
export const executeBackupPrune = (plan: BackupPrunePlan, actor: Actor, observer: MutationObserver): Effect.Effect<BackupPruneResult, unknown, Fs | MachinePaths | HistoryStore> => Effect.gen(function* () {
  const paths = yield* MachinePaths, fs = yield* Fs, history = yield* HistoryStore;
  const fresh = yield* planBackupPrune(new Date(plan.evaluatedAt));
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) return yield* Effect.fail(new FsFailed({op:'prune',path:paths.backups,reason:'Backup inventory changed; preview again'}));
  const root = yield* fs.realPath(paths.backups);
  const removed: string[] = [];
  let failedId: string | undefined;
  const execution = yield* Effect.exit(Effect.gen(function* () {
    for (const id of plan.folderIds) {
      yield* observer.pending(id);
      const path = join(paths.backups,id);
      if (!root || (yield* fs.stat(paths.backups))?.kind !== 'directory' || (yield* fs.realPath(paths.backups)) !== root
        || (yield* fs.stat(path))?.kind !== 'directory' || (yield* fs.realPath(path)) !== join(root,id)) {failedId=id;break;}
      const removal = yield* Effect.exit(fs.remove(path));
      if (Exit.isFailure(removal) || (yield* fs.exists(path))) { failedId = id; break; }
      removed.push(id);
      yield* observer.committed(id);
    }
  }));
  const record = yield* Effect.exit(removed.length ? history.append({kind:'backups-pruned',actor,folders:removed.map(id=>join(paths.backups,id)),...(plan.limited?{limited:true}:{})}) : Effect.void);
  if (Exit.isFailure(execution)) return yield* Effect.failCause(execution.cause);
  if (Exit.isFailure(record)) return yield* Effect.failCause(record.cause);
  return {removed,remaining:plan.folderIds.filter(id=>!removed.includes(id)),...(failedId ? {failedId} : {})};
});

// Automatic cleanup joins the common fence; a busy run is retried at its next existing opportunity.
export const pruneBackups = (now: Date, actor: Actor, options?: {readonly lockHeld?: boolean}) => {
  const cleanup = Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const plan = yield* planBackupPrune(now);
    const result = yield* executeBackupPrune(plan,actor,{pending:()=>Effect.void,committed:()=>Effect.void});
    return result.removed.map(id=>join(paths.backups,id)) as readonly string[];
  });
  return options?.lockHeld ? cleanup : Effect.scoped(Effect.andThen(acquireApplyLock,cleanup)).pipe(
    Effect.catchIf(error=> typeof error === 'object' && error !== null && '_tag' in error && (error._tag === 'LockHeld' || error._tag === 'MaintenancePending'),()=>Effect.succeed([] as readonly string[])),
  );
};
