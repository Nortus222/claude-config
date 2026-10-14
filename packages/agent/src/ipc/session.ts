import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Layer, Scope } from 'effect';
import {
  acquireApplyLock, backupsForRun, liveLockHolder, MachinePaths, machinePaths, plan, pruneBackups, samePlan, selectAll,
  type MachineReport, type Plan, type Progress,
} from '@nortuscc/machine';
import { itemIdOf, revisionCommit, type SetupSource } from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import { recordedRun } from '../apply.ts';
import { makeAgentRuns, type AgentRuns, type RunLifecycle } from '../runs.ts';
import { decodeOperationInput, type ChangePreview, type ReconcileChange } from '../operations/index.ts';
import type { RunActor } from '../run-store.ts';
import { AgentClock } from '../clock.ts';
import { runJob, type AgentStatus, type JobInspection } from '../job.ts';
import type { AgentDomains, AgentServices } from '../layer.ts';
import {
  toWireStatus,
  type ApplyResult, type ErrorCode, type InspectResult, type PreviewResult, type RunProgress, type WireObserved, type WirePlan, type WireStatus,
} from './protocol.ts';

// A refusal a client can act on; `code` travels as the protocol's error code.
export class SessionError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type Client = 'app' | 'cli' | 'mcp';

// One person's preview and at most one run, over the agent's latest job inspection.
export type AgentSession = {
  readonly runs: AgentRuns;
  readonly onProgress: (listener: (runId: string, progress: RunProgress) => void) => () => void;
  // Runs a job now and answers what it inspected, with its status. Clears any preview.
  readonly inspect: (actor: Client) => Effect.Effect<InspectResult & { readonly status: WireStatus }, SessionError>;
  readonly preview: (exclude: ReadonlyArray<string>) => Effect.Effect<PreviewResult, SessionError>;
  readonly previewChange: (change: ReconcileChange) => Effect.Effect<ChangePreview, SessionError>;
  // Answers `started` and runs in the background, or `stale` with a new preview. The run's events
  // start once this resolves, so a caller that writes its reply synchronously on resolving, before
  // yielding, sends the reply first. The terminal event comes after apply.lock is released. A
  // throwing `emit` is logged to stderr and never reaches the run.
  readonly apply: (planId: string, actor: Client, emit: (runId: string, progress: RunProgress) => void) => Effect.Effect<ApplyResult, SessionError>;
  // Stops the active run and waits for it to settle. Answers whether one was running.
  readonly cancel: Effect.Effect<boolean>;
  readonly running: Effect.Effect<boolean>;
};

type Previewed = { readonly planId: string; readonly exclude: ReadonlyArray<string>; readonly plan: Plan; readonly generation: number; readonly change: ReconcileChange; readonly exactSelection: boolean; readonly instructionEvidence: ReadonlyMap<string, string> };
type Active = { readonly runId: string; readonly abort: AbortController; readonly done: Deferred.Deferred<void> };

const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string') return error._tag;
  return String(error);
};

const wireItem = (item: MachineReport['items'][number]): WireObserved => ({
  key: item.key, domain: item.domain, ...(item.target === undefined ? {} : { target: item.target }), label: item.label, group: item.group, state: item.state,
  disposition: item.disposition,
  ...(item.note === undefined ? {} : { note: item.note }),
  ...(item.from === undefined ? {} : { from: { layer: item.from.layer, source: item.from.source } }),
});

// Retain only the selected instruction files' private exact-copy evidence across preview/apply.
const instructionEvidence = (report: MachineReport, selected: readonly string[]): ReadonlyMap<string, string> => {
  const keys = new Set(selected);
  return new Map(report.items.flatMap(item => {
    const evidence = item.domain === 'config' && keys.has(item.key) ? item.facts?.find(fact => fact.startsWith('copy-evidence:')) : undefined;
    return evidence === undefined ? [] : [[item.key, evidence] as const];
  }));
};
const sameInstructionEvidence = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean =>
  before.size === after.size && [...before].every(([key, evidence]) => after.get(key) === evidence);

const wireStep = (step: Plan['steps'][number]) => ({
  key: step.key, domain: step.domain, action: step.action, summary: step.summary, touches: [...step.touches], interruptible: step.interruptible,
  ...(step.targets === undefined ? {} : { targets: [...step.targets] }),
});

const wirePlan = (p: Plan): WirePlan => ({
  kind: p.kind, steps: p.steps.map(wireStep), skipped: p.skipped.map((s) => ({ key: s.key, reason: s.reason })),
});

const wireProgress = (progress: Progress): RunProgress =>
  progress.type === 'started' ? { ...progress, step: wireStep(progress.step) } : progress;

