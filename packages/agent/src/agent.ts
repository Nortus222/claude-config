import { join } from 'node:path';
import { Cause, Effect, Exit, Layer, Ref, Semaphore } from 'effect';
import {
  acquireApplyLock, MachinePaths, acquirePidLock, type Actor, type Decision, type DecisionsInvalid, type DecisionsStore, type FsFailed, type HistoryStore, type MachinePathsValue, type Processes,
} from '@nortuscc/machine';
import { AgentClock } from './clock.ts';
import { failedStatus, runJob, type AgentStatus, type JobInspection, type JobResult } from './job.ts';
import { agentLayer, type AgentDomains } from './layer.ts';
import { serveIpc } from './ipc/server.ts';
import { SessionError, makeSession } from './ipc/session.ts';
import { captureAgentOutput, startAgentLogRotation, type AgentLogOutput } from './log.ts';
import { makeNotifier } from './notifier.ts';
import { resume } from './pause.ts';
import { changePolicy, recordDecision } from './policy.ts';
import { makeScheduler, timerLoop, type Trigger } from './scheduler.ts';
import type { SetupSource } from '@nortuscc/sync';
import { configuredHostedRuntime, type HostedRuntime, type HostedOptions } from './hosted.ts';
import { HostedFailure, type SignInStarted } from '@nortuscc/hosted-client';
import type { AgentStateStore, Policy } from './state.ts';

