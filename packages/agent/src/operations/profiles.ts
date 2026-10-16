import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Effect } from 'effect';
import { authorDigest, Backups, backupsForRun, canonical, Fs, MachinePaths, OverridesStore, StateStore } from '@nortuscc/machine';
import { listProfiles, memoryFiles, requireValid } from '@nortuscc/profile-engine';
import { composeDocumentsWithStaleHolds, desiredOfDocuments, droppedOnSwitch, retainedOverrides, markFollowedBaselineEmpty, FollowedStore, followedClone, normalizeRepoUrl, hostedBaselineRelative, proveReadAccess, SyncStore, worktreeDocuments, commitDocuments, type FollowedProfile } from '@nortuscc/sync';
import { privateFollowedRepository, fetchFollowedMain, FOLLOWED_MAIN } from '@nortuscc/sync';
import { revParse } from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import { SessionError } from '../ipc/session.ts';
import type { AgentServices } from '../layer.ts';
import { decodeOperationOutput, type OperationChange, type OperationInput, type OperationOutput, type OperationPlan } from './index.ts';
import { parityObserver, type PreparedParityChange } from './parity.ts';

const PROFILE_TIMEOUT = '60 seconds';
const PROFILE_RESULT_BYTES = 65_536;
const digest = (value: unknown) => authorDigest(canonical(value))!;
const unavailable = () => new SessionError('APP_UNAVAILABLE', 'Profile repository or hosted metadata is unavailable');
const stale = () => new SessionError('UNKNOWN_PLAN', 'Profile, repository or machine choices changed; preview again');
const failure = (cause: Cause.Cause<unknown>, step = 'Reading profile inputs', savedProfile?: string) => {
  const error = Cause.squash(cause);
  const reason = error instanceof Error ? error.message : String(error);
  return Effect.fail(new SessionError(error instanceof SessionError ? error.code : 'APP_UNAVAILABLE',
    savedProfile ? `Now following ${savedProfile}; ${step} failed: ${reason}. Reload to retry.` : `${step} failed: ${reason}`));
};
const access = (repoUrl: string) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  return yield* proveReadAccess(repoUrl, join(paths.stateRoot, 'agent', 'empty-hooks')).pipe(
    Effect.match({ onSuccess: () => 'readable' as const, onFailure: error => error._tag === 'AccessDenied' ? 'denied' as const : 'unreachable' as const }));
});
const checkLink = (handle: AgentHandle, setupId: string) => Effect.gen(function* () {
  const client = handle.profileHosted;
  if (!client) return yield* Effect.fail(unavailable());
  const setup = yield* client.publicSetup(setupId);
  return { ...setup, access: yield* access(setup.repoUrl) };
});
const bounded = <N extends 'inspectProfiles' | 'inspectShareLink' | 'previewChange'>(name: N, result: unknown) => Effect.try({
  try: () => {
    if (Buffer.byteLength(JSON.stringify(result)) > PROFILE_RESULT_BYTES) throw new Error();
    return decodeOperationOutput(name, result);
  }, catch: () => new SessionError('OVERSIZED', 'Profile result exceeds supported bounds'),
});

export const readProfileOperation = <N extends 'inspectProfiles' | 'inspectShareLink'>(handle: AgentHandle, name: N, input: OperationInput<N>): Effect.Effect<OperationOutput<N>, SessionError, AgentServices> => Effect.gen(function* () {
  if (input.scope.kind !== 'machine') return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Profiles support machine scope only'));
  if (name === 'inspectShareLink') return yield* bounded(name, yield* checkLink(handle, (input as OperationInput<'inspectShareLink'>).setupId));
  const paths = yield* MachinePaths;
  const followed = yield* (yield* FollowedStore).read;
  let documents;
  if (followed) {
    const repo = followedClone(paths, followed.repoUrl);
    const head = yield* revParse(repo, FOLLOWED_MAIN);
    if (!head) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'No fetched profile inventory is available; refetch to retry'));
    documents = yield* commitDocuments(repo, head);
  } else documents = yield* worktreeDocuments(paths.repo);
  const names = yield* listProfiles('/profile').pipe(Effect.provide(memoryFiles(Object.fromEntries(Object.entries(documents).map(([path, text]) => [join('/profile', path), text])))));
  const available = [];
  for (const name of names) {
    yield* requireValid(desiredOfDocuments(documents, undefined, name));
    const text = documents[`profiles/${name}.json`];
    available.push({ name, extends: text === undefined ? null : JSON.parse(text).extends ?? null });
  }
  return yield* bounded(name, { followed: followed ?? null, available });
}).pipe(Effect.timeout(PROFILE_TIMEOUT), Effect.catchCause(cause => failure(cause)));

