import { Cause, Effect, Layer, Ref } from 'effect';
import {
  type Actor, type Decision, type DecisionsInvalid, type DecisionsStore, type FsFailed, type HistoryStore, type MachinePathsValue,
} from '@nortuscc/machine';
import { AgentClock } from './clock.ts';
import { failedStatus, runJob, type AgentStatus } from './job.ts';
import { agentLayer, type AgentDomain } from './layer.ts';
import { resume } from './pause.ts';
import { changePolicy, recordDecision } from './policy.ts';
import { makeScheduler, timerLoop, type Trigger } from './scheduler.ts';
import { ensureOwnSetup } from './setups.ts';
import type { SetupSource } from '@nortuscc/sync';
import type { AgentStateStore, Policy } from './state.ts';

// What #78's IPC handlers and the CLI's agent commands call. Each change answers with the status
// of the job that ran after it.
export type AgentHandle = {
  readonly status: Effect.Effect<AgentStatus | undefined>;
  readonly request: (trigger: Trigger) => Effect.Effect<AgentStatus>;
  readonly decide: (decision: Decision, actor: Actor) => Effect.Effect<AgentStatus, FsFailed | DecisionsInvalid>;
  readonly resume: (actor: Actor) => Effect.Effect<AgentStatus, FsFailed>;
  readonly setPolicy: (policy: Policy, actor: Actor) => Effect.Effect<AgentStatus, FsFailed>;
};

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : String(error);
};

// Starts the scheduler and the timer in the current scope and queues the start job. Closing the
// scope (or aborting `signal`) cancels an in-flight auto-apply, which still records how it ended.
export const startAgent = (domains: ReadonlyArray<AgentDomain>, options: { readonly signal?: AbortSignal } = {}) =>
  Effect.gen(function* () {
    yield* ensureOwnSetup('agent');
    const clock = yield* AgentClock;
    const latest = yield* Ref.make<AgentStatus | undefined>(undefined);
    const shutdown = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
    const job = (_triggers: ReadonlyArray<Trigger>) =>
      runJob(domains, { signal }).pipe(
        // A failed job is reported, never fatal: the loop must survive failures and defects alike.
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            return failedStatus((yield* clock.now).toISOString(), yield* Ref.get(latest), describe(cause));
          })),
        Effect.tap((status) => Ref.set(latest, status)),
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
      request: scheduler.request,
      decide: (decision, actor) => withServices(recordDecision(decision, actor)).pipe(Effect.andThen(scheduler.request('decide'))),
      resume: (actor) => withServices(resume(actor)).pipe(Effect.andThen(scheduler.request('resume'))),
      setPolicy: (policy, actor) => withServices(changePolicy(policy, actor)).pipe(Effect.andThen(scheduler.request('policy'))),
    };
    return handle;
  });

// Completes when `signal` aborts; never without one.
const untilAborted = (signal?: AbortSignal): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.callback<void>((resume) => {
      if (signal.aborted) return resume(Effect.void);
      const onAbort = () => resume(Effect.void);
      signal.addEventListener('abort', onAbort, { once: true });
      return Effect.sync(() => signal.removeEventListener('abort', onAbort));
    });

// The service's entry point (#79 runs it): builds every service from `paths` and runs until
// interrupted or `signal` aborts; either closes the agent, cancelling an in-flight auto-apply.
// The caller builds `domains` and `source` at the same boundary as `paths`.
export const runAgent = (input: {
  readonly paths: MachinePathsValue;
  readonly domains: ReadonlyArray<AgentDomain>;
  readonly source: Layer.Layer<SetupSource>;
  readonly signal?: AbortSignal;
}) =>
  Effect.scoped(Effect.andThen(startAgent(input.domains, { signal: input.signal }), untilAborted(input.signal))).pipe(
    Effect.provide(Layer.merge(agentLayer(input.paths), input.source)),
  );
