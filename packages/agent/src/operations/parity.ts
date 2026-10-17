import { Cause, Effect, Exit } from 'effect';
import { HistoryStore, type MutationObserver } from '@nortuscc/machine';
import { RunError, type RunLifecycle } from '../runs.ts';
import type { SessionError } from '../ipc/session.ts';
import type { Trigger } from '../scheduler.ts';
import type { ChangePreview, ParityAcceptance, ParityRunEvidence } from './model.ts';
import { describe, safeMessage } from './safety.ts';

// Validated owners capture their services here; callbacks never come from wire input.
export type PreparedParityChange = {
  readonly preview: ChangePreview;
  readonly acceptance: ParityAcceptance;
  readonly revalidate: Effect.Effect<void, SessionError>;
  readonly execute: (lifecycle: RunLifecycle, signal: AbortSignal) => Effect.Effect<void, SessionError>;
  readonly afterRelease?: Trigger;
};

// Receipt and History are both attempted. Observed commits remain in memory if either store fails.
export const parityObserver = (lifecycle: RunLifecycle, acceptance: ParityAcceptance) => Effect.gen(function* () {
  const history = yield* HistoryStore;
  let evidence: ParityRunEvidence = { kind: acceptance.kind, state: 'pending', committedKeys: [], remainingKeys: [...acceptance.plannedKeys], backupIds: [], ...(acceptance.kind === 'machineIntent' ? { intentState: 'pending' as const, routingEffects: [] } : {}) } as ParityRunEvidence;
  const checkpoint = (update: Partial<ParityRunEvidence>) => Effect.gen(function* () {
    const previous = evidence;
    evidence = { ...evidence, ...update } as ParityRunEvidence;
    const receipt = yield* Effect.exit(lifecycle.parity(evidence));
    const failure = Exit.isFailure(receipt) ? Cause.squash(receipt.cause) : undefined;
    if (failure instanceof RunError && failure.code === 'INVALID_INPUT' && Exit.isFailure(receipt)) {
      evidence = previous;
      return yield* Effect.failCause(receipt.cause);
    }
    const record = yield* Effect.exit(history.append({ kind: 'operation-checkpoint', actor: lifecycle.actor, runId: lifecycle.runId,
      operation: 'applyChange', scope: { kind: 'machine' }, requestId: lifecycle.requestId,
      keys: acceptance.plannedKeys, committedKeys: evidence.committedKeys, remainingKeys: evidence.remainingKeys, backupIds: evidence.backupIds,
      state: evidence.state, message: 'Operation progress recorded' }));
    if (Exit.isFailure(receipt) || Exit.isFailure(record)) {
      evidence = { ...evidence, state: 'needsInspection' };
      yield* lifecycle.parity(evidence).pipe(Effect.ignore);
      const why = Exit.isFailure(receipt) ? receipt.cause : (record as Exit.Failure<unknown, unknown>).cause;
      return yield* Effect.fail(new RunError('RUN_FAILED', safeMessage(`Couldn't save run progress: ${describe(Cause.squash(why))}`)));
    }
  });
  const observer: MutationObserver = {
    pending: key => acceptance.plannedKeys.includes(key) && !evidence.committedKeys.includes(key)
      ? checkpoint({ state: 'needsInspection' }) : Effect.fail(new RunError('INVALID_INPUT', 'The effect is not pending in this plan')),
    committed: key => checkpoint({ committedKeys: [...new Set([...evidence.committedKeys, key])], remainingKeys: evidence.remainingKeys.filter(k => k !== key), state: 'partial' }),
  };
  return { observer, checkpoint, evidence: () => evidence };
});
