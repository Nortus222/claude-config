import { join } from 'node:path';
import { Context, Effect, Layer, Schema } from 'effect';
import { Backups, backupsForRun, Fs, FsFailed, MachinePaths, machinePaths, parseState, type MachinePathsValue } from '@nortuscc/machine';
import { ProfileNameSchema } from '@nortuscc/hosted-protocol';
import { followedGit, privateFollowedRepository } from './followed-repository.ts';
import { decodeSyncState } from './store.ts';
import { RevisionUnavailable } from './source.ts';
import { originUrl, revParse } from './git.ts';
import { normalizeRepoUrl, ownSetup, SetupsStore } from './setups.ts';

export type FollowedProfile = { readonly repoUrl: string; readonly profile: string; readonly setupId: string | null };
const document = Schema.Struct({ version: Schema.Literal(1), followed: Schema.Struct({
  repoUrl: Schema.String, profile: ProfileNameSchema, setupId: Schema.NullOr(Schema.String),
}) });

export class FollowedStore extends Context.Service<FollowedStore, {
  readonly read: Effect.Effect<FollowedProfile | undefined, FsFailed>;
  readonly write: (next: FollowedProfile) => Effect.Effect<void, FsFailed>;
}>()('sync/FollowedStore') {}

// The single machine selection. Malformed data never becomes permission to migrate again.
export const followedStore = Layer.effect(FollowedStore, Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const relative = join('agent', 'followed.json');
  const path = join(paths.stateRoot, relative);
  return {
    read: Effect.flatMap(fs.readText(path), text => text === undefined ? Effect.succeed(undefined) : Effect.try({
      try: () => Schema.decodeUnknownSync(document)(JSON.parse(text)).followed,
      catch: () => new FsFailed({ op: 'read followed profile', path, reason: 'invalid followed profile' }),
    })),
    write: (followed: FollowedProfile) => Effect.gen(function* () {
      yield* Backups.use(b => b.preserve(path, relative, undefined, { private: true })).pipe(
        Effect.provide(backupsForRun().pipe(Layer.provideMerge(Layer.mergeAll(machinePaths(paths), Layer.succeed(Fs, fs))))),
      );
      yield* fs.writeTextAtomic(path, JSON.stringify({ version: 1, followed }, null, 2) + '\n');
    }),
  };
}));

// Only the existing consent for this checkout and its current origin can seed a selection.
export const migrateFollowed = (paths: MachinePathsValue) => Effect.gen(function* () {
  const store = yield* FollowedStore;
  const existing = yield* store.read;
  if (existing !== undefined) return existing;
  const own = ownSetup(yield* (yield* SetupsStore).read, paths.repo);
  if (own?.repoUrl == null) return undefined;
  const trusted = normalizeRepoUrl(own.repoUrl);
  if (trusted === null) return undefined;
  const repoUrl = yield* originUrl(paths.repo);
  if (repoUrl === undefined || normalizeRepoUrl(repoUrl) !== trusted) return undefined;
  const followed: FollowedProfile = { repoUrl, profile: 'default', setupId: own.setupId };
  const fs = yield* Fs;
  const stateText = yield* fs.readText(join(paths.stateRoot, 'state.json'));
  const state = stateText === undefined ? undefined : parseState(stateText);
  if (stateText !== undefined && state === undefined) return yield* Effect.fail(new FsFailed({ op: 'migrate followed profile', path: paths.stateRoot, reason: 'applied state is invalid' }));
  const applied = state?.applied?.commit ?? (yield* revParse(paths.repo, 'HEAD'));
  const holdsPath = join(paths.stateRoot, 'sync.json');
  const holds = yield* decodeSyncState(yield* fs.readText(holdsPath), holdsPath);
  const clone = yield* privateFollowedRepository(paths, followed, { proveAccess: false });
  for (const commit of new Set([...(applied ? [applied] : []), ...Object.values(holds)])) {
    const result = yield* followedGit(paths, clone, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', paths.repo, `${commit}:refs/nortuscc/migration/${commit}`]);
    if (result.code !== 0) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: 'cannot preserve applied or held Git objects' }));
  }
  if (applied !== undefined && (yield* followedGit(paths, clone, ['update-ref', 'refs/nortuscc/migration/applied', applied])).code !== 0) {
    return yield* Effect.fail(new RevisionUnavailable({ revision: applied, reason: 'cannot preserve applied Git reference' }));
  }
  yield* store.write(followed);
  return followed;
}).pipe(Effect.provide(followedStore.pipe(Layer.provide(machinePaths(paths)))));
