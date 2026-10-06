import { Cause, Effect, Exit, Queue, Stream } from 'effect';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { acquireApplyLock } from './apply-lock.ts';
import { Backups } from './backups.ts';
import type { LockHeld } from './errors.ts';
import type { MachinePaths } from './paths.ts';
import type { Domain, MachineReport, Plan, PlanKind, Progress, Selection, Skipped, Step, StepResult } from './model.ts';

// The services a set of domains needs: the union of each domain's requirements.
export type DomainServices<D extends ReadonlyArray<Domain<any>>> = D[number] extends infer E
  ? E extends Domain<infer R> ? R : never
  : never;

export const inspect = <const D extends ReadonlyArray<Domain<any>>>(
  desired: DesiredConfig,
  domains: D,
): Effect.Effect<MachineReport, never, DomainServices<D>> =>
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
export const plan = (kind: PlanKind, report: MachineReport, selection: Selection, domains: ReadonlyArray<Domain<any>>): Plan => {
  const skipped: Skipped[] = [];
  const chosen = report.items.filter((item) => {
    const keep = !selection.exclude.includes(item.key) && (selection.only === undefined || selection.only.includes(item.key));
    if (!keep) skipped.push({ key: item.key, reason: 'not selected' });
    return keep;
  });
  const steps: Step[] = [];
  for (const domain of domains) {
    const part = domain.steps(chosen.filter((item) => item.domain === domain.name), selection, kind, report.desired);
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

// A failure's message, else its `_tag`, so a note is never empty.
const describe = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && '_tag' in error && typeof error._tag === 'string' && error._tag) return error._tag;
  return String(error);
};

const settle = (exit: Exit.Exit<StepResult, unknown>): Outcome => {
  if (Exit.isSuccess(exit)) return { outcome: exit.value.ok ? 'ok' : 'failed', note: exit.value.note ?? '' };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: 'cancelled', note: 'cancelled' };
  return { outcome: 'failed', note: describe(Cause.squash(exit.cause)) };
};

const sameStep = (a: Step, b: Step) =>
  a.key === b.key && a.domain === b.domain && a.action === b.action && a.summary === b.summary
  && a.interruptible === b.interruptible
  && a.touches.length === b.touches.length && a.touches.every((t, i) => t === b.touches[i])
  && (a.targets === undefined ? b.targets === undefined
    : b.targets !== undefined && a.targets.length === b.targets.length && a.targets.every((t, i) => t === b.targets![i]));

// Structural, order-sensitive equality: the app's check that a previewed plan is not stale.
export const samePlan = (a: Plan, b: Plan): boolean =>
  a.kind === b.kind
  && a.steps.length === b.steps.length && a.steps.every((s, i) => sameStep(s, b.steps[i]!))
  && a.skipped.length === b.skipped.length
  && a.skipped.every((s, i) => s.key === b.skipped[i]!.key && s.reason === b.skipped[i]!.reason);

// The only executor. Holds the apply lock, runs steps in order, passing each `run` the report the
// plan came from, and stops cleanly when the signal fires. A caller that already holds apply.lock
// for this run passes `lockHeld`; the run then neither takes nor releases it.
export const execute = <const D extends ReadonlyArray<Domain<any>>>(
  plan: Plan,
  report: MachineReport,
  domains: D,
  options: { readonly signal?: AbortSignal; readonly lockHeld?: boolean } = {},
): Stream.Stream<Progress, LockHeld, DomainServices<D> | MachinePaths | Backups> =>
  Stream.callback<Progress, LockHeld, DomainServices<D> | MachinePaths | Backups>((queue) =>
    Effect.gen(function* () {
      if (!options.lockHeld) yield* acquireApplyLock;
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
        const domain: Domain<DomainServices<D>> | undefined = domains.find((d) => d.name === step.domain);
        const body: Effect.Effect<StepResult, unknown, DomainServices<D>> = domain
          ? Effect.suspend(() => domain.run(step, report))
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
    }).pipe(Effect.catchCause((cause) => Queue.failCause(queue, cause))),
  );
