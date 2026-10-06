import { Deferred, Effect, Queue } from 'effect';
import { AgentClock } from './clock.ts';

// What can start a job. Hosted sync (P3) and #43's "the fetch moved the setup" add theirs later;
// for now every job fetches, so the timer also paces local-only fetching.
export type Trigger = 'start' | 'timer' | 'wake' | 'inspect' | 'decide' | 'resume' | 'policy';

export const PERIOD_MS = 60 * 60 * 1000;

// The next timer delay: the period ±10%, from `random` in [0, 1).
export const jittered = (random: number, period = PERIOD_MS): number => Math.round(period * (0.9 + 0.2 * random));

// A wall-clock jump of more than twice the period between ticks means the machine slept.
export const tickKind = (previous: number, now: number, period = PERIOD_MS): 'timer' | 'wake' =>
  now - previous > 2 * period ? 'wake' : 'timer';

type Request<A> = { readonly trigger: Trigger; readonly done?: Deferred.Deferred<A> };

export type Scheduler<A, R> = {
  readonly trigger: (trigger: Trigger) => Effect.Effect<void>;
  // Triggers a job and answers with the result of the job that included the trigger.
  readonly request: (trigger: Trigger) => Effect.Effect<A>;
  // Runs jobs forever, one at a time: everything queued while a job runs becomes one follow-up job.
  readonly run: Effect.Effect<never, never, R>;
};

export const makeScheduler = <A, R>(job: (triggers: ReadonlyArray<Trigger>) => Effect.Effect<A, never, R>) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Request<A>>();
    const scheduler: Scheduler<A, R> = {
      trigger: (trigger: Trigger) => Effect.asVoid(Queue.offer(queue, { trigger })),
      request: (trigger: Trigger) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<A>();
          yield* Queue.offer(queue, { trigger, done });
          return yield* Deferred.await(done);
        }),
      run: Effect.forever(Effect.gen(function* () {
        const batch = yield* Queue.takeAll(queue);
        const result = yield* job(batch.map((r) => r.trigger));
        for (const r of batch) if (r.done) yield* Deferred.succeed(r.done, result);
      })),
    };
    return scheduler;
  });

// Offers `timer` every period ±10%, or `wake` when the wall clock jumped past twice the period.
export const timerLoop = (offer: (trigger: Trigger) => Effect.Effect<void>, period = PERIOD_MS): Effect.Effect<void, never, AgentClock> =>
  Effect.gen(function* () {
    const clock = yield* AgentClock;
    let last = (yield* clock.now).getTime();
    while (true) {
      yield* clock.sleep(jittered(yield* clock.random, period));
      const now = (yield* clock.now).getTime();
      yield* offer(tickKind(last, now, period));
      last = now;
    }
  });
