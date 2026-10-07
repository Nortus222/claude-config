import { randomUUID } from 'node:crypto';
import { Effect, Stream } from 'effect';
import {
  acquireApplyLock, execute, HistoryStore, plan, pruneBackups, selectAll,
  type Actor, type MachineReport, type Plan, type Progress, type StepRecord,
} from '@nortuscc/machine';
import { AgentClock } from './clock.ts';
import type { AgentDomain } from './layer.ts';
import { pause } from './pause.ts';

// The only step kinds auto-apply runs. Refusing anything else guards against a classifier bug.
export const AUTO_ACTIONS: ReadonlySet<string> = new Set(['write-file', 'merge-keys']);

export type AutoApplyOutcome =
  | { readonly kind: 'nothing' }
  | { readonly kind: 'lock-held' }
  | { readonly kind: 'refused'; readonly step: string; readonly action: string }
  | {
    readonly kind: 'ran'; readonly runId: string; readonly result: 'done' | 'cancelled';
    readonly failed: number; readonly backup: string | null;
  };

const NOTHING: AutoApplyOutcome = { kind: 'nothing' };
const LOCK_HELD: AutoApplyOutcome = { kind: 'lock-held' };

// What a recorded run did, as apply-finished records it.
export type RunRecord = { readonly steps: ReadonlyArray<StepRecord>; readonly result: 'done' | 'cancelled'; readonly backup: string | null };

// Runs `planned` with apply.lock already held, bracketed in History by apply-started and
// apply-finished, so a crash between the two reads as interrupted. `onProgress` sees every event.
// Callers make it uninterruptible: `signal` stops it, and it still records how it ended.
export const recordedRun = (
  planned: Plan,
  report: MachineReport,
  domains: ReadonlyArray<AgentDomain>,
  options: {
    readonly runId: string; readonly actor: Actor; readonly automatic: boolean; readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Progress) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const history = yield* HistoryStore;
    const { runId, actor } = options;
    yield* history.append({ kind: 'apply-started', actor, runId, automatic: options.automatic, keys: planned.steps.map((s) => s.key) });
    const steps: StepRecord[] = [];
    let result: RunRecord['result'] = 'done';
    let backup: string | null = null;
    yield* Stream.runForEach(execute(planned, report, domains, { signal: options.signal, lockHeld: true }), (event) =>
      Effect.andThen(Effect.sync(() => {
        if (event.type === 'finished') steps.push({ key: event.key, outcome: event.outcome, note: event.note });
        if (event.type === 'cancelled') result = 'cancelled';
        if (event.type === 'cancelled' || event.type === 'done') backup = event.backups ?? null;
      }), options.onProgress?.(event) ?? Effect.void));
    const ran: RunRecord = { steps, result, backup };
    yield* history.append({ kind: 'apply-finished', actor, runId, ...ran });
    return ran;
  });

// Under apply.lock, an automatic recorded run; a failed step pauses auto-apply.
const runUnderLock = (planned: Plan, report: MachineReport, domains: ReadonlyArray<AgentDomain>, signal?: AbortSignal) =>
  Effect.andThen(acquireApplyLock, Effect.uninterruptible(Effect.gen(function* () {
    const runId = randomUUID();
    const ran = yield* recordedRun(planned, report, domains, { runId, actor: 'agent', automatic: true, signal });
    const failed = ran.steps.filter((s) => s.outcome === 'failed').length;
    if (failed > 0) yield* pause(`${failed} step(s) failed in auto-apply run ${runId}`, runId);
    const outcome: AutoApplyOutcome = { kind: 'ran', runId, result: ran.result, failed, backup: ran.backup };
    return outcome;
  })));

// Applies the given inert item keys. Never builds an uninstall, capture or update plan. A refused
// plan or a failed step pauses auto-apply; a cancelled run does not; a held apply.lock (the CLI is
// applying) skips until the next trigger; an aborted signal starts no run. The caller provides a
// fresh Backups for the run.
export const autoApply = (
  report: MachineReport,
  keys: ReadonlyArray<string>,
  domains: ReadonlyArray<AgentDomain>,
  options: { readonly signal?: AbortSignal } = {},
) =>
  Effect.gen(function* () {
    // A shutdown already under way starts nothing: no lock, no History.
    if (options.signal?.aborted) return NOTHING;
    const planned = plan('apply', report, { ...selectAll, only: keys }, domains);
    if (planned.steps.length === 0) return NOTHING;
    const refused = planned.steps.find((s) => !AUTO_ACTIONS.has(s.action));
    if (refused) {
      yield* pause(`refused an auto-apply plan: ${refused.key} is ${refused.action}`);
      const outcome: AutoApplyOutcome = { kind: 'refused', step: refused.key, action: refused.action };
      return outcome;
    }
    const outcome = yield* Effect.scoped(runUnderLock(planned, report, domains, options.signal)).pipe(
      Effect.catchTag('LockHeld', () => Effect.succeed(LOCK_HELD)),
    );
    // The run is already in History; a pruning failure must not hide it. Old backups are retried
    // after the next run.
    if (outcome.kind === 'ran') yield* pruneBackups(yield* (yield* AgentClock).now, 'agent').pipe(Effect.ignore);
    return outcome;
  });
