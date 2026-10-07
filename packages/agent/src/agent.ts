import { join } from 'node:path';
import { Cause, Effect, Layer, Ref } from 'effect';
import {
  acquirePidLock, type Actor, type Decision, type DecisionsInvalid, type DecisionsStore, type FsFailed, type HistoryStore, type MachinePathsValue,
} from '@nortuscc/machine';
import { AgentClock } from './clock.ts';
import { failedStatus, runJob, type AgentStatus, type JobInspection, type JobResult } from './job.ts';
import { agentLayer, type AgentDomains } from './layer.ts';
import { serveIpc } from './ipc/server.ts';
import { makeSession } from './ipc/session.ts';
import { resume } from './pause.ts';
import { changePolicy, recordDecision } from './policy.ts';
import { makeScheduler, timerLoop, type Trigger } from './scheduler.ts';
import type { SetupSource } from '@nortuscc/sync';
import type { AgentStateStore, Policy } from './state.ts';

// What #78's IPC handlers and the CLI's agent commands call. Each change answers with the status
// of the job that ran after it. `inspection` is what the latest job inspected, if it got that far.
export type AgentHandle = {
  readonly status: Effect.Effect<AgentStatus | undefined>;
  readonly inspection: Effect.Effect<JobInspection | undefined>;
  readonly request: (trigger: Trigger) => Effect.Effect<AgentStatus>;
  readonly decide: (decision: Decision, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | DecisionsInvalid>;
  // Records each decision in turn, then runs one job for them all.
  readonly decideAll: (decisions: ReadonlyArray<Decision>, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | DecisionsInvalid>;
  readonly resume: (actor: Actor) => Effect.Effect<AgentStatus, FsFailed>;
  readonly setPolicy: (policy: Policy, actor: Actor) => Effect.Effect<AgentStatus, FsFailed>;
  // Calls `listener` with each job's status once it is the latest; answers the unsubscribe. It runs
  // before the job's requests are answered, so it is not ordered relative to their replies.
  readonly onStatus: (listener: (status: AgentStatus) => void) => () => void;
};

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : String(error);
};

// Starts the scheduler and the timer in the current scope and queues the start job. It never
// changes trust: until a person runs trustOwnSetup, every job inspects for drift only. Closing the
// scope (or aborting `signal`) cancels an in-flight auto-apply, which still records how it ended.
export const startAgent = (domains: AgentDomains, options: { readonly signal?: AbortSignal } = {}) =>
  Effect.gen(function* () {
    const clock = yield* AgentClock;
    const latest = yield* Ref.make<AgentStatus | undefined>(undefined);
    const inspection = yield* Ref.make<JobInspection | undefined>(undefined);
    const listeners = new Set<(status: AgentStatus) => void>();
    const shutdown = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    const job = (_triggers: ReadonlyArray<Trigger>) =>
      runJob(domains, { signal }).pipe(
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
        Effect.map((result) => result.status),
      );
    const scheduler = yield* makeScheduler(job);
    yield* Effect.forkScoped(scheduler.run);
    yield* Effect.forkScoped(timerLoop(scheduler.trigger));
    // Finalizers run in reverse: the abort runs before the loop is interrupted, so a running apply
    // stops at its next step and records `cancelled` instead of being cut off mid-run.
    yield* Effect.addFinalizer(() => Effect.sync(() => shutdown.abort()));
    yield* scheduler.trigger('start');

    const context = yield* Effect.context<AgentStateStore | HistoryStore | DecisionsStore>();
    const withServices = <A, E>(effect: Effect.Effect<A, E, AgentStateStore | HistoryStore | DecisionsStore>) =>
      Effect.provideContext(effect, context);
    const handle: AgentHandle = {
      status: Ref.get(latest),
      inspection: Ref.get(inspection),
      request: scheduler.request,
      decide: (decision, actor) => withServices(recordDecision(decision, actor)).pipe(Effect.andThen(scheduler.request('decide'))),
      decideAll: (decisions, actor) =>
        withServices(Effect.forEach(decisions, (d) => recordDecision(d, actor), { discard: true })).pipe(Effect.andThen(scheduler.request('decide'))),
      resume: (actor) => withServices(resume(actor)).pipe(Effect.andThen(scheduler.request('resume'))),
      setPolicy: (policy, actor) => withServices(changePolicy(policy, actor)).pipe(Effect.andThen(scheduler.request('policy'))),
      onStatus: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
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

// The service's entry point (#79 runs it): builds every service from `paths` and runs until
// interrupted, `signal` aborts or, with `ipc`, a client sends `shutdown`; each closes the agent,
// cancelling an in-flight auto-apply. A pid lock makes it the only agent per state root: a second
// fails LockHeld before touching state or the socket. The caller builds the per-job `domains`
// factory and `source` at the same boundary as `paths`, and decides `ipc` (default off).
export const runAgent = (input: {
  readonly paths: MachinePathsValue;
  readonly domains: AgentDomains;
  readonly source: Layer.Layer<SetupSource>;
  readonly agentVersion: string;
  readonly ipc?: boolean;
  readonly signal?: AbortSignal;
}) =>
  Effect.scoped(Effect.gen(function* () {
    // The lock comes first: serveIpc replaces a leftover socket, which is only safe while it is held.
    yield* acquirePidLock(join(input.paths.stateRoot, 'agent', 'agent.lock'));
    const shutdown = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, shutdown.signal]) : shutdown.signal;
    const handle = yield* startAgent(input.domains, { signal });
    if (input.ipc) {
      const session = yield* makeSession(handle, { signal, domains: input.domains });
      yield* serveIpc({ paths: input.paths, handle, session, agentVersion: input.agentVersion, onShutdown: () => shutdown.abort() });
    }
    yield* untilAborted(signal);
  })).pipe(Effect.provide(Layer.merge(agentLayer(input.paths), input.source)));
