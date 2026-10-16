import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Effect, Layer, Semaphore } from 'effect';
import {
  Fs, machinePaths, nodeFs, nodeProcesses, OverridesStore, overridesStore, parseState, Processes,
  type Decision, type MachinePathsValue,
} from '@nortuscc/machine';
import type { Input, MachineOverrides } from '@nortuscc/profile-engine';
import type { SyncRevision } from '@nortuscc/hosted-protocol';
import { composeDocuments, desiredFor } from './compose.ts';
import { commitDocuments, commitDocumentsCache, isAncestor, revParse, type CommitDocumentsCache } from './git.ts';
import { followedClone, followedGit, privateFollowedRepository, fetchFollowedMain, FOLLOWED_MAIN } from './followed-repository.ts';
import type { FollowedProfile } from './followed.ts';
import { hostedSetupSourceLayer } from './hosted-source.ts';
import { desiredOfDocuments, hasProfile, worktreeDocuments, type Documents } from './documents.ts';
import { composeSetupChoices } from './setup-choices.ts';
import { pruneSnapshots, snapshotFromDocuments } from './snapshots.ts';
import { droppedOnSwitch, retainedOverrides } from './resolved-items.ts';
import { incoming, nextHolds } from './plan.ts';
import { LOCAL_SETUP, RevisionMismatch, RevisionUnavailable, SetupSource, type Revision } from './source.ts';
import { SyncStore, syncStore, type Holds } from './store.ts';

export { followedClone } from './followed-repository.ts';

const unavailable = (revision: Revision, reason: string) => Effect.fail(new RevisionUnavailable({ revision, reason }));