export const prepareProfileOperation = (handle: AgentHandle, change: Extract<OperationChange, { kind: 'followProfile' }>, generation: number): Effect.Effect<PreparedParityChange, SessionError, AgentServices> => Effect.gen(function* () {
  const context = yield* Effect.context<AgentServices>();
  const paths = yield* MachinePaths, fs = yield* Fs, store = yield* FollowedStore, sync = yield* SyncStore, overridesStore = yield* OverridesStore;
  const target: FollowedProfile = { repoUrl: change.repoUrl, profile: change.profile, setupId: change.setupId };
  const hostedBaseline = target.setupId === null ? undefined : hostedBaselineRelative('followed', target.repoUrl, target.setupId);
  const observe = Effect.gen(function* () {
    const previous = yield* store.read;
    const resetBaseline = previous !== undefined && normalizeRepoUrl(previous.repoUrl) !== normalizeRepoUrl(target.repoUrl);
    const link = change.setupId === null ? undefined : yield* checkLink(handle, change.setupId);
    if (link && (normalizeRepoUrl(link.repoUrl) !== normalizeRepoUrl(target.repoUrl) || link.profile !== target.profile)) return yield* Effect.fail(stale());
    const readable = link?.access ?? (yield* access(target.repoUrl));
    if (readable !== 'readable') return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', readable === 'denied' ? 'Git read access denied; no subscription was created' : 'Git read access could not be verified'));
    const repo = yield* privateFollowedRepository(paths, target, { proveAccess: false });
    if (!(yield* fetchFollowedMain(paths, repo, target.repoUrl))) return yield* Effect.fail(unavailable());
    // Revision metadata requires a subscription. Preview Git inventory; the post-subscription source verifies announced content.
    const head = yield* revParse(repo, FOLLOWED_MAIN);
    if (!head) return yield* Effect.fail(unavailable());
    const holds = yield* sync.read, overrides = yield* overridesStore.read;
    if (overrides.issues.length) return yield* Effect.fail(new SessionError('PROFILE_INVALID', 'Repair machine overrides before switching profiles'));
    const documents = yield* commitDocuments(repo, head);
    const to = yield* requireValid(desiredOfDocuments(documents, undefined, target.profile));
    const absent = droppedOnSwitch({ holds, overrides: overrides.value, to });
    const resolvable: Record<string, string> = {}, unavailableHolds: string[] = [];
    for (const [id, commit] of Object.entries(holds)) {
      if (resetBaseline || absent.holds.includes(id)) continue;
      if ((yield* revParse(repo, commit)) === undefined) unavailableHolds.push(id);
      else resolvable[id] = commit;
    }
    const { staleHolds } = yield* composeDocumentsWithStaleHolds({ repo, head: { kind: 'commit', commit: head }, held: resolvable, profile: target.profile });
    const dropped = droppedOnSwitch({ holds, overrides: overrides.value, to, staleHolds: resetBaseline ? Object.keys(holds) : [...staleHolds, ...unavailableHolds] });
    const nextHolds = Object.fromEntries(Object.entries(holds).filter(([id]) => !dropped.holds.includes(id)));
    const nextOverrides = retainedOverrides(overrides.value, dropped.overrides);
    const files = yield* Effect.forEach(['agent/followed.json', 'sync.json', 'overrides.json', 'state.json', ...(hostedBaseline ? [hostedBaseline] : [])], name => fs.readBytes(join(paths.stateRoot, name)).pipe(Effect.map(authorDigest)));
    return { previous, resetBaseline, holds, overrides, dropped, nextHolds, nextOverrides, binding: digest({ previous, target, link, head, files, dropped, to }) };
  }).pipe(Effect.timeout(PROFILE_TIMEOUT));
  const first = yield* observe;
  const keys = [...(first.resetBaseline ? ['profile:baseline'] : []), 'profile:follow', ...(first.dropped.holds.length ? ['profile:holds'] : []), ...(first.dropped.overrides.length ? ['profile:overrides'] : []), ...(target.setupId ? ['profile:subscribe'] : []),
    ...(first.previous?.setupId && first.previous.setupId !== target.setupId ? ['profile:unsubscribe'] : []), 'profile:inspect'];
  const plan: OperationPlan = { kind: 'operation', steps: keys.map(key => ({ key, domain: 'sync', action: 'save-decision',
    summary: key === 'profile:inspect' ? 'Refetch the followed profile for inspection only' : key === 'profile:follow' ? `Back up and follow ${target.profile} from ${target.repoUrl}` : key === 'profile:baseline' ? 'Back up and clear the applied baseline for the new repository' : key === 'profile:holds' ? 'Back up and remove the listed holds' : key === 'profile:overrides' ? 'Back up and remove the listed overrides' : key === 'profile:subscribe' ? 'Subscribe after proving Git read access' : 'Unsubscribe from the previous shared setup',
    touches: key === 'profile:holds' ? first.dropped.holds : key === 'profile:overrides' ? first.dropped.overrides : [], interruptible: false })), skipped: [] };
  const acceptance = { kind: 'followProfile' as const, generation: String(generation), baselineDigest: first.binding, planDigest: digest(plan), plannedKeys: keys };
  const actionEffects = [
    `Back up the followed profile and remove the listed holds and overrides${first.resetBaseline ? '. Clear the applied baseline. Every item from the new repository starts as incoming added; drop all holds from the previous repository' : ''}`,
    'Prove Git read access before subscribing to a shared setup',
    'Refetch for inspection only. Review incoming items before applying machine changes',
    ...(target.setupId || keys.includes('profile:unsubscribe') ? [[
      target.setupId ? 'Switch inventory comes from Git main. Incoming review uses verified announced revisions after subscribing' : '',
      keys.includes('profile:unsubscribe') ? 'Stops following updates through the shared link' : '',
    ].filter(Boolean).join('. ')] : []),
  ];
  const preview = yield* bounded('previewChange', { planId: randomUUID(), scope: { kind: 'machine' }, generation: String(generation), change, droppedChoices: first.dropped, plan, nextActions: [], actionEffects });
  return { preview, acceptance,
    revalidate: Effect.gen(function* () { if ((yield* observe).binding !== first.binding) return yield* Effect.fail(stale()); }).pipe(Effect.provideContext(context), Effect.catchCause(() => Effect.fail(stale()))),
    execute: (lifecycle: import('../runs.ts').RunLifecycle, signal: AbortSignal) => {
      let saved = false, step = 'starting the profile switch';
      return Effect.gen(function* () {
        const observed = yield* parityObserver(lifecycle, acceptance), backups = yield* Backups;
        for (const [index, key] of keys.entries()) {
          step = ({ 'profile:follow': 'saving the followed profile', 'profile:baseline': 'clearing the applied baseline', 'profile:holds': 'removing the listed holds', 'profile:overrides': 'removing the listed overrides', 'profile:subscribe': 'subscribing to the shared setup', 'profile:unsubscribe': 'stopping updates through the previous shared link', 'profile:inspect': 'checking for changes' } as Record<string, string>)[key]!;
          if (signal.aborted) return yield* Effect.fail(new SessionError('INTERNAL', 'Profile switch cancelled; inspect the saved run'));
          yield* observed.observer.pending(key);
          yield* lifecycle.progress({ type: 'started', index, total: keys.length, step: plan.steps[index]! });
          if (key === 'profile:follow') { yield* backups.preserve(join(paths.stateRoot, 'agent/followed.json'), 'agent/followed.json', undefined, { private: true }); yield* store.write(target); saved = true; }
          if (key === 'profile:baseline') {
            yield* backups.preserve(join(paths.stateRoot, 'state.json'), 'state.json', undefined, { private: true });
            yield* markFollowedBaselineEmpty(paths, target);
            yield* (yield* StateStore).update(state => { const { applied: _applied, ...next } = state; return next; });
            if (hostedBaseline) {
              const path = join(paths.stateRoot, hostedBaseline);
              yield* backups.preserve(path, hostedBaseline, undefined, { private: true });
              yield* fs.writeTextAtomic(path, JSON.stringify({ revisionApplied: 0, origins: {} }) + '\n');
            }
          }
          if (key === 'profile:holds') { yield* backups.preserve(join(paths.stateRoot, 'sync.json'), 'sync.json', undefined, { private: true }); yield* sync.write(first.nextHolds); }
          if (key === 'profile:overrides') yield* overridesStore.write(first.nextOverrides, first.overrides.value);
          if (key === 'profile:subscribe') { const client = handle.profileHosted; if (!client) return yield* Effect.fail(unavailable()); yield* client.subscribe(target.setupId!); }
          if (key === 'profile:unsubscribe') { const client = handle.profileHosted; if (!client) return yield* Effect.fail(unavailable()); yield* client.unsubscribe(first.previous!.setupId!); }
          if (key === 'profile:inspect') { if (!handle.freshInspection) return yield* Effect.fail(unavailable()); const result = yield* handle.freshInspection; if (result.status.error) return yield* Effect.fail(new Error(result.status.detail ?? result.status.error)); }
          yield* observed.observer.committed(key);
          const folder = yield* backups.dir;
          yield* observed.checkpoint({ backupIds: folder ? [basename(folder)] : [] });
          yield* lifecycle.progress({ type: 'finished', index, total: keys.length, key, outcome: 'ok', note: 'Profile effect observed' });
        }
      }).pipe(Effect.provide(backupsForRun()), Effect.provideContext(context), Effect.catchCause(cause => failure(cause, step, saved ? target.profile : undefined)));
    },
  };
}).pipe(Effect.catchCause(cause => failure(cause)));
