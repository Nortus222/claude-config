import { Effect, Layer } from 'effect';
import {
  machinePaths, nodeFs, nodeProcesses, OverridesStore, overridesStore, StateStore, stateStore,
  type Decision, type Fs, type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { fetchTracked, isAncestor, originUrl, revParse, upstreamOf } from './git.ts';
import { incoming, nextHolds } from './plan.ts';
import { normalizeRepoUrl, SetupsStore, setupsStore } from './setups.ts';
import { pruneSnapshots, snapshotFor } from './snapshots.ts';
import { LOCAL_SETUP, RevisionMismatch, RevisionUnavailable, SetupSource, type Effective, type Revision } from './source.ts';
import { SyncStore, syncStore, type Holds } from './store.ts';

type Services = Fs | Processes | StateStore | OverridesStore | SyncStore | SetupsStore;

const unavailable = (revision: Revision, reason: string) => Effect.fail(new RevisionUnavailable({ revision, reason }));

// Machine sync's SetupSource over this machine's own checkout (P2). It fetches only the tracked
// remote ref from a trusted origin, verifies commits against it, and composes snapshots from git
// objects under <stateRoot>/snapshots/. It never moves the checkout or the applied commit. Git that
// cannot start is an unavailable revision; an unreadable state file or an invalid sync.json is a
// defect, which the agent's job reports and never applies on.
export const setupSourceLayer = (
  paths: MachinePathsValue,
  options: { readonly processes?: Layer.Layer<Processes>; readonly now?: () => Date } = {},
): Layer.Layer<SetupSource> => {
  const repo = paths.repo;
  const now = options.now ?? (() => new Date());

  // The tracked branch, which must be on origin: the remote whose URL is trusted.
  const tracked = (revision: Revision) =>
    Effect.flatMap(upstreamOf(repo), (upstream) =>
      upstream === undefined
        ? unavailable(revision, 'the checkout tracks no branch')
        : upstream.remote !== 'origin'
          ? unavailable(revision, `the checkout tracks ${upstream.remote}, not origin`)
          : Effect.succeed(upstream));

  const snapshot = (commit: string, held: Holds) =>
    Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      return yield* snapshotFor({ repo, stateRoot: paths.stateRoot, commit, held, overrides, now: now() });
    });

  const fetch = Effect.gen(function* () {
    const own = ((yield* (yield* SetupsStore).read) ?? []).find((s) => s.setupId === null);
    const trusted = own?.repoUrl ?? null;
    const url = yield* originUrl(repo);
    const actual = url === undefined ? null : normalizeRepoUrl(url);
    if (trusted === null || actual !== trusted) {
      return yield* unavailable('HEAD', `origin (${actual ?? 'none'}) is not the trusted repository (${trusted ?? 'none'})`);
    }
    const upstream = yield* tracked('HEAD');
    if (!(yield* fetchTracked(repo, upstream))) return yield* unavailable('HEAD', `git fetch of ${upstream.remote}/${upstream.branch} failed`);
    const head = yield* revParse(repo, upstream.ref);
    if (head === undefined) return yield* unavailable('HEAD', `${upstream.ref} is missing after the fetch`);
    return { head };
  }).pipe(
    Effect.catchTag('LaunchFailed', (e) => unavailable('HEAD', e.message)),
    Effect.catchTag('FsFailed', (e) => Effect.die(e)),
  );

  const load = (revision: Revision) =>
    Effect.gen(function* () {
      const commit = yield* revParse(repo, revision);
      if (commit === undefined) return yield* unavailable(revision, 'no such commit in the checkout');
      const upstream = yield* tracked(revision);
      const onBranch = yield* isAncestor(repo, commit, upstream.ref);
      if (onBranch === false) {
        return yield* Effect.fail(new RevisionMismatch({ revision, reason: `not reachable from ${upstream.remote}/${upstream.branch}` }));
      }
      if (onBranch === undefined) return yield* unavailable(revision, `${upstream.ref} could not be compared`);
      return yield* snapshot(commit, {});
    }).pipe(
      Effect.catchTag('LaunchFailed', (e) => unavailable(revision, e.message)),
      Effect.catchTag('FsFailed', (e) => Effect.die(e)),
      Effect.catchTag('ReadFailed', (e) => Effect.die(e)),
    );

  const effective = (decisions: ReadonlyArray<Decision>) =>
    Effect.gen(function* () {
      const upstream = yield* tracked('HEAD');
      const head = yield* revParse(repo, upstream.ref);
      if (head === undefined) return yield* unavailable(upstream.ref, 'the tracked branch has not been fetched');
      const recorded = (yield* (yield* StateStore).read).applied?.commit;
      const applied = (recorded === undefined ? undefined : yield* revParse(repo, recorded)) ?? (yield* revParse(repo, 'HEAD'));
      if (applied === undefined) return yield* unavailable('HEAD', 'the checkout has no commit');
      const holds = yield* (yield* SyncStore).read;
      const overrides = yield* (yield* OverridesStore).read;
      const { changes, conflicts } = yield* incoming({ repo, applied, head, holds, overrides: overrides.value });
      const accepted = new Set(decisions
        .filter((d) => d.setupId === LOCAL_SETUP && d.commit === head && d.decision === 'accept')
        .map((d) => d.itemId));
      const appliedSnapshot = yield* snapshot(applied, holds);
      const effectiveSnapshot = yield* snapshot(head, nextHolds({ holds, changes, accepted, applied }));
      yield* pruneSnapshots(paths.stateRoot, [appliedSnapshot.repo, effectiveSnapshot.repo]);
      const result: Effective = {
        applied: { ...appliedSnapshot, revision: applied },
        effective: effectiveSnapshot,
        conflicts: conflicts.filter((c) => accepted.has(c.itemId)).map((c) => c.itemId),
      };
      return result;
    }).pipe(
      Effect.catchTag('LaunchFailed', (e) => unavailable('HEAD', e.message)),
      Effect.catchTag('FsFailed', (e) => Effect.die(e)),
      Effect.catchTag('ReadFailed', (e) => Effect.die(e)),
      Effect.catchTag('SyncStateInvalid', (e) => Effect.die(e)),
    );

  const services = Layer.mergeAll(stateStore, overridesStore, syncStore, setupsStore).pipe(
    Layer.provideMerge(Layer.mergeAll(machinePaths(paths), nodeFs, options.processes ?? nodeProcesses({ inherit: 'stderr' }))),
  );
  return Layer.effect(
    SetupSource,
    Effect.gen(function* () {
      const context = yield* Effect.context<Services>();
      const provide = <A, E>(effect: Effect.Effect<A, E, Services>) => Effect.provideContext(effect, context);
      return {
        fetch: provide(fetch),
        load: (revision: Revision) => provide(load(revision)),
        effective: (decisions: ReadonlyArray<Decision>) => provide(effective(decisions)),
      };
    }),
  ).pipe(Layer.provide(services));
};