// Holds use a private empty profile commit without recording an upstream apply.
const emptyProfileRef = (profile: string) => `refs/nortuscc/empty/${profile}`;
const EMPTY_BASELINE_REF = 'refs/nortuscc/baseline/empty';
const emptyProfileOrigin = (paths: MachinePathsValue, followed: FollowedProfile) => Effect.gen(function* () {
  const repo = followedClone(paths, followed.repoUrl);
  const emptyRef = emptyProfileRef(followed.profile);
  const existing = yield* revParse(repo, emptyRef);
  if (existing) return existing;
  const write = (args: readonly string[], input: string) => Processes.use(p => p.run({
    cmd: 'git', cwd: repo, args, input, output: 'capture', stderr: 'capture',
  })).pipe(Effect.flatMap(result => result.code === 0 ? Effect.succeed(result.stdout.trim()) : unavailable('HEAD', 'empty profile origin could not be created')));
  const blob = yield* write(['hash-object', '-t', 'blob', '-w', '--stdin'], '{}\n');
  const profiles = yield* write(['mktree'], `100644 blob ${blob}\t${followed.profile}.json\n`);
  const tree = yield* write(['mktree'], `040000 tree ${profiles}\tprofiles\n`);
  const commit = yield* write(['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor nortuscc <nortuscc@localhost> 0 +0000\ncommitter nortuscc <nortuscc@localhost> 0 +0000\n\nEmpty profile origin\n`);
  if ((yield* followedGit(paths, repo, ['update-ref', emptyRef, commit])).code !== 0) return yield* unavailable('HEAD', 'empty profile origin could not be retained');
  return commit;
});

// Mark only the destination clone, before clearing state or saving its followed selection.
export const markFollowedBaselineEmpty = (paths: MachinePathsValue, followed: FollowedProfile) => Effect.gen(function* () {
  const commit = yield* emptyProfileOrigin(paths, followed);
  if ((yield* followedGit(paths, followedClone(paths, followed.repoUrl), ['update-ref', EMPTY_BASELINE_REF, commit])).code !== 0) {
    return yield* unavailable('HEAD', 'empty applied baseline could not be retained');
  }
});

export const followedSetupSourceLayer = (paths: MachinePathsValue, followed: FollowedProfile, options: {
  readonly processes?: Layer.Layer<Processes>;
  readonly records?: Effect.Effect<ReadonlyArray<SyncRevision>, unknown>;
  readonly now?: () => Date;
} = {}): Layer.Layer<SetupSource> => {
  if (followed.setupId !== null) return hostedSetupSourceLayer(paths, {
    accountId: 'followed', currentAccountId: Effect.succeed('followed'), setupId: followed.setupId, repoUrl: followed.repoUrl,
    records: options.records ?? unavailable('HEAD', 'hosted metadata is unavailable'),
    followed, profile: followed.profile, processes: options.processes, now: options.now,
  });
  type Services = Fs | Processes | OverridesStore | SyncStore | CommitDocumentsCache;
  const repo = followedClone(paths, followed.repoUrl);
  const repository = privateFollowedRepository(paths, followed);
  const emptyRef = emptyProfileRef(followed.profile);
  const recorded = Effect.gen(function* () {
    const text = yield* (yield* Fs).readText(join(paths.stateRoot, 'state.json'));
    const state = text === undefined ? undefined : parseState(text);
    if (text !== undefined && state === undefined) return yield* unavailable('HEAD', 'applied state is invalid');
    if (state?.applied) return state.applied.commit;
    if (yield* revParse(repo, EMPTY_BASELINE_REF)) return yield* emptyProfileOrigin(paths, followed);
    return yield* revParse(repo, 'refs/nortuscc/migration/applied');
  });
  // A historical absence owns no items. Keep unmatched overrides on disk until their items are taken.
  const historicalSnapshot = (documents: Documents, overrides: Input<MachineOverrides>) => {
    const dropped = droppedOnSwitch({ holds: {}, overrides: overrides.value, to: desiredOfDocuments(documents, undefined, followed.profile) });
    return snapshotFromDocuments({ documents, repoUrl: followed.repoUrl, profile: followed.profile, stateRoot: paths.stateRoot,
      overrides: { ...overrides, value: retainedOverrides(overrides.value, dropped.overrides) }, now: options.now?.() ?? new Date() });
  };
  const snapshot = (commit: string, held: Holds, choices?: Parameters<SetupSource['Service']['effective']>[1], historical = false) => Effect.gen(function* () {
    const overrides = choices?.overrides ?? (yield* (yield* OverridesStore).read);
    const documents = yield* commitDocuments(repo, commit);
    if (historical && !hasProfile(documents, followed.profile)) return yield* historicalSnapshot({ [`profiles/${followed.profile}.json`]: '{}' }, overrides);
    const empty = yield* revParse(repo, emptyRef);
    if (empty && (commit === empty || Object.values(held).includes(empty))) return yield* historicalSnapshot(
      yield* composeDocuments({ repo, head: { kind: 'commit', commit }, held, profile: followed.profile }), overrides);
    const snapshot = yield* desiredFor({ repo, profile: followed.profile, head: { kind: 'commit', commit }, held, overrides,
      into: join(paths.stateRoot, 'snapshots', createHash('sha256').update(JSON.stringify([followed, commit, held])).digest('hex').slice(0, 32)) });
    yield* (yield* Fs).writeTextAtomic(join(snapshot.repo, '.snapshot.json'), JSON.stringify({ usedAt: (options.now?.() ?? new Date()).toISOString() }) + '\n');
    return snapshot;
  });
  const head = Effect.gen(function* () {
    yield* repository;
    const commit = yield* revParse(repo, FOLLOWED_MAIN);
    return commit ?? (yield* unavailable('HEAD', 'main has not been fetched'));
  });
  const fetch = Effect.gen(function* () {
    yield* repository;
    if (!(yield* fetchFollowedMain(paths, repo, followed.repoUrl))) return yield* unavailable('HEAD', 'private clone fetch failed');
    return { head: yield* head };
  });
  const load = (revision: Revision) => Effect.gen(function* () {
    if (typeof revision !== 'string') return yield* Effect.fail(new RevisionMismatch({ revision, reason: 'this profile follows Git directly' }));
    const main = yield* head;
    const commit = yield* revParse(repo, revision);
    if (commit === undefined) return yield* unavailable(revision, 'commit is not in the private clone');
    if (commit !== (yield* revParse(repo, emptyRef)) && !(yield* isAncestor(repo, commit, main))) return yield* Effect.fail(new RevisionMismatch({ revision, reason: 'commit is not reachable from fetched main' }));
    return yield* snapshot(commit, {}, undefined, commit !== main);
  });
  const effective = (decisions: readonly Decision[], choices?: Parameters<SetupSource['Service']['effective']>[1]) => Effect.gen(function* () {
    const currentHead = yield* head;
    const applied = (yield* recorded) ?? currentHead;
    const holds = choices?.holds ?? (yield* (yield* SyncStore).read);
    const overrides = choices?.overrides ?? (yield* (yield* OverridesStore).read);
    const comparison = { repo, profile: followed.profile, applied, head: currentHead, holds, overrides: overrides.value };
    const { changes, conflicts } = yield* incoming(comparison);
    const accepted = new Set(decisions.filter(d => d.setupId === LOCAL_SETUP && d.commit === currentHead && d.decision === 'accept').map(d => d.itemId));
    const appliedSnapshot = yield* snapshot(applied, holds, choices, applied !== currentHead);
    const appliedDocuments = yield* commitDocuments(repo, applied);
    const effectiveSnapshot = hasProfile(appliedDocuments, followed.profile)
      ? yield* snapshot(currentHead, nextHolds({ holds, changes, accepted, applied }), choices)
      : yield* historicalSnapshot(composeSetupChoices({ current: yield* worktreeDocuments(appliedSnapshot.repo), offered: yield* commitDocuments(repo, currentHead), accepted: [...accepted], holds, profile: followed.profile }), overrides);
    yield* pruneSnapshots(paths.stateRoot, [appliedSnapshot.repo, effectiveSnapshot.repo], options.now?.() ?? new Date());
    return { applied: { ...appliedSnapshot, revision: applied },
      effective: effectiveSnapshot,
      conflicts: conflicts.filter(c => accepted.has(c.itemId)).map(c => c.itemId) };
  });
  const current = Effect.gen(function* () {
    const commit = (yield* recorded) ?? (yield* head);
    const result = yield* snapshot(commit, yield* (yield* SyncStore).read, undefined, commit !== (yield* head));
    yield* pruneSnapshots(paths.stateRoot, [result.repo], options.now?.() ?? new Date());
    return result;
  });
  const services = Layer.mergeAll(overridesStore, syncStore, commitDocumentsCache).pipe(Layer.provideMerge(
    Layer.mergeAll(machinePaths(paths), nodeFs, options.processes ?? nodeProcesses({ inherit: 'stderr' })),
  ));
  return Layer.effect(SetupSource, Effect.gen(function* () {
    const context = yield* Effect.context<Services>();
    const lock = yield* Semaphore.make(1);
    const provide = <A>(effect: Effect.Effect<A, unknown, Services>) => effect.pipe(Effect.provideContext(context), lock.withPermit,
      Effect.mapError(error => error instanceof RevisionMismatch || error instanceof RevisionUnavailable ? error : new RevisionUnavailable({ revision: 'HEAD', reason: String(error) })));
    return { profile: followed.profile, trusted: Effect.succeed(true), fetch: provide(fetch).pipe(Effect.catchTag('RevisionMismatch', e => unavailable('HEAD', e.reason))),
      load: (r: Revision) => provide(load(r)), effective: (d: readonly Decision[], c?: Parameters<SetupSource['Service']['effective']>[1]) => provide(effective(d, c)),
      current: provide(current).pipe(Effect.catchTag('RevisionMismatch', e => unavailable('HEAD', e.reason))) };
  })).pipe(Layer.provide(services));
};