// What #78's IPC handlers and the CLI's agent commands call. Each change answers with the status
// of the job that ran after it. `inspection` is what the latest job inspected, if it got that far.
export type AgentHandle = {
  readonly status: Effect.Effect<AgentStatus | undefined>;
  readonly generation?: Effect.Effect<number>;
  readonly freshInspection?: Effect.Effect<JobResult, unknown>;
  readonly afterPerson?: HostedRuntime['afterPerson'];
  readonly hosted?: {
    readonly state: HostedRuntime['state'];
    readonly signIn: (name?: string, reportStatus?: boolean) => Effect.Effect<SignInStarted, HostedFailure | SessionError>;
    readonly signOut: () => Effect.Effect<void, unknown>;
    readonly sync: () => Effect.Effect<void, unknown>;
    readonly trust: (id: string, actor: Actor) => Effect.Effect<void, unknown>;
    readonly machine: (patch: Parameters<HostedRuntime['machine']>[0], actor: Actor) => Effect.Effect<void, unknown>;
  };
  readonly inspection: Effect.Effect<JobInspection | undefined>;
  readonly request: (trigger: Trigger) => Effect.Effect<AgentStatus>;
  readonly decide: (decision: Decision, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | DecisionsInvalid | HostedFailure | SessionError>;
  // Records each decision in turn, then runs one job for them all.
  readonly decideAll: (decisions: ReadonlyArray<Decision>, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | DecisionsInvalid | HostedFailure | SessionError>;
  readonly resume: (actor: Actor) => Effect.Effect<AgentStatus, FsFailed | HostedFailure | SessionError>;
  readonly setPolicy: (policy: Policy, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | HostedFailure | SessionError>;
  // Calls `listener` with each job's status once it is the latest; answers the unsubscribe. It runs
  // before the job's requests are answered, so it is not ordered relative to their replies.
  readonly onStatus: (listener: (status: AgentStatus) => void) => () => void;
  // Runs `effect` while no scheduled job runs, holding the next one back until it ends, so a job
  // run outside the scheduler never overlaps one.
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : String(error);
};

// Starts the scheduler and timer in the current scope, queuing startup unless deferred. It never
// changes trust: until a person runs trustOwnSetup, every job inspects for drift only. Closing the
// scope (or aborting `signal`) cancels an in-flight auto-apply, which still records how it ended.
// `onStatus` is awaited after listeners and cannot fail a job; defer startup until IPC is attached.
export const startAgent = (domains: AgentDomains, options: { readonly signal?: AbortSignal; readonly deferStart?: boolean; readonly hosted?: HostedRuntime; readonly onStatus?: (status: AgentStatus) => Effect.Effect<void> } = {}) =>
  Effect.gen(function* () {
    const clock = yield* AgentClock;
    const latest = yield* Ref.make<AgentStatus | undefined>(undefined);
    const inspection = yield* Ref.make<JobInspection | undefined>(undefined);
    const listeners = new Set<(status: AgentStatus) => void>();
    const shutdown = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    // One job at a time, scheduled or not. A scheduled auto-apply that finds apply.lock held skips
    // rather than waits, so a holder of apply.lock may wait here without a cycle.
    const jobs = yield* Semaphore.make(1);
    const job = (_triggers: ReadonlyArray<Trigger>) =>
      jobs.withPermit((options.hosted?.runJobs ?? runJob(domains, { signal })).pipe(
        // A failed job is reported, never fatal: the loop must survive failures and defects alike.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failed: JobResult = { status: failedStatus((yield* clock.now).toISOString(), yield* Ref.get(latest), describe(cause)) };
            return failed;
          })),
        // The inspection always belongs to the latest status: a job that inspected nothing clears it.
        Effect.tap((result) => Effect.andThen(Ref.set(latest, result.status), Ref.set(inspection, result.inspection))),
        // A listener's failure must not break the loop.
        Effect.tap((result) => Effect.sync(() => {
          for (const listener of listeners) {
            try {
              listener(result.status);
            } catch {}
          }
        })),
        Effect.tap((result) => options.onStatus === undefined ? Effect.void : Effect.suspend(() => options.onStatus!(result.status)).pipe(Effect.catchCause(() => Effect.void))),
        Effect.map((result) => result.status),
      ));
    const scheduler = yield* makeScheduler(job);
    yield* Effect.forkScoped(scheduler.run);
    yield* Effect.forkScoped(timerLoop(scheduler.trigger));
    // Finalizers run in reverse: the abort runs before the loop is interrupted, so a running apply
    // stops at its next step and records `cancelled` instead of being cut off mid-run.
    yield* Effect.addFinalizer(() => Effect.sync(() => shutdown.abort()));
    if (!options.deferStart) yield* scheduler.trigger('start');

    const context = yield* Effect.context<AgentStateStore | HistoryStore | DecisionsStore>();
    const withServices = <A, E>(effect: Effect.Effect<A, E, AgentStateStore | HistoryStore | DecisionsStore>) =>
      Effect.provideContext(effect, context);
    const paths = yield* MachinePaths;
    let generation = 0;
    const mutation = <A, E>(effect: Effect.Effect<A, E>, invalidate = true) =>
      Effect.scoped(Effect.andThen(acquireApplyLock, jobs.withPermit(Effect.gen(function* () {
        if (invalidate) {
          if (options.hosted) generation++;
          yield* Ref.set(inspection, undefined);
        }
        return yield* effect;
      })))).pipe(Effect.provideService(MachinePaths, paths),
        Effect.catchTag('LockHeld', () => Effect.fail(new SessionError('BUSY', 'An apply is running'))),
        Effect.catchTag('MaintenancePending', () => Effect.fail(new SessionError('BUSY', 'Desktop update recovery is pending; open Claude Config before changing the machine'))));
    const hosted = options.hosted;
    const changes = (decisions: ReadonlyArray<Decision>, actor: Actor) => mutation(Effect.forEach(decisions, (decision): Effect.Effect<void, FsFailed | DecisionsInvalid | HostedFailure> =>
      decision.revision === null ? withServices(recordDecision(decision, actor))
        : hosted ? hosted.decide(decision, actor) : Effect.fail(new HostedFailure({ code: 'unauthenticated' })), { discard: true }));
    const handle: AgentHandle = {
      status: Ref.get(latest),
      inspection: Ref.get(inspection),
      request: scheduler.request,
      decide: (decision, actor) => changes([decision], actor).pipe(Effect.andThen(scheduler.request('decide'))),
      decideAll: (decisions, actor) =>
        changes(decisions, actor).pipe(Effect.andThen(scheduler.request('decide'))),
      resume: (actor) => mutation(withServices(resume(actor))).pipe(Effect.andThen(scheduler.request('resume'))),
      setPolicy: (policy, actor) => mutation(Effect.gen(function* () {
        if (hosted && (yield* hosted.state).accountId !== null) yield* hosted.machine({ policy }, actor);
        else yield* withServices(changePolicy(policy, actor));
      })).pipe(Effect.andThen(scheduler.request('policy'))),
      generation: Effect.gen(function* () { return generation + (hosted ? yield* hosted.generation : 0); }),
      ...(hosted ? {
        freshInspection: hosted.inspectPrimary,
        afterPerson: hosted.afterPerson,
        hosted: {
          state: hosted.state,
          signIn: (name?: string, reportStatus?: boolean) => mutation(hosted.signIn(name, reportStatus)),
          signOut: () => mutation(hosted.signOut()),
          sync: () => mutation(hosted.sync).pipe(Effect.andThen(scheduler.request('inspect')), Effect.asVoid),
          trust: (id: string, actor: Actor) => mutation(hosted.trust(id, actor)).pipe(Effect.andThen(scheduler.request('inspect')), Effect.asVoid),
          machine: (patch: Parameters<HostedRuntime['machine']>[0], actor: Actor) => mutation(hosted.machine(patch, actor)).pipe(Effect.andThen(scheduler.request('policy')), Effect.asVoid),
        },
      } : {}),
      onStatus: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      exclusive: (effect) => jobs.withPermit(effect),
    };
    if (hosted) yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
      const changed = (yield* hosted.due) ? yield* mutation(hosted.tick, false).pipe(Effect.catchCause(() => Effect.succeed(false))) : false;
      if (changed) { yield* Ref.set(inspection, undefined); yield* scheduler.trigger('inspect'); }
      // One-second maximum wake lets a new offline choice request prompt sync without bypassing retryAt.
      yield* clock.sleep(Math.min(1000, yield* hosted.wait));
    })));
    return handle;
  });

// Completes when `signal` aborts.
const untilAborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

