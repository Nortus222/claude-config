import { Cause, Effect, Exit, Queue, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { acquireApplyLock } from './apply-lock.ts';
import { Backups } from './backups.ts';
import type { LockHeld } from './errors.ts';
import type { MachinePaths } from './paths.ts';
import type { Domain, MachineReport, Plan, PlanKind, Progress, Selection, Skipped, Step, StepResult } from './model.ts';

export const inspect = <R>(desired: DesiredConfig, domains: ReadonlyArray<Domain<R>>): Effect.Effect<MachineReport, never, R> =>
  Effect.gen(function* () {
    const items = [];
    const probeErrors = [];
    for (const domain of domains) {
      const part = yield* domain.inspect(desired);
      items.push(...part.items);
      probeErrors.push(...part.probeErrors);
    }
    return { desired, items, probeErrors };
  });

// Pure: decides what would happen, including what will not and why.
export const plan = <R>(kind: PlanKind, report: MachineReport, selection: Selection, domains: ReadonlyArray<Domain<R>>): Plan => {
  const skipped: Skipped[] = [];
  const chosen = report.items.filter((item) => {
    const keep = !selection.exclude.includes(item.key) && (selection.only === undefined || selection.only.includes(item.key));
    if (!keep) skipped.push({ key: item.key, reason: 'not selected' });
    return keep;
  });
  const steps: Step[] = [];
  for (const domain of domains) {
    const part = domain.steps(chosen.filter((item) => item.domain === domain.name), selection, kind);
    steps.push(...part.steps);
    skipped.push(...part.skipped);
  }
  return { kind, steps, skipped };
};

const whenAborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener('abort', onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener('abort', onAbort));
  });

type Outcome = { readonly outcome: 'ok' | 'failed' | 'cancelled'; readonly note: string };

const settle = (exit: Exit.Exit<StepResult, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { outcome: exit.value.ok ? 'ok' : 'failed', note: exit.value.note ?? '' };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: 'cancelled', note: 'cancelled' };
  const error = Cause.squash(exit.cause);
  return { outcome: 'failed', note: error instanceof Error ? error.message : String(error) };
};

// The only executor. Holds the apply lock, runs steps in order, and stops cleanly when the signal fires.
export const execute = <R>(
  plan: Plan,
  domains: ReadonlyArray<Domain<R>>,
  options: { readonly signal?: AbortSignal } = {},
): Stream.Stream<Progress, LockHeld, R | MachinePaths | Backups> =>
  Stream.callback<Progress, LockHeld, R | MachinePaths | Backups>((queue) =>
    Effect.gen(function* () {
      yield* acquireApplyLock;
      const backups = yield* Backups;
      const signal = options.signal ?? new AbortController().signal;
      const total = plan.steps.length;
      let ok = 0;
      let failed = 0;

      for (const [index, step] of plan.steps.entries()) {
        if (signal.aborted) {
          yield* Queue.offer(queue, { type: 'cancelled', remaining: plan.steps.slice(index).map((s) => s.key), backups: yield* backups.dir });
          return yield* Queue.end(queue);
        }
        yield* Queue.offer(queue, { type: 'started', index, total, step });
        const domain = domains.find((d) => d.name === step.domain);
        const body: Effect.Effect<StepResult, unknown, R> = domain
          ? domain.run(step)
          : Effect.succeed({ ok: false, note: `no domain for ${step.domain}` });
        const result = step.interruptible
          ? settle(yield* Effect.exit(Effect.raceFirst(body, Effect.andThen(whenAborted(signal), Effect.interrupt))))
          : settle(yield* Effect.exit(Effect.uninterruptible(body)));
        if (result.outcome === 'ok') ok++;
        else if (result.outcome === 'failed') failed++;
        yield* Queue.offer(queue, { type: 'finished', index, total, key: step.key, ...result });
        if (result.outcome === 'cancelled') {
          yield* Queue.offer(queue, { type: 'cancelled', remaining: plan.steps.slice(index + 1).map((s) => s.key), backups: yield* backups.dir });
          return yield* Queue.end(queue);
        }
      }
      yield* Queue.offer(queue, { type: 'done', ok, failed, backups: yield* backups.dir });
      yield* Queue.end(queue);
    }).pipe(Effect.catch((error: LockHeld) => Queue.fail(queue, error))),
  );
