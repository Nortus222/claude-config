import { randomUUID } from 'node:crypto';
import { Effect, Stream } from 'effect';
import {
  acquireApplyLock, execute, HistoryStore, plan, pruneBackups, selectAll,
  type MachineReport, type Plan, type StepRecord,
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

// Under apply.lock, History brackets the run, so a crash between the two events reads as interrupted.
const runUnderLock = (planned: Plan, report: MachineReport, domains: ReadonlyArray<AgentDomain>, signal?: AbortSignal) =>
  Effect.gen(function* () {
    yield* acquireApplyLock;
    const history = yield* HistoryStore;
    const runId = randomUUID();
    yield* history.append({ kind: 'apply-started', actor: 'agent', runId, automatic: true, keys: planned.steps.map((s) => s.key) });
    const ran: { steps: StepRecord[]; result: 'done' | 'cancelled'; backup: string | null } = { steps: [], result: 'done', backup: null };
    yield* Stream.runForEach(execute(planned, report, domains, { signal, lockHeld: true }), (event) =>
      Effect.sync(() => {
        if (event.type === 'finished') ran.steps.push({ key: event.key, outcome: event.outcome, note: event.note });
        if (event.type === 'cancelled') ran.result = 'cancelled';
        if (event.type === 'cancelled' || event.type === 'done') ran.backup = event.backups ?? null;
      }));
    yield* history.append({ kind: 'apply-finished', actor: 'agent', runId, steps: ran.steps, backup: ran.backup, result: ran.result });
    const failed = ran.steps.filter((s) => s.outcome === 'failed').length;
    if (failed > 0) yield* pause(`${failed} step(s) failed in auto-apply run ${runId}`, runId);
    const outcome: AutoApplyOutcome = { kind: 'ran', runId, result: ran.result, failed, backup: ran.backup };
    return outcome;
  });

// Applies the given inert item keys. Never builds an uninstall, capture or update plan. A refused
// plan or a failed step pauses auto-apply; a cancelled run does not; a held apply.lock (the CLI is
// applying) skips until the next trigger. The caller provides a fresh Backups for the run.
export const autoApply = (
  report: MachineReport,
  keys: ReadonlyArray<string>,
  domains: ReadonlyArray<AgentDomain>,
  options: { readonly signal?: AbortSignal } = {},
) =>
  Effect.gen(function* () {
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
    if (outcome.kind === 'ran') yield* pruneBackups(yield* (yield* AgentClock).now, 'agent');
    return outcome;
  });
