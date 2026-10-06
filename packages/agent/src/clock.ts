import { Context, Duration, Effect, Layer } from 'effect';

// The agent's time, injected so the timer and wake detection run on a scripted clock in tests.
export class AgentClock extends Context.Service<
  AgentClock,
  {
    readonly now: Effect.Effect<Date>;
    readonly sleep: (ms: number) => Effect.Effect<void>;
    // In [0, 1): the timer's jitter.
    readonly random: Effect.Effect<number>;
  }
>()('agent/AgentClock') {}

export const systemClock = Layer.succeed(AgentClock, {
  now: Effect.sync(() => new Date()),
  sleep: (ms: number) => Effect.sleep(Duration.millis(ms)),
  random: Effect.sync(() => Math.random()),
});
