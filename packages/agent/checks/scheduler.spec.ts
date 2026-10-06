import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { AgentClock, jittered, makeScheduler, PERIOD_MS, tickKind, timerLoop, type Trigger } from '../src/index.ts';

test('the timer waits the period ±10%', () => {
  assert.equal(PERIOD_MS, 3_600_000);
  assert.equal(jittered(0), 3_240_000);
  assert.equal(jittered(0.5), 3_600_000);
  assert.equal(jittered(1), 3_960_000);
});

test('a wall-clock jump of more than twice the period between ticks is a wake', () => {
  assert.equal(tickKind(0, 2 * PERIOD_MS), 'timer');
  assert.equal(tickKind(0, 2 * PERIOD_MS + 1), 'wake');
  // A clock set back is not a wake.
  assert.equal(tickKind(10 * PERIOD_MS, 0), 'timer');
});

test('triggers during a job coalesce into one follow-up job, and jobs never overlap', async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const secondDone = yield* Deferred.make<void>();
    const batches: Trigger[][] = [];
    let running = 0;
    let overlapped = false;
    const scheduler = yield* makeScheduler((triggers) => Effect.gen(function* () {
      if (running > 0) overlapped = true;
      running++;
      batches.push([...triggers]);
      if (batches.length === 1) {
        yield* Deferred.succeed(firstStarted, undefined);
        yield* Deferred.await(release);
      } else {
        yield* Deferred.succeed(secondDone, undefined);
      }
      running--;
      return batches.length;
    }));
    const loop = yield* Effect.forkChild(scheduler.run);
    yield* scheduler.trigger('start');
    yield* Deferred.await(firstStarted);
    yield* scheduler.trigger('timer');
    yield* scheduler.trigger('inspect');
    yield* scheduler.trigger('decide');
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(secondDone);
    yield* Fiber.interrupt(loop);
    return { batches, overlapped };
  }));
  assert.deepEqual(result.batches, [['start'], ['timer', 'inspect', 'decide']]);
  assert.equal(result.overlapped, false);
});

test('request answers with the result of the job that ran its trigger', async () => {
  const answers = await Effect.runPromise(Effect.gen(function* () {
    let jobs = 0;
    const scheduler = yield* makeScheduler(() => Effect.sync(() => ++jobs));
    const loop = yield* Effect.forkChild(scheduler.run);
    const first = yield* scheduler.request('inspect');
    const second = yield* scheduler.request('decide');
    yield* Fiber.interrupt(loop);
    return [first, second];
  }));
  assert.deepEqual(answers, [1, 2]);
});

test('the timer offers timer ticks, and a wake after the wall clock jumped', async () => {
  const nows = [0, 3_300_000, 3_300_000 + 3 * PERIOD_MS];
  const randoms = [0, 1];
  const sleeps: number[] = [];
  const offered: Trigger[] = [];
  const clock = Layer.succeed(AgentClock, {
    now: Effect.sync(() => new Date(nows.shift()!)),
    random: Effect.sync(() => randoms.shift() ?? 0.5),
    // The script ends by interrupting the loop.
    sleep: (ms: number) => {
      sleeps.push(ms);
      return nows.length === 0 ? Effect.interrupt : Effect.void;
    },
  });
  const exit = await Effect.runPromiseExit(timerLoop((t) => Effect.sync(() => { offered.push(t); })).pipe(Effect.provide(clock)));
  assert.ok(Exit.isFailure(exit));
  assert.deepEqual(offered, ['timer', 'wake']);
  assert.deepEqual(sleeps, [3_240_000, 3_960_000, 3_600_000]);
});