export type AgentLifecyclePhase = 'lock' | 'log_rotation' | 'services' | 'scheduler' | 'session' | 'ipc' | 'first_job' | 'running' | 'shutdown' | 'ipc_closed' | 'stopped';
export type AgentLifecycleStatus = 'started' | 'completed' | 'failed' | 'cancelled';

// The service's entry point (#79 runs it): builds every service from `paths` and runs until
// interrupted, `signal` aborts or, with `ipc`, a client sends `shutdown`; each closes the agent,
// cancelling an in-flight auto-apply. A pid lock makes it the only agent per state root: a second
// fails LockHeld before touching state, logs or the socket. The caller builds the per-job `domains`
// factory and `source` at the same boundary as `paths`, and decides `ipc` (default off). Optional
// `logOutput` captures both streams after the lock; `onStarted` runs once logging is ready.
// `onLifecycle` observes fixed phase boundaries best effort; a thrown observer never changes the
// result. `stopped` runs after scoped cleanup, including IPC closure and pid-lock release.
export const runAgent = (input: {
  readonly paths: MachinePathsValue;
  readonly domains: AgentDomains;
  readonly source: Layer.Layer<SetupSource>;
  readonly agentVersion: string;
  readonly hosted?: HostedOptions;
  readonly clock?: Layer.Layer<AgentClock>;
  readonly processes?: Layer.Layer<Processes>;
  readonly ipc?: boolean;
  readonly notifications?: { readonly platform: string; readonly timeoutMs?: number };
  readonly logOutput?: AgentLogOutput;
  readonly onStarted?: () => void;
  readonly onLifecycle?: (phase: AgentLifecyclePhase, status: AgentLifecycleStatus) => void;
  readonly signal?: AbortSignal;
}) => {
  const observe = (phase: AgentLifecyclePhase, status: AgentLifecycleStatus) => Effect.sync(() => {
    try { input.onLifecycle?.(phase, status); } catch {}
  });
  const outcome = (exit: Exit.Exit<unknown, unknown>): AgentLifecycleStatus => Exit.isSuccess(exit) ? 'completed'
    : Cause.hasInterruptsOnly(exit.cause) ? 'cancelled' : 'failed';
  const phase = <A, E, R>(name: AgentLifecyclePhase, effect: Effect.Effect<A, E, R>) =>
    observe(name, 'started').pipe(Effect.andThen(effect), Effect.onExit((exit) => observe(name, outcome(exit))));
  return Effect.scoped(Effect.gen(function* () {
    // The lock comes first: logs and leftover sockets may only be changed by their owning agent.
    yield* phase('lock', acquirePidLock(join(input.paths.stateRoot, 'agent', 'agent.lock')));
    const logPath = join(input.paths.stateRoot, 'agent', 'agent.log');
    yield* phase('log_rotation', Effect.gen(function* () {
      if (input.logOutput) {
        const output = input.logOutput;
        yield* captureAgentOutput(logPath, output);
        // This finalizer runs before stream restoration, so a fatal exit remains in the log.
        yield* Effect.addFinalizer((exit) => Effect.sync(() => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            try { output.stderr.write(`Agent failed: ${describe(exit.cause)}\n`); } catch {}
          }
        }));
      }
      yield* startAgentLogRotation(logPath);
    }));
    if (input.onStarted) yield* Effect.sync(input.onStarted);
    const shutdown = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal;
    const { notifier, hosted } = yield* phase('services', Effect.gen(function* () {
      const notifier = input.notifications ? yield* makeNotifier(input.notifications) : undefined;
      const hosted = input.hosted ? yield* configuredHostedRuntime(input.paths, input.hosted, {
        domains: input.domains, signal, os: input.hosted.platform === 'darwin' ? 'macos' : input.hosted.platform === 'win32' ? 'windows' : 'linux',
      }) : undefined;
      return { notifier, hosted };
    }));
    const handle = yield* phase('scheduler', startAgent(input.domains, { signal, hosted, deferStart: true, onStatus: notifier?.notify }));
    if (input.ipc) {
      const session = yield* phase('session', makeSession(handle, { signal, domains: input.domains }));
      let ipcReady = false;
      // IPC finalizers register later and therefore finish before this observation; the scheduler
      // and pid lock close afterward. A failed initialization may never register file cleanup.
      yield* Effect.addFinalizer(() => ipcReady ? observe('ipc_closed', 'completed') : Effect.void);
      yield* phase('ipc', serveIpc({ paths: input.paths, handle, session, agentVersion: input.agentVersion, notifier, onShutdown: () => shutdown.abort() }));
      ipcReady = true;
    }
    yield* Effect.forkScoped(observe('first_job', 'started').pipe(Effect.andThen(handle.request('start')),
      Effect.onExit(exit => observe('first_job', Exit.isSuccess(exit) && exit.value.error !== undefined ? 'failed' : outcome(exit)))));
    yield* observe('running', 'started');
    yield* untilAborted(signal);
  }).pipe(Effect.onExit(() => observe('shutdown', 'started')))).pipe(
    Effect.provide(Layer.merge(agentLayer(input.paths, { processes: input.processes, clock: input.clock }), input.source)),
    Effect.onExit((exit) => observe('stopped', outcome(exit))),
  );
};
