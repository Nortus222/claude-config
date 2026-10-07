import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import {
  Fs, machinePaths, nodeFs, nodeProcesses, OverridesStore, overridesStore, parseState,
  type Decision, type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { fetchTracked, isAncestor, originUrl, revParse, upstreamOf } from './git.ts';
import { incoming, nextHolds } from './plan.ts';
import { normalizeRepoUrl, ownSetup, SetupsStore, setupsStore } from './setups.ts';
import { pruneSnapshots, snapshotFor } from './snapshots.ts';
import { LOCAL_SETUP, RevisionMismatch, RevisionUnavailable, SetupSource, type Effective, type Revision } from './source.ts';
import { SyncStore, syncStore, type Holds } from './store.ts';

type Services = Fs | Processes | OverridesStore | SyncStore | SetupsStore;

const unavailable = (revision: Revision, reason: string) => Effect.fail(new RevisionUnavailable({ revision, reason }));

// Machine sync's SetupSource over this machine's own checkout (P2). It fetches only the tracked
// remote ref from a trusted origin, verifies commits against it, and composes snapshots from git
// objects under <stateRoot>/snapshots/. It never moves the checkout or the applied commit. Git that
// cannot start is an unavailable revision; an unreadable or unparseable state file or an invalid
// sync.json is a defect, which the agent's job reports and never applies on. Nothing here writes
// outside <stateRoot>/snapshots/.
export const setupSourceLayer = (
  paths: MachinePathsValue,
  options: { readonly processes?: Layer.Layer<Processes>; readonly now?: () => Date } = {},
): Layer.Layer<SetupSource> => {
  const repo = paths.repo;
  const now = options.now ?? (() => new Date());

  // The tracked branch, once this checkout is trusted, origin's URL is its repoUrl and the branch
  // tracks origin. Every call checks it afresh, so a remote ref filled from anywhere else is never read.
  const trustedOrigin = (revision: Revision) =>
    Effect.gen(function* () {
      const own = ownSetup(yield* (yield* SetupsStore).read, repo);
      const trusted = own?.repoUrl ?? null;
      const url = yield* originUrl(repo);
      const actual = url === undefined ? null : normalizeRepoUrl(url);
      if (trusted === null || actual !== trusted) {
        return yield* unavailable(revision, `origin (${actual ?? 'none'}) is not the trusted repository (${trusted ?? 'none'})`);
      }
      const upstream = yield* upstreamOf(repo);
      if (upstream === undefined) return yield* unavailable(revision, 'the checkout tracks no branch');
      if (upstream.remote !== 'origin') return yield* unavailable(revision, `the checkout tracks ${upstream.remote}, not origin`);
      return upstream;
    });

  // The applied commit state.json records, read without StateStore (whose read can migrate a legacy
  // lock, a write). undefined when none is recorded; a state file that will not parse is a defect.
  const recordedApplied = Effect.gen(function* () {
    const path = join(paths.stateRoot, 'state.json');
    const text = yield* (yield* Fs).readText(path);
    if (text === undefined) return undefined;
    const state = parseState(text);
    if (state === undefined) return yield* Effect.die(new Error(`${path} cannot be parsed`));
    return state.applied?.commit;
  });

  const snapshot = (commit: string, held: Holds) =>
    Effect.gen(function* () {
      const overrides = yield* (yield* OverridesStore).read;
      return yield* snapshotFor({ repo, stateRoot: paths.stateRoot, commit, held, overrides, now: now() });
    });

  const fetch = Effect.gen(function* () {
    const upstream = yield* trustedOrigin('HEAD');
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
      if (typeof revision !== 'string') return yield* Effect.fail(new RevisionMismatch({ revision, reason: 'hosted records require the hosted source' }));
      const commit = yield* revParse(repo, revision);
      if (commit === undefined) return yield* unavailable(revision, 'no such commit in the checkout');
      const upstream = yield* trustedOrigin(revision);
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
      const upstream = yield* trustedOrigin('HEAD');
      const head = yield* revParse(repo, upstream.ref);
      if (head === undefined) return yield* unavailable(upstream.ref, 'the tracked branch has not been fetched');
      const recorded = yield* recordedApplied;
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
      yield* pruneSnapshots(paths.stateRoot, [appliedSnapshot.repo, effectiveSnapshot.repo], now());
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

  const current = Effect.gen(function* () {
    const head = yield* revParse(repo, 'HEAD');
    if (head === undefined) return yield* unavailable('HEAD', 'the checkout has no commit');
    const result = yield* snapshot(head, yield* (yield* SyncStore).read);
    yield* pruneSnapshots(paths.stateRoot, [result.repo], now());
    return result;
  }).pipe(
    Effect.catchTag('LaunchFailed', (e) => unavailable('HEAD', e.message)),
    Effect.catchTag('FsFailed', (e) => Effect.die(e)),
    Effect.catchTag('ReadFailed', (e) => Effect.die(e)),
    Effect.catchTag('SyncStateInvalid', (e) => Effect.die(e)),
  );

  const services = Layer.mergeAll(overridesStore, syncStore, setupsStore).pipe(
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
        current: provide(current),
      };
    }),
  ).pipe(Layer.provide(services));
};
