import { dirname, join } from 'node:path';
import { Cause, Data, Effect, Exit, Fiber } from 'effect';

// Cleanup uncertainty retains cache ownership and must survive mixed interruption causes.
export class SourceCleanupFailed extends Data.TaggedError('SourceCleanupFailed')<{
  readonly retainedDirectory?: string;
}> {}
export class SourceDeadline extends Data.TaggedError('SourceDeadline')<{}> {}

// Interrupt and join the reader before returning. Cleanup may outlast the body deadline.
export const joinedDeadline = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  milliseconds: number,
  sleep: (milliseconds: number) => Effect.Effect<void> = Effect.sleep,
): Effect.Effect<A, E | SourceDeadline, R> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(body);
    const join = Effect.gen(function* () {
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
    });
    return yield* Effect.gen(function* () {
      const result = yield* Effect.raceFirst(
        Fiber.await(fiber).pipe(Effect.map((exit) => ({ exit }))),
        sleep(milliseconds).pipe(Effect.as(null)),
      );
      if (result !== null)
        return yield* Exit.isSuccess(result.exit)
          ? Effect.succeed(result.exit.value)
          : Effect.failCause(result.exit.cause);
      yield* join;
      return yield* Effect.fail(new SourceDeadline());
    }).pipe(Effect.onInterrupt(() => join));
  });

import { Fs } from '@nortuscc/machine';
// Own the cache before starting Git. A retained marker refuses reuse across sessions/restarts.
export const guardedCacheRead = <A, E, R>(
  directory: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Fs> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fs = yield* Fs;
      const marker = `${directory}.cleanup-uncertain`;
      if (yield* joinedDeadline(fs.exists(marker), 2000).pipe(Effect.orDie))
        return yield* Effect.die(new SourceCleanupFailed({ retainedDirectory: directory }));
      // If establishing ownership fails, no subprocess starts. Ambiguous late Fs writes remain conservative.
      yield* joinedDeadline(fs.writeTextAtomic(join(dirname(directory), '.source-cache'), 'Source cache\n'), 2000).pipe(
        Effect.orDie,
      );
      // Exclusive creation prevents two readers from claiming a cache after an existence-check race.
      yield* joinedDeadline(fs.createDirectory(marker), 2000).pipe(Effect.orDie);
      return yield* restore(body).pipe(
        Effect.onExit((exit) => {
          // A cleanup defect, including a mixed failure/interruption, keeps the marker. Unknown defects do too.
          if (Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isDieReason)) return Effect.void;
          return joinedDeadline(fs.remove(marker), 2000).pipe(Effect.orDie);
        }),
      );
    }),
  );

// Optional Git probes may recover ordinary failures, never mixed cleanup or interruption causes.
export const ordinaryFallback =
  <B>(fallback: () => B) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        cause.reasons.some((reason) => !Cause.isFailReason(reason))
          ? (Effect.failCause(cause) as Effect.Effect<never>)
          : Effect.sync(fallback),
      ),
    );
