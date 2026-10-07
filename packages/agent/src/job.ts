import { Effect, Layer } from 'effect';
import {
  backupsForRun, DecisionsStore, HistoryStore, inspect, MachinePaths, machinePaths,
  type HistoryEvent, type ItemReason,
} from '@nortuscc/machine';
import { LOCAL_SETUP, SetupSource, SetupsStore, type Revision } from '@nortuscc/sync';
import { autoApply, type AutoApplyOutcome } from './apply.ts';
import { AgentClock } from './clock.ts';
import type { AgentDomain } from './layer.ts';
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
  (e.kind === 'revision-verified' || e.kind === 'revision-rejected') && e.setupId === LOCAL_SETUP && e.revision === revision;

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

// One job: refresh, resolve, inspect, sort, classify, act by policy. It never fails on what it
// reads from the setup; those outcomes are reported in the status.
export const runJob = (domains: ReadonlyArray<AgentDomain>, options: { readonly signal?: AbortSignal } = {}) =>
  Effect.gen(function* () {
    const history = yield* HistoryStore;
    const agentState = yield* AgentStateStore;
    const source = yield* SetupSource;
    const paths = yield* MachinePaths;
    const now = yield* (yield* AgentClock).now;

    const interrupted = interruptedRun(yield* history.read);
    if (interrupted !== undefined) yield* pause(`auto-apply run ${interrupted} was interrupted`, interrupted);

    const state = yield* agentState.read;
    const trusted = ((yield* (yield* SetupsStore).read) ?? []).some((s) => s.setupId === null);
    const finish = (fields: Partial<AgentStatus> = {}) =>
      Effect.map(agentState.read, (current): AgentStatus => ({
        at: now.toISOString(), policy: current.policy, paused: current.paused, trusted,
        pending: [], drift: [], conflicts: [], probeErrors: [], ...fields,
      }));

    // 1. Refresh: verify the tracked branch's head once. A mismatch blocks only that revision; an
    // unreachable one is retried by the next job. An untrusted setup is never fetched or verified.
    const head = trusted
      ? yield* source.fetch.pipe(
        Effect.map((fetched): Revision | undefined => fetched.head),
        Effect.catchTag('RevisionUnavailable', () => Effect.succeed(undefined)),
      )
      : undefined;
    if (head !== undefined && !(yield* history.read).some((e) => isVerdictOn(e, head))) {
      yield* source.load(head).pipe(
        Effect.andThen(history.append({ kind: 'revision-verified', actor: 'agent', setupId: LOCAL_SETUP, revision: head })),
        Effect.catchTag('RevisionMismatch', (error) =>
          history.append({ kind: 'revision-rejected', actor: 'agent', setupId: LOCAL_SETUP, revision: head, error: error._tag })),
        Effect.catchTag('RevisionUnavailable', () => Effect.void),
      );
    }
    const events = yield* history.read;
    const verified = new Set(events.flatMap((e) => (e.kind === 'revision-verified' && e.setupId === LOCAL_SETUP ? [e.revision] : [])));

    // 2. Resolve from decisions on verified revisions of this setup. Every job reads decisions.json
    // (and, inside effective, overrides.json) fresh.
    const decisions = yield* (yield* DecisionsStore).read.pipe(Effect.catchTag('DecisionsInvalid', () => Effect.succeed(undefined)));
    const usable = (decisions ?? []).filter((d) => d.setupId === LOCAL_SETUP && d.commit !== null && verified.has(d.commit));
    const resolved = yield* source.effective(usable).pipe(Effect.catchTag('RevisionUnavailable', () => Effect.succeed(undefined)));
    if (resolved === undefined) return yield* finish({ error: 'REVISION_UNAVAILABLE' });
    const decisionsError: Partial<AgentStatus> = decisions === undefined ? { error: 'DECISIONS_INVALID' } : {};

    // 3-6 with MachinePaths.repo at the effective revision's files, and a fresh backup folder.
    const jobLayer = backupsForRun(now).pipe(Layer.provideMerge(machinePaths({ ...paths, repo: resolved.effective.repo })));
    return yield* Effect.gen(function* () {
      const report = yield* inspect(resolved.effective.desired, domains);
      const base: Partial<AgentStatus> = { conflicts: resolved.conflicts, probeErrors: report.probeErrors, ...decisionsError };
      const invalid = resolved.effective.desired.issues.length > 0;
      if (invalid || !trusted) {
        // Inspect-only: report every difference, record nothing, apply nothing.
        const drift = report.items.filter(differs).map((i) => i.key);
        return yield* finish({ ...base, drift, ...(invalid ? { error: 'PROFILE_INVALID' as const } : {}) });
      }
      const sorted = yield* sortItems(report, resolved.applied, resolved.effective);
      const inert = sorted.pending.filter((p) => p.verdict.kind === 'inert');
      const held = sorted.pending.filter((p) => p.verdict.kind === 'held');
      // A paused auto-apply machine leaves inert items to a person, as notify does. An unpaused one
      // applies them, so nothing stays ready and a stale ready batch is reset.
      const notifies = state.policy === 'notify' || (state.policy === 'auto-apply' && state.paused !== null);
      if (state.policy !== 'manual') {
        yield* recordBatch(events, 'held', held.map(reasonOf));
        yield* recordBatch(events, 'ready', notifies ? inert.map(reasonOf) : []);
      }
      let applied: AutoApplyOutcome | undefined;
      if (state.policy === 'auto-apply' && state.paused === null && inert.length > 0) {
        applied = yield* autoApply(report, inert.map((p) => p.key), domains, options);
      }
      return yield* finish({ ...base, pending: sorted.pending, drift: sorted.drift, ...(applied ? { autoApply: applied } : {}) });
    }).pipe(Effect.provide(jobLayer));
  });
