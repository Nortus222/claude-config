import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Effect } from 'effect';
import { loadProfile, nodeFiles, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import { canonical, Fs, type FsFailed } from '@nortuscc/machine';
import { composeDocuments } from './compose.ts';
import { writeDocuments } from './documents.ts';
import type { Snapshot } from './source.ts';
import type { Holds } from './store.ts';

export const SNAPSHOTS_KEPT = 5;
const MARKER = '.snapshot.json';
const STAGING = '.staging-';
// A staging folder snapshotFor names: .staging-<key>-<createdAtMs>-<uuid>.
const DATED_STAGING = /^\.staging-[0-9a-f]{32}-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// How old a staging folder must be before pruning takes it for a crashed run's, not one in flight.
export const STALE_STAGING_MS = 60 * 60 * 1000;
// A folder snapshotFor names: the first 32 hex digits of its key's sha256.
const KEY = /^[0-9a-f]{32}$/;

// Bumped whenever composition changes what a snapshot folder holds, so a new format never reuses
// folders an older one wrote.
export const SNAPSHOT_FORMAT = 1;

const snapshotsDir = (stateRoot: string) => join(stateRoot, 'snapshots');

// The folder name of a commit with holds: the first 32 hex digits of a sha256 over the format,
// the commit and the holds.
export const snapshotKey = (input: { readonly commit: string; readonly held: Holds }, format: number = SNAPSHOT_FORMAT): string =>
  createHash('sha256').update(canonical({ format, commit: input.commit, held: input.held })).digest('hex').slice(0, 32);

// A commit with holds, composed from git objects only into <stateRoot>/snapshots/<key>/ (ADR 0016)
// and resolved with `overrides`. Keyed by (format, commit, holds) and reused; a fresh one is staged in
// a folder named for its key, `now` and a uuid, and moved into place whole, so a reader never sees half
// a snapshot.
export const snapshotFor = (input: {
  readonly repo: string;
  readonly stateRoot: string;
  readonly commit: string;
  readonly held: Holds;
  readonly overrides: Input<MachineOverrides>;
  readonly now: Date;
}) =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const root = snapshotsDir(input.stateRoot);
    const key = snapshotKey(input);
    const dir = join(root, key);
    const marker = JSON.stringify({ commit: input.commit, held: input.held, usedAt: input.now.toISOString() }, null, 2) + '\n';
    if ((yield* fs.readText(join(dir, MARKER))) === undefined) {
      const staging = join(root, `${STAGING}${key}-${input.now.getTime()}-${randomUUID()}`);
      yield* writeDocuments(staging, yield* composeDocuments({ repo: input.repo, head: { kind: 'commit', commit: input.commit }, held: input.held }));
      yield* fs.writeTextAtomic(join(staging, MARKER), marker);
      yield* fs.remove(dir);
      yield* fs.move(staging, dir);
    } else {
      yield* fs.writeTextAtomic(join(dir, MARKER), marker);
    }
    const snapshot: Snapshot = { desired: yield* loadProfile(dir, { overrides: input.overrides }).pipe(Effect.provide(nodeFiles)), repo: dir };
    return snapshot;
  });

// Keeps the SNAPSHOTS_KEPT most recently used snapshot folders and every folder in `keep`; removes
// the rest and any staging folder created more than STALE_STAGING_MS before `now`, which a crashed run
// left behind. A younger staging folder may be another job's in flight and is kept. Entries
// snapshotFor did not name, including staging folders without a creation time, are never touched.
export const pruneSnapshots = (stateRoot: string, keep: ReadonlyArray<string>, now: Date): Effect.Effect<void, FsFailed, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    const root = snapshotsDir(stateRoot);
    const used: Array<{ readonly name: string; readonly usedAt: string }> = [];
    for (const name of (yield* fs.list(root)) ?? []) {
      if (name.startsWith(STAGING)) {
        const created = DATED_STAGING.exec(name)?.[1];
        if (created !== undefined && Number(created) < now.getTime() - STALE_STAGING_MS) yield* fs.remove(join(root, name));
        continue;
      }
      if (!KEY.test(name)) continue;
      let usedAt = '';
      try {
        const value: unknown = JSON.parse((yield* fs.readText(join(root, name, MARKER))) ?? '{}');
        if (typeof value === 'object' && value !== null && typeof (value as { usedAt?: unknown }).usedAt === 'string') {
          usedAt = (value as { usedAt: string }).usedAt;
        }
      } catch {
        usedAt = '';
      }
      used.push({ name, usedAt });
    }
    used.sort((a, b) => (a.usedAt < b.usedAt ? 1 : a.usedAt > b.usedAt ? -1 : 0));
    const kept = new Set(keep.map((dir) => basename(dir)));
    for (const { name } of used.slice(SNAPSHOTS_KEPT)) if (!kept.has(name)) yield* fs.remove(join(root, name));
  });
