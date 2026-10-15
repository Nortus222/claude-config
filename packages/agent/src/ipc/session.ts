import { prepareBackupOperation, readBackupOperation } from '../operations/backups.ts';
import { isAccountChange, prepareAccountOperation, readAccountOperation } from '../operations/account.ts';
import { prepareSourceDecision, readSourceOperation, sourceReadCache, type SourceOperation } from '../operations/sources.ts';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Cause, Deferred, Effect, Exit, Layer, Scope } from 'effect';
import {
  acquireApplyLock, Backups, canonical, Fs, skillLockPath, backupsForRun, liveLockHolder, MachinePaths, machinePaths, plan, pruneBackups, samePlan, selectAll,
  type MachineReport, type Plan, type Progress,
} from '@nortuscc/machine';
import { itemIdOf, revisionCommit, type SetupSource } from '@nortuscc/sync';
import type { AgentHandle } from '../agent.ts';
import { recordedRun } from '../apply.ts';
import { makeAgentRuns, type AgentRuns, type RunLifecycle } from '../runs.ts';
import { decodeOperationInput, type ChangePreview, type ReconcileChange, type OperationChange, type OperationInput, type SkillCandidateResult } from '../operations/index.ts';
import type { RunActor } from '../run-store.ts';
import { AgentSkillInstaller } from '../skill-installer.ts';
import { acceptedSkillTuple, additionRunPlan, makeAdditionDriver, type AdditionInvocation } from '../skill-addition.ts';
import { makeSkillOperations, type SkillOperations, type AcceptedSkillPlan } from '../skill-operations.ts';
import { readSyncOperation, prepareSyncOperation } from '../operations/sync.ts';
import { inspectUpdateOperations, prepareUpdateChange } from '../operations/updates.ts';
import { prepareCaptureChange } from '../operations/capture.ts';
import { prepareActionChange } from '../operations/actions.ts';
import { makeIntentOperations } from '../operations/intent.ts';
import { parityObserver, type PreparedParityChange } from '../operations/parity.ts';
import type { ParityAcceptance } from '../operations/index.ts';
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
  readonly listBackups: (input: OperationInput<'listBackups'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'listBackups'>, SessionError>;
  readonly agentStatus: (input: OperationInput<'agentStatus'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'agentStatus'>, SessionError>;
  readonly accountState: (input: OperationInput<'accountState'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'accountState'>, SessionError>;
  readonly runs: AgentRuns;
  // Internal owner seam. Retains only validated, service-captured plans; never accepts wire callbacks.
  readonly retainParityChange: (prepared: PreparedParityChange) => Effect.Effect<ChangePreview, SessionError>;
  readonly skillOperations: SkillOperations;
  readonly watchSources: (input: OperationInput<'watchSources'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'watchSources'>, SessionError>;
  readonly inspectSourceDiff: (input: OperationInput<'inspectSourceDiff'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'inspectSourceDiff'>, SessionError>;
  readonly pinImpact: (input: OperationInput<'pinImpact'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'pinImpact'>, SessionError>;
  readonly draftChangelog: (input: OperationInput<'draftChangelog'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'draftChangelog'>, SessionError>;
  readonly inspectSetups: (input: OperationInput<'inspectSetups'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'inspectSetups'>, SessionError>;
  readonly incomingChanges: (input: OperationInput<'incomingChanges'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'incomingChanges'>, SessionError>;
  readonly prepareTrustRequest: (input: OperationInput<'prepareTrustRequest'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'prepareTrustRequest'>, SessionError>;
  readonly inspectUpdates: (input: OperationInput<'inspectUpdates'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'inspectUpdates'>, SessionError>;
  readonly inspectIntent: (input: OperationInput<'inspectIntent'>) => Effect.Effect<import('../operations/index.ts').OperationOutput<'inspectIntent'>, SessionError>;
  readonly resolveSkillCandidate: (input: OperationInput<'resolveSkillCandidate'>) => Effect.Effect<SkillCandidateResult, SessionError>;
  readonly onProgress: (listener: (runId: string, progress: RunProgress) => void) => () => void;
  // Runs a job now and answers what it inspected, with its status. Clears the reconcile preview.
  readonly inspect: (actor: Client) => Effect.Effect<InspectResult & { readonly status: WireStatus }, SessionError>;
  readonly preview: (exclude: ReadonlyArray<string>) => Effect.Effect<PreviewResult, SessionError>;
  readonly previewChange: (change: OperationChange) => Effect.Effect<ChangePreview, SessionError>;
  // Answers `started` and runs in the background, or `stale` with a new preview. The run's events
  // start once this resolves, so a caller that writes its reply synchronously on resolving, before
  // yielding, sends the reply first. The terminal event comes after apply.lock is released. A
  // throwing `emit` is logged to stderr and never reaches the run.
  readonly apply: (planId: string, actor: Client, emit: (runId: string, progress: RunProgress) => void) => Effect.Effect<ApplyResult, SessionError>;
  // Stops the active run and waits for it to settle. Answers whether one was running.
  readonly cancel: Effect.Effect<boolean>;
  readonly running: Effect.Effect<boolean>;
};

type Previewed = { readonly planId: string; readonly exclude: ReadonlyArray<string>; readonly plan: Plan; readonly generation: number; readonly change: ReconcileChange; readonly exactSelection: boolean; readonly instructionEvidence: ReadonlyMap<string, string>; readonly baselineDigest: string };
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

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

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
export const makeSession = (handle: AgentHandle, options: { readonly signal: AbortSignal; readonly domains: AgentDomains; readonly skillCandidates?: Parameters<typeof makeSkillOperations>[0]['readCandidates']; readonly skillVerification?: Parameters<typeof makeAdditionDriver>[3] }) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<AgentServices | SetupSource>();
    const configuredPaths = yield* MachinePaths;
    const { repo, stateRoot } = configuredPaths;
    const installer = yield* AgentSkillInstaller;
    const fs = yield* Fs;
    // Runs live in a child scope, closed after the abort below: finalizers run in reverse.
    const runs = yield* Scope.fork(yield* Effect.scope);
    const closing = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => closing.abort()));
    const shutdown = AbortSignal.any([options.signal, closing.signal]);

    const skillOperations = yield* makeSkillOperations({ inspection: handle.inspection, generation: handle.generation ?? Effect.succeed(0), ...(options.skillCandidates ? { readCandidates: options.skillCandidates } : {}) });
    yield* Effect.addFinalizer(() => Effect.sync(skillOperations.clear));
    const resolveSkillCandidate: AgentSession['resolveSkillCandidate'] = input => skillOperations.resolveSkillCandidate(input).pipe(Effect.mapError(e => new SessionError(e.code, e.message)));

    const intentOperations = yield* makeIntentOperations({ inspection: handle.inspection, generation: handle.generation ?? Effect.succeed(0),
      freshInspection: (handle.freshInspection ?? runJob(options.domains, { inspectOnly: true })).pipe(Effect.map(job => job.inspection), Effect.provideContext(context)), invalidate: skillOperations.clear });

    let previewed: Previewed | undefined;
    let active: Active | undefined;
    const clock = yield* AgentClock;
    const parityPlans = new Map<string, { prepared: PreparedParityChange; expires: number }>();
    yield* Effect.addFinalizer(() => Effect.sync(() => parityPlans.clear()));
    const retainedParity = (planId: string) => Effect.gen(function* () {
      const now = (yield* clock.now).getTime();
      const generation = String(yield* (handle.generation ?? Effect.succeed(0)));
      for (const [id, item] of parityPlans) if (item.expires <= now || item.prepared.acceptance.generation !== generation) parityPlans.delete(id);
      return parityPlans.get(planId)?.prepared;
    });
    const retainPrepared = (prepared: PreparedParityChange, replacing = false) => Effect.gen(function* () {
      if (active && !replacing) return yield* Effect.fail(busy);
      yield* retainedParity('');
      if (prepared.preview.scope.kind !== 'machine' || prepared.preview.change.kind !== prepared.acceptance.kind || prepared.preview.generation !== prepared.acceptance.generation
        || prepared.acceptance.generation !== String(yield* (handle.generation ?? Effect.succeed(0)))
        || prepared.acceptance.planDigest !== digest(prepared.preview.plan)
        || canonical(prepared.acceptance.plannedKeys) !== canonical(prepared.preview.plan.steps.map(step => step.key)))
        return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'Prepared operation does not match its acceptance'));
      if (parityPlans.size >= 32) parityPlans.delete(parityPlans.keys().next().value!);
      const retained = { ...prepared, preview: structuredClone(prepared.preview), acceptance: structuredClone(prepared.acceptance) };
      parityPlans.set(prepared.preview.planId, { prepared: retained, expires: (yield* clock.now).getTime() + 600_000 });
      return structuredClone(retained.preview);
    });

    const retainParityChange: AgentSession['retainParityChange'] = prepared => retainPrepared(prepared);

    const inspect: AgentSession['inspect'] = () =>
      Effect.gen(function* () {
        if (active) return yield* Effect.fail(busy);
        const status = yield* handle.request('inspect');
        const inspection = yield* handle.inspection;
        previewed = undefined; parityPlans.clear();
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
          generation: yield* (handle.generation ?? Effect.succeed(0)), baselineDigest: digest(inspection.desired), change: selected, exactSelection: change !== undefined, instructionEvidence: instructionEvidence(inspection.report, selected.only),
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
    const prepareAction = (change: import('../operations/index.ts').ActionChange | Extract<import('../operations/index.ts').OperationChange, { kind: 'capture' | 'update' | 'sourceDecision' }>, inspection: JobInspection) => Effect.gen(function* () {
      const sourceGeneration = yield* (handle.generation ?? Effect.succeed(0));
      const setup = change.kind === 'sourceDecision' && handle.selectOperationSetup ? yield* handle.selectOperationSetup('local').pipe(Effect.mapError(() => new SessionError('APP_UNAVAILABLE', 'Configured source trust is unavailable'))) : undefined;
      if (setup && !setup.trusted) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE', 'Trust this repository in the app before editing source policy'));
      const setupIdentity = JSON.stringify(setup);
      const prepared = yield* (change.kind === 'sourceDecision' ? prepareSourceDecision(change, inspection, configuredPaths) : change.kind === 'update' ? prepareUpdateChange(change, inspection, configuredPaths) : change.kind === 'capture' ? prepareCaptureChange(change, inspection, configuredPaths) : prepareActionChange(change, inspection, options.domains)).pipe(Effect.provideContext(context));
      const generation = String(yield* (handle.generation ?? Effect.succeed(0)));
      if (change.kind === 'sourceDecision' && (generation !== String(sourceGeneration) || (yield* handle.inspection) !== inspection)) return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Source observation changed; inspect again'));
      return { ...prepared, preview: { ...prepared.preview, generation }, acceptance: { ...prepared.acceptance, generation },
        execute: (lifecycle: RunLifecycle, signal: AbortSignal) => {
          const successful = new Set<string>();
          return prepared.execute({ ...lifecycle, progress: event => {
            if (event.type === 'finished' && event.outcome === 'ok') successful.add(event.key);
            return lifecycle.progress(event);
          } }, signal).pipe(Effect.onExit(() => change.kind === 'reconcile' && handle.afterPerson
            ? handle.afterPerson(inspection, [...successful].flatMap(key => {
              const id = itemIdOf(key, inspection.desired);
              if (id) return [id];
              return prepared.preview.plan.steps.filter(step => step.key === key).flatMap(step => step.touches.filter(path => path.startsWith('skills/')).flatMap(path => {
                const skill = inspection.desired.skills.find(skill => skill.name === path.slice('skills/'.length));
                return skill ? [`skill:${skill.source}/${skill.name}`] : [];
              }));
            })).pipe(Effect.catchCause(() => Effect.void)) : Effect.void));
        },
        revalidate: Effect.gen(function* () {
          if (change.kind === 'sourceDecision' && handle.selectOperationSetup && JSON.stringify(yield* handle.selectOperationSetup('local')) !== setupIdentity) return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Configured source trust changed; inspect again'));
          const fresh = yield* (handle.freshInspection ?? runJob(options.domains, { inspectOnly: true })).pipe(Effect.provideContext(context));
          if (!fresh.inspection || canonical(fresh.inspection.desired) !== canonical(inspection.desired) || canonical(fresh.inspection.revision) !== canonical(inspection.revision))
            return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The setup changed; inspect and preview again'));
          yield* prepared.revalidate;
        }).pipe(Effect.mapError(error => error instanceof SessionError ? error : new SessionError('INSPECT_FAILED', 'Selected configuration could not be revalidated'))),
      };
    });

    const previewChange: AgentSession['previewChange'] = change => Effect.gen(function* () {
      const input = yield* Effect.try({
        try: () => decodeOperationInput('previewChange', { change }),
        catch: () => new SessionError('INVALID_REQUEST', 'Invalid change selection'),
      });
      if (input.change.kind === 'pruneBackups') {
        if (active) return yield* Effect.fail(busy);
        return yield* handle.exclusive(Effect.gen(function* () {
          const generation = yield* (handle.generation ?? Effect.succeed(0));
          const prepared = yield* prepareBackupOperation(generation).pipe(Effect.provideContext(context));
          if ((yield* (handle.generation ?? Effect.succeed(0))) !== generation)
            return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Backup observation changed'));
          return yield* retainParityChange(prepared);
        }));
      }
      if (isAccountChange(input.change)) {
        if(active)return yield* Effect.fail(busy);
        const change=input.change;
        return yield* handle.exclusive(Effect.gen(function*(){
          const generation=yield* (handle.generation??Effect.succeed(0));
          const prepared=yield* prepareAccountOperation(handle,change,generation).pipe(Effect.provideContext(context));
          if((yield* (handle.generation??Effect.succeed(0)))!==generation)return yield* Effect.fail(new SessionError('UNKNOWN_PLAN','Account observation changed'));
          return yield* retainParityChange(prepared);
        }));
      }
      if (input.change.kind === 'syncDecision') {
        if (active) return yield* Effect.fail(busy);
        const change = input.change;
        return yield* handle.exclusive(Effect.gen(function* () {
          const generation = yield* (handle.generation ?? Effect.succeed(0));
          const prepared = yield* prepareSyncOperation(handle, change, generation).pipe(Effect.provideContext(context));
          if ((yield* (handle.generation ?? Effect.succeed(0))) !== generation)
            return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Sync observation changed'));
          return yield* retainParityChange(prepared);
        }));
      }
      if (input.change.kind === 'machineIntent') {
        if (active) return yield* Effect.fail(busy);
        return yield* retainParityChange(yield* intentOperations.prepare(input.change));
      }
      if (input.change.kind === 'addSkill') {
        if (active) return yield* Effect.fail(busy);
        return yield* skillOperations.previewAddSkill({ scope: input.scope, candidateId: input.change.candidateId, targets: input.change.targets }).pipe(Effect.mapError(e => new SessionError(e.code, e.message)));
      }
      if (active) return yield* Effect.fail(busy);
      const inspection = yield* handle.inspection;
      if (!inspection) return yield* Effect.fail(new SessionError('NO_REPORT', 'Inspect the machine before previewing'));
      return yield* retainParityChange(yield* prepareAction(input.change, inspection));
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
        const prepared = yield* retainedParity(planId);
        const addition = yield* skillOperations.acceptedPlan(planId);
        if ((prepared || addition) && !lifecycle) return yield* Effect.fail(new SessionError('INVALID_REQUEST', 'This operation requires durable applyChange'));
        const wanted = prepared ? { planId, generation: Number(prepared.acceptance.generation) } : addition ? { planId, generation: addition.generation } : previewed;
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
          if (prepared) {
            const validation = yield* Effect.exit(handle.withJobMutation(Effect.gen(function* () {
              if (prepared.acceptance.generation !== String(yield* (handle.generation ?? Effect.succeed(0))))
                return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The setup changed; inspect and preview again'));
              yield* prepared.revalidate;
            }), false));
            if (Exit.isFailure(validation)) {
              const error = Cause.squash(validation.cause);
              if (prepared.acceptance.generation !== String(yield* (handle.generation ?? Effect.succeed(0)))
                || prepared.preview.change.kind !== 'reconcile' || !(error instanceof SessionError) || error.code !== 'UNKNOWN_PLAN')
                return yield* Effect.failCause(validation.cause);
              const job = yield* handle.withJobMutation(handle.freshInspection ?? runJob(options.domains, { inspectOnly: true }), false).pipe(Effect.provideContext(context), Effect.mapError(() => new SessionError('INSPECT_FAILED', 'Selected configuration could not be inspected')));
              if (!job.inspection) return yield* Effect.fail(new SessionError('NO_REPORT', 'Inspect the machine before previewing'));
              const replacement = yield* retainPrepared(yield* prepareAction(prepared.preview.change, job.inspection), true);
              return { status: 'stale' as const, planId: replacement.planId, plan: replacement.plan as WirePlan, preview: replacement };
            }
            const run = Effect.gen(function* () {
              const observer = yield* parityObserver(lifecycle!, prepared.acceptance);
              const observed: RunLifecycle = { ...lifecycle!, parity: update => observer.checkpoint(update) };
              const signal = AbortSignal.any([shutdown, abort.signal]);
              const exit = yield* Effect.exit(handle.withJobMutation(Effect.gen(function* () {
                if (signal.aborted) return;
                yield* observer.checkpoint({ state: 'needsInspection' });
                yield* prepared.execute(observed, signal);
              })));
              const evidence = observer.evidence();
              const incomplete = evidence.remainingKeys.length > 0;
              const checkpoint = yield* Effect.exit(observer.checkpoint({ state: Exit.isFailure(exit) ? 'needsInspection' : signal.aborted ? 'partial' : incomplete ? 'needsInspection' : 'committed' }));
              yield* release;
              const terminal = Exit.isFailure(exit) || Exit.isFailure(checkpoint) ? { type: 'failed' as const, message: 'Operation stopped; inspect before retrying' }
                : signal.aborted ? { type: 'cancelled' as const, remaining: [...evidence.remainingKeys] }
                : incomplete ? { type: 'failed' as const, message: 'Operation completion was not observed; inspect before retrying' }
                : { type: 'done' as const, ok: evidence.committedKeys.length, failed: 0 };
              yield* lifecycle!.finished(terminal).pipe(Effect.catch(() => Effect.void));
              yield* clear;
              emit(self.runId, terminal);
              if (prepared.afterRelease && !shutdown.aborted) yield* Effect.forkIn(handle.request(prepared.afterRelease), runs);
            }).pipe(Effect.provideContext(context));
            yield* Effect.uninterruptible(Effect.andThen(lifecycle!.accepted(prepared.preview.change, prepared.acceptance.plannedKeys, undefined, prepared.acceptance),
              Effect.forkIn(Effect.uninterruptible(Effect.andThen(Deferred.await(answered), run)), runs)).pipe(Effect.andThen(Effect.sync(() => { handedOff = true; parityPlans.clear(); }))));
            return { status: 'started' as const, runId: self.runId };
          }
          const job = yield* handle.exclusive(handle.freshInspection ?? runJob(options.domains, { inspectOnly: true })).pipe(
            Effect.provideContext(context),
            Effect.mapError((error) => new SessionError('INSPECT_FAILED', describe(error))),
          );
          const inspection = job.inspection;
          if (inspection === undefined) return yield* Effect.fail(noInspection(job.status));
          yield* validate(inspection);
          if (addition) {
            if (canonical(inspection.desired) !== canonical(addition.baseline)) return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The setup changed; inspect and preview again'));
            const freshPreview = yield* skillOperations.previewAddSkill({ scope: { kind: 'machine' }, candidateId: addition.preview.change.kind === 'addSkill' ? addition.preview.change.candidateId : '', targets: addition.preview.skillAddition!.installationTargets }).pipe(Effect.mapError(e => new SessionError(e.code, e.message)));
            const checked = (yield* skillOperations.acceptedPlan(freshPreview.planId))!;
            if (!samePlan(addition.plan, checked.plan) || canonical(addition.overrides) !== canonical(checked.overrides)
              || canonical(addition.preview.skillAddition) !== canonical(checked.preview.skillAddition)) return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The selected skill changed; inspect and preview again'));
            let invocation: AdditionInvocation | undefined;
            if (addition.plan.steps.length) {
              const command = yield* installer.prepare(inspection.paths, { source: addition.candidate.source, revision: addition.candidate.revision, selectorName: addition.candidate.selectorName, targets: addition.preview.skillAddition!.declaration.after.targets }).pipe(Effect.mapError(e => new SessionError(e.code, e.message)));
              const text = yield* fs.readText(skillLockPath(inspection.paths)).pipe(Effect.mapError(() => new SessionError('SKILL_INSTALL_UNAVAILABLE', 'Native skill lock cannot be read safely')));
              if (text !== undefined) yield* Effect.try({ try: () => {
                const lock = JSON.parse(text);
                if (!lock || lock.version !== 3 || !lock.skills || typeof lock.skills !== 'object' || Array.isArray(lock.skills)) throw new Error();
              }, catch: () => new SessionError('SKILL_INSTALL_UNAVAILABLE', 'Native skill lock version is incompatible; inspect it before installing') });
              invocation = { command, lockText: text };
            }
            const selected = additionRunPlan(addition.plan, addition.candidate.installedName);
            const run = execute(inspection, selected, self.runId, actor, AbortSignal.any([shutdown, abort.signal]), progress => emit(self.runId, progress), release, clear, lifecycle, addition, invocation);
            yield* Effect.uninterruptible(Effect.andThen(lifecycle!.accepted(addition.preview.change, selected.steps.map(step => step.key), acceptedSkillTuple(addition)),
              Effect.forkIn(Effect.uninterruptible(Effect.andThen(Deferred.await(answered), run)), runs)).pipe(Effect.andThen(Effect.sync(() => { handedOff = true; parityPlans.clear(); }))));
            return { status: 'started' as const, runId: self.runId };
          }
          const reconcile = wanted as Previewed;
          if (reconcile.exactSelection) {
            const available = new Set(inspection.report.items.map(item => item.key));
            if (reconcile.change.only.some(key => !available.has(key))) {
              return yield* Effect.fail(new SessionError('UNKNOWN_KEY', 'The selected items changed; inspect and preview again'));
            }
          }
          const fresh = planFor(inspection, reconcile.exclude, reconcile.exactSelection ? reconcile.change.only : undefined);
          const evidence = instructionEvidence(inspection.report, reconcile.change.only);
          if (reconcile.baselineDigest !== digest(inspection.desired) || !samePlan(reconcile.plan, fresh) || !sameInstructionEvidence(reconcile.instructionEvidence, evidence)) {
            const next: Previewed = { ...reconcile, planId: randomUUID(), baselineDigest: digest(inspection.desired), plan: fresh, instructionEvidence: evidence, generation: yield* (handle.generation ?? Effect.succeed(0)) };
            previewed = next;
            const stale = { status: 'stale' as const, planId: next.planId, plan: wirePlan(fresh), preview: operationPreview(next) };
            return stale;
          }
          const acceptance: ParityAcceptance = { kind: 'reconcile', generation: String(reconcile.generation), baselineDigest: reconcile.baselineDigest, planDigest: digest(wirePlan(fresh)), plannedKeys: fresh.steps.map(step => step.key) };
          const runId = self.runId;
          const run = execute(inspection, fresh, runId, actor, AbortSignal.any([shutdown, abort.signal]), (progress) => emit(runId, progress), release, clear, lifecycle, undefined, undefined, acceptance);
          // Forked and handed off as one step, so an interruption either starts the run or settles.
          yield* Effect.uninterruptible(Effect.suspend(() =>
            Effect.andThen(lifecycle?.accepted(reconcile.change, fresh.steps.map(step => step.key), undefined, acceptance) ?? Effect.void, Effect.forkIn(Effect.uninterruptible(Effect.andThen(Deferred.await(answered), run)), runs)).pipe(
              Effect.andThen(Effect.sync(() => { handedOff = true; previewed = undefined; parityPlans.clear(); })),
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
      emit: (progress: RunProgress) => void, release: Effect.Effect<void>, clear: Effect.Effect<void>, lifecycle?: RunLifecycle, addition?: AcceptedSkillPlan, invocation?: AdditionInvocation, acceptance?: ParityAcceptance,
    ) =>
      Effect.gen(function* () {
        const now = yield* (yield* AgentClock).now;
        let terminal: RunProgress | undefined;
        const parity = lifecycle && acceptance ? yield* parityObserver(lifecycle, acceptance) : undefined;
        const onProgress = (progress: Progress) => Effect.sync(() => {
          const wire = wireProgress(progress);
          if (wire.type === 'done' || wire.type === 'cancelled') terminal = wire;
          else emit(wire);
        });
        const driver = addition && lifecycle ? yield* makeAdditionDriver(addition, lifecycle,
          handle.exclusive(handle.freshInspection ?? runJob(options.domains, { inspectOnly: true })).pipe(Effect.flatMap(job => job.inspection ? Effect.succeed(job.inspection) : Effect.fail(noInspection(job.status))), Effect.provideContext(context)), options.skillVerification, invocation) : undefined;
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const backups = yield* Backups;
            return yield* recordedRun(planned, inspection.report, driver ? [driver.domain] : inspection.domains, { runId, actor, automatic: false, signal, onProgress, checkpoint: lifecycle ? progress => Effect.gen(function* () {
              if (parity) {
                const folder = yield* backups.dir;
                const backupIds = folder ? [basename(folder)] : parity.evidence().backupIds;
                const evidence = parity.evidence();
                yield* parity.checkpoint({ backupIds, state: progress.type === 'started' ? 'needsInspection' : 'partial',
                  ...(progress.type === 'finished' && progress.outcome === 'ok' ? {
                    committedKeys: [...new Set([...evidence.committedKeys, progress.key])], remainingKeys: evidence.remainingKeys.filter(key => key !== progress.key),
                  } : {}) });
              }
              yield* lifecycle.progress(progress);
            }) : undefined,
            ...(lifecycle ? { operation: { operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId } as const } : {}) });
          }).pipe(
            Effect.provide(backupsForRun(now).pipe(Layer.provideMerge(machinePaths(inspection.paths)))),
          ),
        );
        if (parity) {
          const checkpoint = yield* Effect.exit(parity.checkpoint({ state: Exit.isFailure(exit) ? 'needsInspection' : terminal?.type === 'done' && terminal.failed === 0 ? 'committed' : 'partial' }));
          if (Exit.isFailure(checkpoint)) terminal = { type: 'failed', message: 'Operation progress could not be saved; inspect before retrying' };
        }
        if (Exit.isFailure(exit)) terminal = { type: 'failed', message: addition ? 'Skill addition was interrupted; inspect saved intent and partial installation before retrying' : describe(Cause.squash(exit.cause)) };
        if (driver && (Exit.isFailure(exit) || terminal?.type === 'cancelled' || (terminal?.type === 'done' && terminal.failed > 0))) {
          yield* driver.finish(Exit.isFailure(exit) ? 'needsInspection' : terminal?.type === 'cancelled' ? 'cancelled' : 'failed').pipe(Effect.catch(() => Effect.void));
        }
        if (!addition && handle.afterPerson && Exit.isSuccess(exit)) {
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
      now: clock.now,
      signInFlow: handle.signInFlow,
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
    const syncRead = <N extends 'inspectSetups' | 'incomingChanges' | 'prepareTrustRequest'>(
      name: N,
      input: OperationInput<N>,
    ) =>
      handle.exclusive(
        Effect.gen(function* () {
          const args = yield* Effect.try({
            try: () => decodeOperationInput(name, input),
            catch: () => new SessionError('INVALID_REQUEST', 'Invalid sync inspection'),
          });
          if (args.scope.kind !== 'machine')
            return yield* Effect.fail(new SessionError('UNSUPPORTED_SCOPE', 'Sync supports machine scope only'));
          const generation = yield* (handle.generation ?? Effect.succeed(0)),
            inspection = yield* handle.inspection;
          const unchanged = Effect.gen(function* () {
            if ((yield* (handle.generation ?? Effect.succeed(0))) !== generation || (yield* handle.inspection) !== inspection)
              return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Sync observation changed; inspect again'));
          });
          yield* unchanged;
          const result = yield* readSyncOperation(handle, name, args, generation).pipe(Effect.provideContext(context));
          yield* unchanged;
          return result;
        }),
      );
    const sourceCache=sourceReadCache();
    let sourceInspection:JobInspection|undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => { sourceCache.cursors.clear(); sourceCache.observations.clear(); }));
    const sourceRead = <N extends SourceOperation>(name:N,input:OperationInput<N>) => handle.exclusive(Effect.gen(function* () {
      const generation=yield* (handle.generation ?? Effect.succeed(0));
      const inspection=yield* handle.inspection;
      if(sourceInspection!==inspection) { sourceCache.cursors.clear(); sourceCache.observations.clear(); sourceInspection=inspection; }
      const setup=handle.selectOperationSetup ? yield* handle.selectOperationSetup('local').pipe(Effect.mapError(() => new SessionError('APP_UNAVAILABLE','Configured source trust is unavailable'))) : undefined;
      if(setup && !setup.trusted) return yield* Effect.fail(new SessionError('APP_UNAVAILABLE','Open the app repository trust action before reading sources'));
      const setupIdentity=JSON.stringify(setup && {setupId:setup.setupId,accountId:setup.accountId,repository:setup.repository,trusted:setup.trusted});
      const unchanged=Effect.gen(function* () {
        const current=handle.selectOperationSetup ? yield* handle.selectOperationSetup('local').pipe(Effect.mapError(() => new SessionError('APP_UNAVAILABLE','Configured source trust is unavailable'))) : undefined;
        if(setupIdentity!==JSON.stringify(current && {setupId:current.setupId,accountId:current.accountId,repository:current.repository,trusted:current.trusted})) return yield* Effect.fail(new SessionError('UNKNOWN_PLAN','Configured source trust changed; inspect again'));
        if((yield* (handle.generation ?? Effect.succeed(0)))!==generation || (yield* handle.inspection)!==inspection)
          return yield* Effect.fail(new SessionError('UNKNOWN_PLAN','Source observation changed; inspect again'));
      });
      yield* unchanged;
      const result=yield* readSourceOperation(name,input,inspection,generation,sourceCache,setup?.repository).pipe(Effect.provideContext(context));
      yield* unchanged;
      return result;
    }));
    const accountRead = <N extends 'agentStatus'|'accountState'>(name:N,input:OperationInput<N>) => handle.exclusive(Effect.gen(function*(){
      const generation=yield* (handle.generation??Effect.succeed(0)),inspection=yield* handle.inspection;
      const result=yield* readAccountOperation(handle,name,input,generation).pipe(Effect.provideContext(context));
      if((yield* (handle.generation??Effect.succeed(0)))!==generation || (yield* handle.inspection)!==inspection)return yield* Effect.fail(new SessionError('UNKNOWN_PLAN','Account observation changed; inspect again'));
      return result;
    }));
    const session: AgentSession = {
      listBackups: input => handle.exclusive(Effect.gen(function* () {
        const generation = yield* (handle.generation ?? Effect.succeed(0)), inspection = yield* handle.inspection;
        const result = yield* readBackupOperation(input, generation).pipe(Effect.provideContext(context));
        if ((yield* (handle.generation ?? Effect.succeed(0))) !== generation || (yield* handle.inspection) !== inspection)
          return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'Backup observation changed'));
        return result;
      })),
      agentStatus: input=>accountRead('agentStatus',input),
      accountState: input=>accountRead('accountState',input),
      watchSources: input => sourceRead('watchSources',input),
      inspectSourceDiff: input => sourceRead('inspectSourceDiff',input),
      pinImpact: input => sourceRead('pinImpact',input),
      draftChangelog: input => sourceRead('draftChangelog',input),
      inspectSetups: input => syncRead('inspectSetups', input),
      incomingChanges: input => syncRead('incomingChanges', input),
      prepareTrustRequest: input => syncRead('prepareTrustRequest', input),
      runs: agentRuns, skillOperations, resolveSkillCandidate, retainParityChange, inspectUpdates: input => handle.exclusive(Effect.gen(function* () {
        const generation = yield* (handle.generation ?? Effect.succeed(0));
        const inspection = yield* handle.inspection;
        const unchanged = Effect.gen(function* () {
          if ((yield* (handle.generation ?? Effect.succeed(0))) !== generation || (yield* handle.inspection) !== inspection)
            return yield* Effect.fail(new SessionError('UNKNOWN_PLAN', 'The update inspection changed; inspect again'));
        });
        yield* unchanged;
        const result = yield* inspectUpdateOperations(inspection,generation,input).pipe(Effect.provideContext(context));
        yield* unchanged;
        return result;
      })), inspectIntent: intentOperations.inspectIntent,
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
