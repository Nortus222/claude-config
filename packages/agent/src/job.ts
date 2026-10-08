import { Effect, Layer } from 'effect';
import {
  backupsForRun, DecisionsStore, HistoryStore, inspect, MachinePaths, machinePaths,
  type HistoryEvent, type ItemReason, type MachinePathsValue, type MachineReport,
} from '@nortuscc/machine';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { LOCAL_SETUP, ownSetup, revisionIdentity, revisionSetupId, SetupSource, SetupsStore, type Revision } from '@nortuscc/sync';
import { autoApply, type AutoApplyOutcome } from './apply.ts';
import { AgentClock } from './clock.ts';
import type { AgentDomain, AgentDomains } from './layer.ts';
import { interruptedRun, pause } from './pause.ts';
import { differs, sortItems, type Pending } from './sort.ts';
import { AgentStateStore, DEFAULT_STATE, type Paused, type Policy } from './state.ts';

export type StatusError = 'PROFILE_INVALID' | 'DECISIONS_INVALID' | 'REVISION_UNAVAILABLE' | 'JOB_FAILED';

// What one job saw and did. After an auto-apply it still lists what the job sorted before applying.
export type AgentStatus = {
  readonly at: string;
  readonly policy: Policy;
  readonly paused: Paused | null;
  readonly trusted: boolean;
  readonly pending: ReadonlyArray<Pending>;
  readonly drift: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
  readonly probeErrors: ReadonlyArray<string>;
  readonly error?: StatusError;
  readonly detail?: string;
  readonly autoApply?: AutoApplyOutcome;
};

// What a job inspected, and with what: its paths at the snapshot, and the domains built from them.
// `revision` is the tracked branch head the effective configuration is built at, when the job fetched it.
export type JobInspection = {
  readonly paths: MachinePathsValue;
  readonly revision: Revision | null;
  readonly desired: DesiredConfig;
  readonly report: MachineReport;
  readonly domains: ReadonlyArray<AgentDomain>;
  readonly trusted: boolean;
};

// A job's status, and its inspection when it got as far as inspecting.
export type JobResult = { readonly status: AgentStatus; readonly inspection?: JobInspection };

// The status of a job that failed outright: the last known policy and pause, nothing listed.
export const failedStatus = (at: string, previous: AgentStatus | undefined, detail: string): AgentStatus => ({
  at,
  policy: previous?.policy ?? DEFAULT_STATE.policy,
  paused: previous?.paused ?? null,
  trusted: previous?.trusted ?? false,
  pending: [], drift: [], conflicts: [], probeErrors: [],
  error: 'JOB_FAILED',
  detail,
});

const isVerdictOn = (e: HistoryEvent, revision: Revision) =>
  (e.kind === 'revision-verified' || e.kind === 'revision-rejected') && e.setupId === revisionSetupId(revision) && e.revision === revisionIdentity(revision);

const reasonOf = (p: Pending): ItemReason => ({ itemId: p.itemId, reason: p.verdict.kind === 'held' ? p.verdict.reason : 'inert' });
const batchKey = (items: ReadonlyArray<ItemReason>) => items.map((i) => `${i.itemId}\n${i.reason}`).sort().join('\n\n');

// Appends a `held` or `ready` batch only when it differs from the last one of its kind, so an
// unchanged batch is recorded once (History's stand-in for "notified once" until the Notifier).
// An empty batch after a non-empty one is recorded as a reset, so the same set recurring later is
// recorded again; an empty batch after an empty one (or none) records nothing.
const recordBatch = (events: ReadonlyArray<HistoryEvent>, kind: 'held' | 'ready', items: ReadonlyArray<ItemReason>) =>
  Effect.gen(function* () {
    let last: ReadonlyArray<ItemReason> = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === kind) {
        last = e.items;
        break;
      }
    }
    if (batchKey(last) === batchKey(items)) return;
    yield* (yield* HistoryStore).append({ kind, actor: 'agent', items });
  });

