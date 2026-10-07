import { Effect, Layer } from 'effect';
import {
  acquireApplyLock, DecisionsStore, MachinePaths, Processes, type Actor, type Decision, type MachinePathsValue,
} from '@nortuscc/machine';
import {
  HostedFailure, HostedTransport, hostedStore, httpTransport, machineTokenStore, makeHostedClient,
  type HostedClient, type HostedState, type TokenKeychain,
} from '@nortuscc/hosted-client';
import {
  hostedSetupSourceLayer, itemIdOf, normalizeRepoUrl, SetupSource, SetupsStore,
} from '@nortuscc/sync';
import { parseItemId, type DeviceStartRequest, type MachinePatch, type SetupStatus, type StatusSummary, type SyncRevision } from '@nortuscc/hosted-protocol';
import { AgentClock } from './clock.ts';
import { runJob, type JobInspection } from './job.ts';
import { type AgentDomains, type AgentServices } from './layer.ts';
import { AgentStateStore } from './state.ts';
import { trustHostedSetup } from './setups.ts';
import { currentChoices, observedHostedItems, projectHostedSetup } from './hosted-status.ts';

export type HostedOptions = {
  readonly url: string; readonly platform: NodeJS.Platform;
  readonly transport?: Layer.Layer<HostedTransport>; readonly keychain?: TokenKeychain;
  readonly now?: () => Date;
};
export type HostedRuntimeState = HostedState & {
  readonly enabled: boolean; readonly recovered: boolean; readonly signingIn: boolean;
};
const empty: HostedState = { accountId: null, login: null, machineId: null, auth: 'signed-out', setups: [], machine: null,
  lastSyncAt: null, retryAt: null, pollAfter: 900, error: null };
export const disabledHostedState: HostedRuntimeState = { ...empty, enabled: false, recovered: true, signingIn: false };
export const hostedWait = (deadline: number, now: number): number => Math.max(1, Math.min(60_000, deadline - now));
export const hostedCadence = (seconds: number, random: number): number => Math.round(seconds * 1000 * (0.8 + 0.4 * random));
const safe = (error: unknown) => error instanceof HostedFailure ? error : new HostedFailure({ code: 'storage' });