const busy = new SessionError('BUSY', 'An apply is running');

// Why a job left no inspection: its own error where it has one.
const noInspection = (status: AgentStatus): SessionError => {
  const detail = status.detail ? `: ${status.detail}` : '';
  if (status.error === 'PROFILE_INVALID') return new SessionError('PROFILE_INVALID', `The profile is invalid${detail}`);
  if (status.error !== undefined) return new SessionError('INSPECT_FAILED', `The agent could not inspect (${status.error})${detail}`);
  return new SessionError('NO_REPORT', 'The agent has no inspection; inspect again');
};

const validate = (inspection: JobInspection): Effect.Effect<void, SessionError> => {
  const issues = inspection.desired.issues;
  if (issues.length === 0) return Effect.void;
  const first = issues[0]!;
  return Effect.fail(new SessionError('PROFILE_INVALID', `The profile has ${issues.length} issue(s); first: ${first.source}: ${first.path} — ${first.message}`));
};

const planFor = (inspection: JobInspection, exclude: ReadonlyArray<string>, only?: readonly string[]): Plan =>
  plan('apply', inspection.report, { ...selectAll, exclude, ...(only === undefined ? {} : { only }) }, inspection.domains);

// Builds the session in the current scope. A run is a fiber in that scope; closing the scope or
// aborting `signal` cancels it at its next step, and it still records how it ended. `domains` is the
// agent's factory, which apply's re-inspection builds from.
export const makeSession = (handle: AgentHandle, options: { readonly signal: AbortSignal; readonly domains: AgentDomains }) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<AgentServices | SetupSource>();
    const { repo, stateRoot } = yield* MachinePaths;
    // Runs live in a child scope, closed after the abort below: finalizers run in reverse.
    const runs = yield* Scope.fork(yield* Effect.scope);
    const closing = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => closing.abort()));
    const shutdown = AbortSignal.any([options.signal, closing.signal]);

    let previewed: Previewed | undefined;
    let active: Active | undefined;

    const inspect: AgentSession['inspect'] = () =>
      Effect.gen(function* () {
        if (active) return yield* Effect.fail(busy);
        const status = yield* handle.request('inspect');
        const inspection = yield* handle.inspection;
        previewed = undefined;
        if (inspection === undefined) return yield* Effect.fail(noInspection(status));
        const result: InspectResult & { status: WireStatus } = {
          profile: {
            repo,
            revision: inspection.revision === null ? null : revisionCommit(inspection.revision),
            overrides: join(stateRoot, 'overrides.json'),
            issues: inspection.desired.issues.map((i) => ({ layer: i.layer, source: i.source, path: i.path, message: i.message })),
          },
          items: inspection.report.items.map(wireItem),
          probeErrors: [...inspection.report.probeErrors],
          status: { ...toWireStatus(status), applying: active !== undefined || liveLockHolder(join(stateRoot, 'apply.lock')) !== undefined },
        };
        return result;
      });

    const makePreview = (exclude: readonly string[], change?: ReconcileChange) =>
      Effect.gen(function* () {
        if (active) return yield* Effect.fail(busy);
        const inspection = yield* handle.inspection;
        if (inspection === undefined) return yield* Effect.fail(new SessionError('NO_REPORT', 'Inspect the machine before previewing'));
        yield* validate(inspection);
        const keys = new Set(inspection.report.items.map((item) => item.key));
        const unknown = [...exclude, ...(change?.only ?? [])].find((key) => !keys.has(key));
        if (unknown !== undefined) {
          return yield* Effect.fail(new SessionError('UNKNOWN_KEY', `'${unknown}' is not an item of the last inspection; inspect again`));
        }
        const unique = [...new Set(exclude)];
        const selected: ReconcileChange = { kind: 'reconcile', only: change ? [...new Set(change.only)] : [...keys].filter(key => !unique.includes(key)) };
        const next: Previewed = {
          planId: randomUUID(), exclude: unique, plan: planFor(inspection, unique, change ? selected.only : undefined),
          generation: yield* (handle.generation ?? Effect.succeed(0)), change: selected, exactSelection: change !== undefined, instructionEvidence: instructionEvidence(inspection.report, selected.only),
        };
        previewed = next;
        return next;
      });

    const legacyPreview = (next: Previewed): PreviewResult => ({ planId: next.planId, plan: wirePlan(next.plan) });
    const operationPreview = (next: Previewed): ChangePreview => ({
      ...legacyPreview(next), scope: { kind: 'machine' }, change: structuredClone(next.change),
      generation: String(next.generation), nextActions: [],
    });
    const preview: AgentSession['preview'] = exclude => Effect.map(makePreview(exclude), legacyPreview);
    const previewChange: AgentSession['previewChange'] = change => Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => decodeOperationInput('previewChange', { change }),
        catch: () => new SessionError('INVALID_REQUEST', 'Invalid reconcile selection'),
      });
      return operationPreview(yield* makePreview([], input.change));
    });

    // The re-inspection runs outside the scheduler but never beside a scheduled job: it waits for the
    // agent's job permit while holding apply.lock. That cannot deadlock, since a scheduled job holding
    // the permit never waits for apply.lock: its auto-apply finds it held and skips.
    const apply = (planId: string, actor: RunActor, listener: (runId: string, progress: RunProgress) => void, lifecycle?: RunLifecycle) =>
      Effect.gen(function* () {
        // A listener's failure is the listener's: it must never stop the run or skip its History bracket.
        const emit = (runId: string, progress: RunProgress) => {
          try {
            listener(runId, progress);
          } catch (error) {
            process.stderr.write(`apply run ${runId}: a progress listener failed: ${describe(error)}\n`);
          }
        };
        if (active) return yield* Effect.fail(busy);
        const wanted = previewed;
        if (wanted === undefined || wanted.planId !== planId) {
          return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'That preview is no longer current; preview again'));
        }
        const abort = new AbortController();
        const self: Active = { runId: lifecycle?.runId ?? randomUUID(), abort, done: Deferred.makeUnsafe<void>() };
        active = self;
        // Holds apply.lock; made synchronously, so nothing can interrupt between busy and its release.
        const lock = Scope.makeUnsafe();
        const release = Scope.close(lock, Exit.void);
        const clear = Effect.sync(() => {
          if (active === self) active = undefined;
          Deferred.doneUnsafe(self.done, Effect.void);
        });
        // A refusal or a stale plan releases apply.lock, then clears busy.
        const settle = Effect.andThen(release, clear);
        // Opened once apply answers, so the answer precedes every event.
        const answered = Deferred.makeUnsafe<void>();
        let handedOff = false;

        const prepare = Effect.gen(function* () {
          yield* acquireApplyLock.pipe(
            Scope.provide(lock),
            Effect.provideContext(context),
            Effect.catchTag('LockHeld', (held) => Effect.fail(new SessionError('LOCKED', `${held.message}; apply again when it finishes`))),
            Effect.catchTag('MaintenancePending', (pending) => Effect.fail(new SessionError('LOCKED', pending.message))),
          );
          if (wanted.generation !== (yield* (handle.generation ?? Effect.succeed(0)))) {
            previewed = undefined;
            return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The setup changed; inspect and preview again'));
          }
          const job = yield* handle.exclusive(handle.freshInspection ?? runJob(options.domains, { inspectOnly: true })).pipe(
            Effect.provideContext(context),
            Effect.mapError((error) => new SessionError('INSPECT_FAILED', describe(error))),
          );
          const inspection = job.inspection;
          if (inspection === undefined) return yield* Effect.fail(noInspection(job.status));
          yield* validate(inspection);
          if (wanted.exactSelection) {
            const available = new Set(inspection.report.items.map(item => item.key));
            if (wanted.change.only.some(key => !available.has(key))) {
              return yield* Effect.fail(new SessionError('UNKNOWN_KEY', 'The selected items changed; inspect and preview again'));
            }
          }
          const fresh = planFor(inspection, wanted.exclude, wanted.exactSelection ? wanted.change.only : undefined);
          const evidence = instructionEvidence(inspection.report, wanted.change.only);
          if (!samePlan(wanted.plan, fresh) || !sameInstructionEvidence(wanted.instructionEvidence, evidence)) {
            const next: Previewed = { ...wanted, planId: randomUUID(), plan: fresh, instructionEvidence: evidence, generation: yield* (handle.generation ?? Effect.succeed(0)) };
            previewed = next;
            const stale = { status: 'stale' as const, planId: next.planId, plan: wirePlan(fresh), preview: operationPreview(next) };
            return stale;
          }
          const runId = self.runId;
          const run = execute(inspection, fresh, runId, actor, AbortSignal.any([shutdown, abort.signal]), (progress) => emit(runId, progress), release, clear, lifecycle);
          // Forked and handed off as one step, so an interruption either starts the run or settles.
          yield* Effect.uninterruptible(Effect.suspend(() =>
            Effect.andThen(lifecycle?.accepted(wanted.change, fresh.steps.map(step => step.key)) ?? Effect.void, Effect.forkIn(Effect.uninterruptible(Effect.andThen(Deferred.await(answered), run)), runs)).pipe(
              Effect.andThen(Effect.sync(() => { handedOff = true; previewed = undefined; })),
            )));
          const started: ApplyResult = { status: 'started', runId };
          return started;
        });

        return yield* prepare.pipe(
          Effect.onExit(() => (handedOff ? Effect.sync(() => void Deferred.doneUnsafe(answered, Effect.void)) : settle)),
        );
      });

    // One run under the held lock: History brackets it, then the lock is released, old backups are
    // pruned and busy is cleared, and only then is the terminal event emitted. Then a fresh job
    // brings the agent's status, and its subscribers, up to date with what the run changed. A person
    // saw the run, so a failed step does not pause auto-apply.
    const execute = (
      inspection: JobInspection, planned: Plan, runId: string, actor: RunActor, signal: AbortSignal,
      emit: (progress: RunProgress) => void, release: Effect.Effect<void>, clear: Effect.Effect<void>, lifecycle?: RunLifecycle,
    ) =>
      Effect.gen(function* () {
        const now = yield* (yield* AgentClock).now;
        let terminal: RunProgress | undefined;
        const onProgress = (progress: Progress) => Effect.sync(() => {
          const wire = wireProgress(progress);
          if (wire.type === 'done' || wire.type === 'cancelled') terminal = wire;
          else emit(wire);
        });
        const exit = yield* Effect.exit(
          recordedRun(planned, inspection.report, inspection.domains, { runId, actor, automatic: false, signal, onProgress, checkpoint: lifecycle?.progress,
            ...(lifecycle ? { operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId } as const } : {}) }).pipe(
            Effect.provide(backupsForRun(now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))),
          ),
        );
        if (Exit.isFailure(exit)) terminal = { type: 'failed', message: describe(Cause.squash(exit.cause)) };
        if (handle.afterPerson && Exit.isSuccess(exit)) {
          const ok = new Set(exit.value.steps.filter((s) => s.outcome === 'ok').map((s) => s.key));
          const successful = planned.steps.filter((s) => ok.has(s.key)).flatMap((step) => {
            const id = itemIdOf(step.key, inspection.desired);
            return id ? [id] : step.touches.filter((path) => path.startsWith('skills/')).flatMap((path) => {
              const skill = inspection.desired.skills.find((s) => s.name === path.slice('skills/'.length));
              return skill ? [`skill:${skill.source}/${skill.name}`] : [];
            });
          });
          yield* handle.exclusive(handle.afterPerson(inspection, successful)).pipe(Effect.catchCause(() => Effect.void));
        }
        yield* release;
        // The run is already in History; a pruning failure must not hide it.
        if (Exit.isSuccess(exit)) yield* pruneBackups(now, actor).pipe(Effect.ignore);
        if (lifecycle && terminal && (terminal.type === 'failed' || terminal.type === 'done' || terminal.type === 'cancelled')) {
          yield* lifecycle.finished(terminal).pipe(Effect.catch(error => Effect.sync(() => {
            process.stderr.write(`apply run ${runId}: receipt failed: ${describe(error)}\n`);
          })));
        }
        yield* clear;
        if (terminal) emit(terminal);
        if (!shutdown.aborted) yield* Effect.forkIn(handle.request('inspect'), runs);
      }).pipe(Effect.provideContext(context));

    const progressListeners = new Set<(runId: string, progress: RunProgress) => void>();
    yield* Effect.addFinalizer(() => Effect.sync(() => progressListeners.clear()));
    const agentRuns = yield* makeAgentRuns({
      start: (input, lifecycle) => apply(input.planId, input.actor, (runId, progress) => {
        for (const listener of progressListeners) { try { listener(runId, progress); } catch {} }
      }, lifecycle).pipe(Effect.map(result =>
        result.status === 'stale' ? { status: 'stale' as const, preview: result.preview } : result)),
      cancel: runId => Effect.suspend(() => {
        const current = active;
        if (current === undefined || current.runId !== runId) return Effect.void;
        current.abort.abort();
        return Deferred.await(current.done);
      }),
    });
    const session: AgentSession = {
      runs: agentRuns,
      onProgress: listener => { progressListeners.add(listener); return () => void progressListeners.delete(listener); },
      inspect,
      preview,
      previewChange,
      apply: (planId, actor, emit) => apply(planId, actor, emit).pipe(
        Effect.map((result): ApplyResult => result.status === 'stale' ? { status: 'stale', planId: result.planId, plan: result.plan } : result),
        Effect.mapError(error => error instanceof SessionError ? error : new SessionError('INTERNAL', describe(error))),
      ),
      cancel: Effect.suspend(() => {
        const current = active;
        if (current === undefined) return Effect.succeed(false);
        current.abort.abort();
        return Effect.as(Deferred.await(current.done), true);
      }),
      running: Effect.sync(() => active !== undefined),
    };
    return session;
  });