// One job: refresh, resolve, inspect, sort, classify, act by policy. A checkout this machine does
// not trust is only inspected for drift, against its own HEAD. Each inspection builds its domains
// from paths whose `repo` is the snapshot inspected, and the auto-apply reuses them. It never fails
// on what it reads from the setup; those outcomes are reported in the status. `inspectOnly` resolves
// and inspects (still recording revision verdicts) but records no batch and applies nothing.
export const runJob = (domains: AgentDomains, options: { readonly signal?: AbortSignal; readonly inspectOnly?: boolean } = {}) =>
  Effect.gen(function* () {
    const history = yield* HistoryStore;
    const agentState = yield* AgentStateStore;
    const source = yield* SetupSource;
    const paths = yield* MachinePaths;
    const now = yield* (yield* AgentClock).now;

    const interrupted = interruptedRun(yield* history.read);
    if (interrupted !== undefined) yield* pause(`auto-apply run ${interrupted} was interrupted`, interrupted);

    const state = yield* agentState.read;
    const setupId = source.setupId ?? LOCAL_SETUP;
    const trusted = source.trusted === undefined
      ? ownSetup(yield* (yield* SetupsStore).read, paths.repo) !== undefined
      : yield* source.trusted.pipe(Effect.catchTag('RevisionUnavailable', () => Effect.succeed(false)));
    const finish = (fields: Partial<AgentStatus> = {}, inspection?: JobInspection) =>
      Effect.map(agentState.read, (current): JobResult => {
        const status: AgentStatus = {
          at: now.toISOString(), policy: current.policy, paused: current.paused, trusted,
          pending: [], drift: [], conflicts: [], probeErrors: [], ...fields,
        };
        return inspection ? { status, inspection } : { status };
      });
    // Inspects `desired` with domains built from paths at the snapshot in `repo`.
    const inspectAt = (desired: DesiredConfig, repo: string, revision: Revision | null) =>
      Effect.gen(function* () {
        const jobPaths = { ...paths, repo };
        const built = domains(jobPaths);
        const report = yield* inspect(desired, built);
        const inspection: JobInspection = { paths: jobPaths, revision, desired, report, domains: built, trusted };
        return inspection;
      });
    // MachinePaths.repo at a snapshot's files, and a fresh backup folder.
    const at = (repo: string) => backupsForRun(now).pipe(Layer.provideMerge(machinePaths({ ...paths, repo })));

    // Untrusted: never fetched, verified, recorded or applied; only drift from the checkout's HEAD.
    if (!trusted) {
      const current = yield* source.current.pipe(Effect.catchTag('RevisionUnavailable', () => Effect.succeed(undefined)));
      if (current === undefined) return yield* finish({ error: 'REVISION_UNAVAILABLE' });
      const inspection = yield* inspectAt(current.desired, current.repo, null).pipe(Effect.provide(at(current.repo)));
      const { report } = inspection;
      return yield* finish({ drift: report.items.filter(differs).map((i) => i.key), probeErrors: report.probeErrors }, inspection);
    }

    // 1. Refresh and verify. Hosted heads are verified every job; local branch verdicts are
    // cached in History. The hosted source also verifies every contributing record in effective.
    const head = yield* source.fetch.pipe(
      Effect.map((fetched): Revision | undefined => fetched.head),
      Effect.catchTag('RevisionUnavailable', () => Effect.succeed(undefined)),
    );
    if (head !== undefined && (typeof head !== 'string' || !(yield* history.read).some((e) => isVerdictOn(e, head)))) {
      const prior = yield* history.read;
      yield* source.load(head).pipe(
        Effect.andThen(prior.some((e) => isVerdictOn(e, head) && e.kind === 'revision-verified') ? Effect.void : history.append({ kind: 'revision-verified', actor: 'agent', setupId: revisionSetupId(head), revision: revisionIdentity(head) })),
        Effect.catchTag('RevisionMismatch', (error) =>
          prior.some((e) => isVerdictOn(e, head) && e.kind === 'revision-rejected') ? Effect.void : history.append({ kind: 'revision-rejected', actor: 'agent', setupId: revisionSetupId(head), revision: revisionIdentity(head), error: error._tag })),
        Effect.catchTag('RevisionUnavailable', () => Effect.void),
      );
    }
    const events = yield* history.read;
    const verified = new Set(events.flatMap((e) => (e.kind === 'revision-verified' && e.setupId === LOCAL_SETUP ? [e.revision] : [])));

    // 2. Local decisions require a cached branch verdict. Hosted decisions pass to the source
    // for tag/diff verification and carry-forward checks. Decisions and overrides are read fresh.
    const decisions = yield* (yield* DecisionsStore).read.pipe(Effect.catchTag('DecisionsInvalid', () => Effect.succeed(undefined)));
    const usable = (decisions ?? []).filter((d) => d.setupId === setupId && (setupId === LOCAL_SETUP ? d.commit !== null && verified.has(d.commit) : d.revision !== null));
    const resolved = yield* source.effective(usable).pipe(Effect.catchTag('RevisionUnavailable', () => Effect.succeed(undefined)), Effect.catchTag('RevisionMismatch', () => Effect.succeed(undefined)));
    if (resolved === undefined) return yield* finish({ error: 'REVISION_UNAVAILABLE' });
    const decisionsError: Partial<AgentStatus> = decisions === undefined ? { error: 'DECISIONS_INVALID' } : {};

    // 3-6 at the effective revision's files.
    return yield* Effect.gen(function* () {
      const inspection = yield* inspectAt(resolved.effective.desired, resolved.effective.repo, head ?? null);
      const { report } = inspection;
      const base: Partial<AgentStatus> = { conflicts: resolved.conflicts, probeErrors: report.probeErrors, ...decisionsError };
      if (resolved.effective.desired.issues.length > 0) {
        // Inspect-only: report every difference, record nothing, apply nothing.
        return yield* finish({ ...base, drift: report.items.filter(differs).map((i) => i.key), error: 'PROFILE_INVALID' }, inspection);
      }
      const sorted = yield* sortItems(report, resolved.applied, resolved.effective);
      const inert = sorted.pending.filter((p) => p.verdict.kind === 'inert');
      const held = sorted.pending.filter((p) => p.verdict.kind === 'held');
      // A paused auto-apply machine leaves inert items to a person, as notify does. An unpaused one
      // applies them, so nothing stays ready and a stale ready batch is reset.
      const notifies = state.policy === 'notify' || (state.policy === 'auto-apply' && state.paused !== null);
      if (state.policy !== 'manual' && !options.inspectOnly) {
        yield* recordBatch(events, 'held', held.map(reasonOf));
        yield* recordBatch(events, 'ready', notifies ? inert.map(reasonOf) : []);
      }
      let applied: AutoApplyOutcome | undefined;
      if (!options.inspectOnly && state.policy === 'auto-apply' && state.paused === null && inert.length > 0) {
        applied = yield* autoApply(report, inert.map((p) => p.key), inspection.domains, options);
      }
      return yield* finish({ ...base, pending: sorted.pending, drift: sorted.drift, ...(applied ? { autoApply: applied } : {}) }, inspection);
    }).pipe(Effect.provide(at(resolved.effective.repo)));
  });