// Every operation is service-free. The agent supplies the common job/apply serialization boundary.
export const makeHostedRuntime = (client: HostedClient, input: {
  readonly domains: AgentDomains; readonly os: DeviceStartRequest['os']; readonly agents?: DeviceStartRequest['agents']; readonly signal?: AbortSignal; readonly configurationError?: boolean;
}) => Effect.gen(function* () {
  const context = yield* Effect.context<AgentServices | SetupSource>();
  const paths = yield* MachinePaths;
  const local = yield* SetupSource;
  const store = yield* SetupsStore;
  const decisions = yield* DecisionsStore;
  const agentState = yield* AgentStateStore;
  const clock = yield* AgentClock;
  const processes = Layer.succeed(Processes, yield* Processes);
  const agents = input.agents ?? ['claude', 'codex'];
  let failure: HostedFailure | undefined;
  let recovered = false;
  let signingIn = false;
  let pollAt = Infinity;
  let expiresAt = 0;
  let nextSync = 0;
  let generation = 0;
  // Current-process proof of selected successful native operations, never imported checkout seeds.
  const confirmed = new Map<string, string>();
  const withServices = <A, E>(effect: Effect.Effect<A, E, AgentServices | SetupSource>) => Effect.provideContext(effect, context);
  const remember = <A>(effect: Effect.Effect<A, HostedFailure>) => effect.pipe(Effect.tapError((error) => Effect.sync(() => { failure = error; })));
  const recover = remember(client.recover()).pipe(Effect.tap(() => Effect.sync(() => { recovered = true; })),
    Effect.tapError(() => Effect.sync(() => { recovered = false; })));
  const state = Effect.gen(function* () {
    const current = yield* client.state.pipe(Effect.catch((error) => { failure = error; return Effect.succeed(empty); }));
    return { ...current, error: input.configurationError ? 'invalid_url' as const : failure?.code ?? current.error, enabled: true, recovered, signingIn } satisfies HostedRuntimeState;
  });
  const invalidate = () => { generation++; failure = undefined; };
  const records = (setupId: string, accountId: string) => Effect.gen(function* () {
    const current = yield* client.state;
    const offered = current.setups.find((s) => s.setupId === setupId);
    if (!recovered || current.accountId !== accountId || !offered) return yield* Effect.fail(new HostedFailure({ code: 'storage' }));
    const cached = (yield* client.revisions(setupId)).filter((r) => r.number <= offered.latestRevision);
    if (cached.length !== offered.latestRevision || cached.some((r, i) => r.number !== i + 1)) return yield* Effect.fail(new HostedFailure({ code: 'storage' }));
    return cached;
  });
  type Selected = { source: SetupSource['Service']; records: ReadonlyArray<SyncRevision>; scope: string };
  const select = Effect.gen(function* () {
    const current = yield* client.state;
    const trust = yield* store.read;
    if (trust === undefined) return yield* Effect.fail(new HostedFailure({ code: 'storage' }));
    const linked = trust.filter((s) => s.accountId === current.accountId && s.setupId !== null && s.repoUrl !== null);
    const selected: Selected[] = [];
    let primary = local;
    let complete = true;
    let primaryUnavailable = false;
    for (const entry of linked) {
      const offered = current.setups.find((s) => s.setupId === entry.setupId);
      if (!offered || normalizeRepoUrl(offered.repoUrl) !== normalizeRepoUrl(entry.repoUrl!) || selected.some((s) => s.source.setupId === entry.setupId)) { complete = false; if (entry.checkout === paths.repo) primaryUnavailable = true; continue; }
      const source = yield* SetupSource.pipe(Effect.provide(hostedSetupSourceLayer(paths, {
        accountId: current.accountId!, currentAccountId: Effect.map(client.state, (s) => s.accountId), setupId: offered.setupId,
        repoUrl: offered.repoUrl, records: records(offered.setupId, current.accountId!), processes,
      })));
      const cached = yield* records(offered.setupId, current.accountId!).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (cached === undefined) { complete = false; if (entry.checkout === paths.repo) primaryUnavailable = true; continue; }
      selected.push({ source, records: cached, scope: `${current.accountId}/${offered.setupId}/${normalizeRepoUrl(offered.repoUrl)}` });
      if (entry.checkout === paths.repo) primary = source;
    }
    return { primary, selected, complete, primaryUnavailable, accountId: current.accountId };
  }).pipe(Effect.mapError(safe));
  const runWith = (source: SetupSource['Service'], inspectOnly = false) =>
    withServices(runJob(input.domains, { signal: input.signal, inspectOnly }).pipe(Effect.provideService(SetupSource, source)));

  // Called with apply.lock AND the job permit. Any unavailable linked setup declines the whole upload.
  const report = (selection: Effect.Success<typeof select>, applied?: { readonly inspection: JobInspection; readonly successful: ReadonlyArray<string> }) => Effect.gen(function* () {
    if (!selection.complete || !selection.accountId) return;
    const summaries: SetupStatus[] = [];
    const drift = { setting: 0, skill: 0, integration: 0, file: 0 };
    const driftIds = new Set<string>();
    const choices = yield* decisions.read;
    for (const selected of selection.selected) {
      const { source, records } = selected;
      if (!records.length) {
        summaries.push({ setupId: source.setupId!, revisionApplied: 0, adopted: [], skipped: [], pending: [], waitingForPerson: [] });
        continue;
      }
      const fresh = yield* runWith(source, true);
      const inspection = fresh.inspection;
      const revision = inspection?.revision;
      if (!inspection || fresh.status.error || !inspection.trusted || revision === null || typeof revision !== 'object'
        || revision.number !== records.at(-1)!.number || revision.commitSha !== records.at(-1)!.commitSha) return;
      const head = yield* source.load(revision);
      const accepted = [...currentChoices(records, choices)].filter(([, choice]) => choice === 'accept').map(([id]) => id);
      const appliedRevision = applied?.inspection.revision;
      const previousBaseline = yield* source.baseline!;
      const priorProof = accepted.filter((id) => previousBaseline.origins[id] !== undefined && confirmed.get(`${selected.scope}/${id}`) === previousBaseline.origins[id]);
      const successful = appliedRevision !== null && typeof appliedRevision === 'object'
        && appliedRevision.setupId === revision.setupId && appliedRevision.number === revision.number && appliedRevision.commitSha === revision.commitSha ? [...priorProof, ...applied!.successful] : priorProof;
      const observed = yield* withServices(observedHostedItems(inspection, head, accepted, successful));
      yield* source.recordApplied!({ revision, decisions: choices, observed, released: [] });
      const baseline = yield* source.baseline!;
      for (const id of observed) confirmed.set(`${selected.scope}/${id}`, baseline.origins[id]!);
      summaries.push(projectHostedSetup({ records, decisions: choices, observed, status: fresh.status, revisionApplied: baseline.revisionApplied }));
      for (const key of fresh.status.drift) {
        const id = itemIdOf(key, inspection.desired);
        if (id !== undefined) driftIds.add(id);
      }
    }
    // The request lock inside client.reportStatus and outer runtime boundary keep this account current.
    if ((yield* client.state).accountId !== selection.accountId) return;
    for (const id of driftIds) {
      const ref = parseItemId(id);
      if (ref) drift[ref.kind]++;
    }
    yield* client.reportStatus({ reportedAt: (yield* clock.now).toISOString(), policy: (yield* agentState.read).policy, agents, setups: summaries, drift });
  }).pipe(Effect.mapError(safe), Effect.catch((error) => { failure = error; return Effect.void; }));

  const inspectPrimary = Effect.gen(function* () {
    yield* recover;
    const selection = yield* select;
    if (selection.primaryUnavailable) return yield* Effect.fail(new HostedFailure({ code: 'storage' }));
    return yield* runWith(selection.primary, true);
  });
  const runJobs = Effect.gen(function* () {
    // Never wait on apply.lock while holding the job permit. A person's apply may own it.
    const ready = yield* withServices(Effect.scoped(Effect.andThen(acquireApplyLock, recover))).pipe(
      Effect.match({ onFailure: () => false, onSuccess: () => true }));
    const fallback = Effect.gen(function* () {
      const trust = yield* store.read.pipe(Effect.catch(() => Effect.succeed(undefined)));
      return yield* runWith(local, trust === undefined || trust.some((s) => s.checkout === paths.repo && s.setupId !== null));
    });
    if (!ready) return yield* fallback;
    const selection = yield* select.pipe(Effect.catch((error) => { failure = error; return Effect.succeed(undefined); }));
    if (!selection) return yield* fallback;
    const primary = yield* runWith(selection.primary, selection.primaryUnavailable);
    for (const selected of selection.selected) if (selected.source !== selection.primary) {
      yield* runWith(selected.source).pipe(Effect.catchCause(() => Effect.void));
    }
    yield* withServices(Effect.scoped(Effect.andThen(acquireApplyLock, report(selection)))).pipe(Effect.ignore);
    return primary;
  });
  const sync = remember(Effect.gen(function* () {
    invalidate();
    const current = yield* client.sync().pipe(Effect.tapError(() => Effect.sync(() => { recovered = false; })));
    recovered = true;
    nextSync = (yield* clock.now).getTime() + hostedCadence(current.pollAfter, yield* clock.random);
    return current;
  }));
  return {
    state, generation: Effect.sync(() => generation), runJobs, inspectPrimary,
    afterPerson: (inspection: JobInspection, successful: ReadonlyArray<string>) => Effect.flatMap(select, (selection) => report(selection, { inspection, successful })).pipe(Effect.ignore),
    decide: (decision: Decision, actor: Actor) => remember(Effect.gen(function* () {
      invalidate();
      yield* client.enqueueDecision(decision, actor);
      nextSync = 0;
    })),
    machine: (patch: MachinePatch, actor: Actor) => remember(Effect.gen(function* () {
      invalidate(); yield* client.enqueueMachine(patch, actor); nextSync = 0;
    })),
    trust: (id: string, actor: Actor) => remember(Effect.gen(function* () {
      invalidate(); yield* withServices(trustHostedSetup(id, yield* client.state, actor));
    })),
    signIn: (name?: string) => remember(Effect.gen(function* () {
      invalidate();
      const started = yield* client.startSignIn({ os: input.os, agents, ...(name === undefined ? {} : { name }) });
      signingIn = true;
      const now = (yield* clock.now).getTime();
      pollAt = now + started.interval * 1000; expiresAt = now + started.expiresIn * 1000;
      return started;
    })),
    signOut: () => remember(Effect.gen(function* () { invalidate(); signingIn = false; yield* client.signOut(); })),
    sync,
    // Called under the same mutation boundary as IPC, including device completion/account switch.
    tick: Effect.gen(function* () {
      const now = (yield* clock.now).getTime();
      let changed = false;
      if (signingIn && now >= Math.min(pollAt, expiresAt)) {
        invalidate();
        const result = yield* client.pollSignIn().pipe(Effect.catch((error) => {
          failure = error;
          if (error.code === 'sign_in_expired' || error.code === 'not_allowlisted') signingIn = false;
          pollAt = now + Math.max(1000, (error.retryAfter ?? 5) * 1000);
          return Effect.succeed(undefined);
        }));
        if (result?.status === 'success') { signingIn = false; nextSync = 0; changed = true; }
        else if (result?.status === 'pending') pollAt = now + result.pollAfter * 1000;
      }
      const current = yield* state;
      if (current.auth === 'signed-in' && now >= Math.max(nextSync, current.retryAt === null ? 0 : Date.parse(current.retryAt))) {
        yield* sync.pipe(Effect.catch(() => Effect.sync(() => { nextSync = now + 60_000; })));
        changed = true;
      }
      return changed;
    }),
    due: Effect.gen(function* () {
      const now = (yield* clock.now).getTime();
      const current = yield* state;
      return signingIn && now >= Math.min(pollAt, expiresAt)
        || current.auth === 'signed-in' && now >= Math.max(nextSync, current.retryAt === null ? 0 : Date.parse(current.retryAt));
    }),
    wait: Effect.gen(function* () {
      const now = (yield* clock.now).getTime();
      const current = yield* state;
      const syncAt = current.auth === 'signed-in' ? Math.max(nextSync, current.retryAt === null ? 0 : Date.parse(current.retryAt)) : Infinity;
      return hostedWait(Math.min(signingIn ? Math.min(pollAt, expiresAt) : Infinity, syncAt), now);
    }),
  };
});
export type HostedRuntime = Effect.Success<ReturnType<typeof makeHostedRuntime>>;

export const configuredHostedRuntime = (paths: MachinePathsValue, options: HostedOptions, input: Parameters<typeof makeHostedRuntime>[1]) =>
  Effect.gen(function* () {
    const state = yield* AgentStateStore;
    const processes = Layer.succeed(Processes, yield* Processes);
    let configurationError = false;
    try {
      const url = new URL(options.url);
      configurationError = url.protocol !== 'https:' || Boolean(url.username || url.password || url.search || url.hash) || !/\/v1\/?$/.test(url.pathname);
    } catch { configurationError = true; }
    const client = yield* makeHostedClient({ now: options.now, readPolicy: state.read,
      onPolicy: (policy, origin) => state.update((s) => ({ ...s, policy, ...(origin === 'local' ? { policySource: 'person' as const } : {}) })).pipe(Effect.asVoid),
    }).pipe(Effect.provide(Layer.mergeAll(hostedStore, configurationError ? Layer.succeed(HostedTransport, { request: () => Effect.fail(new HostedFailure({ code: 'invalid_url' })) }) : options.transport ?? httpTransport(options.url),
      machineTokenStore(paths, { platform: options.platform, processes, keychain: options.keychain }))));
    return yield* makeHostedRuntime(client, { ...input, configurationError });
  });
