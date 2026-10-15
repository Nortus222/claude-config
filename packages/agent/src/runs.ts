import { createHash, randomUUID } from 'node:crypto';
import { Effect, Semaphore } from 'effect';
import type { Progress } from '@nortuscc/machine';
import { decodeOperationInput, decodeRunView, type RunView, type ChangePreview, type OperationChange } from './operations/index.ts';
import { MAX_RUN_BYTES, RunStore, type RunActor, type RunReceipt } from './run-store.ts';

export class RunError extends Error {
  readonly code: string;
  readonly preview?: ChangePreview;
  constructor(code: string, message: string, preview?: ChangePreview) {
    super(message); this.code = code; this.preview = preview;
  }
}
export type SubmitRun = { readonly requestId: string; readonly inputDigest: string; readonly planId: string; readonly actor: RunActor };
export type AgentRuns = {
  readonly submit: (input: SubmitRun) => Effect.Effect<RunView, RunError>;
  readonly get: (runId: string) => Effect.Effect<RunView, RunError>;
  readonly list: (input: { readonly before?: string; readonly limit: number }) => Effect.Effect<{ readonly runs: readonly RunView[]; readonly nextBefore: string | null }, RunError>;
  readonly cancel: (runId: string) => Effect.Effect<RunView, RunError>;
  readonly subscribe: (runId: string, listener: (run: RunView) => void) => () => void;
};

// Request identity includes every executable input, in a fixed order with an explicit default scope.
export const operationDigest = (planId: string): string => createHash('sha256').update(JSON.stringify({
  operation: 'applyChange', scope: { kind: 'machine' }, planId,
})).digest('hex');

export type RunLifecycle = {
  readonly actor: RunActor;
  readonly runId: string;
  readonly requestId: string;
  readonly accepted: (change: OperationChange, keys: readonly string[], skillAddition?: RunView['intent']['skillAddition']) => Effect.Effect<void, RunError>;
  readonly addition: (update: Pick<RunView, 'intentSaved' | 'intentState' | 'installation'>) => Effect.Effect<void, RunError>;
  readonly progress: (progress: Progress) => Effect.Effect<void, RunError>;
  readonly finished: (progress: { readonly type: 'failed'; readonly message: string } | Extract<Progress, { type: 'done' | 'cancelled' }>) => Effect.Effect<void, RunError>;
};
const bounded = (text: string, limit = 500) => [...text].slice(0, limit).join('');
const error = (cause: unknown): RunError => cause instanceof RunError ? cause : new RunError('RUN_FAILED', bounded(cause instanceof Error ? cause.message : String(cause)));
const copy = <T>(value: T): T => structuredClone(value);
// Attribution comes from the immutable receipt owner, including older receipts without a view actor.
const publicView = (receipt: RunReceipt): RunView => copy({ ...receipt.view, actor: receipt.actor });

// Created once alongside the shared session. The session retains lock and execution ownership.
export const makeAgentRuns = (driver: {
  readonly start: (input: SubmitRun, lifecycle: RunLifecycle) => Effect.Effect<
    { readonly status: 'started'; readonly runId: string } | { readonly status: 'stale'; readonly preview: ChangePreview }, unknown>;
  readonly cancel: (runId: string) => Effect.Effect<void>;
}) => Effect.gen(function* () {
  const store = yield* RunStore;
  const gate = yield* Semaphore.make(1);
  const receipts = new Map<string, RunReceipt>();
  const requests = new Map<string, string>();
  const listeners = new Map<string, Set<(run: RunView) => void>>();
  yield* Effect.addFinalizer(() => Effect.sync(() => listeners.clear()));
  let sequence = 0;
  const publish = (receipt: RunReceipt) => {
    for (const listener of listeners.get(receipt.view.runId) ?? []) {
      try { listener(publicView(receipt)); } catch {}
    }
  };
  const save = (receipt: RunReceipt) => store.write(receipt).pipe(Effect.mapError(error), Effect.andThen(Effect.sync(() => {
    receipts.set(receipt.view.runId, copy(receipt));
    requests.set(receipt.view.intent.requestId, receipt.view.runId);
    publish(receipt);
  })));
  for (const receipt of yield* store.read.pipe(Effect.mapError(error))) {
    sequence = Math.max(sequence, receipt.sequence);
    if (receipts.has(receipt.view.runId) || requests.has(receipt.view.intent.requestId)) return yield* Effect.fail(new RunError('RUN_FAILED', 'Duplicate receipt identity'));
    const incomplete = receipt.view.state === 'accepted' || receipt.view.state === 'running';
    const recovered: RunReceipt = incomplete ? { ...receipt, view: { ...receipt.view, state: 'interrupted', ...(receipt.view.intent.skillAddition ? { installation: { ...receipt.view.installation, state: 'needsInspection' as const, message: 'Agent stopped; inspect saved intent and installed files before retrying', sharedStore: { codexScans: true as const, visibility: 'shared' as const }, nextActions: [] } } : {}), result: {
      status: 'interrupted', message: receipt.inFlight ? bounded(`Agent stopped while applying ${receipt.inFlight}; inspect before trying again`) : 'Agent stopped before the run finished; inspect before trying again',
    } } } : receipt;
    if (incomplete) yield* save(recovered);
    else { receipts.set(receipt.view.runId, copy(receipt)); requests.set(receipt.view.intent.requestId, receipt.view.runId); }
  }
  const find = (runId: string) => Effect.suspend(() => {
    const receipt = receipts.get(runId);
    return receipt ? Effect.succeed(receipt) : Effect.fail(new RunError('UNKNOWN_RUN', 'No run has that ID'));
  });
  const get: AgentRuns['get'] = runId => Effect.map(find(runId), r => publicView(r));
  const submit: AgentRuns['submit'] = original => {
    const input = copy(original);
    return Effect.gen(function* () {
      yield* Effect.try({ try: () => {
        decodeOperationInput('applyChange', { planId: input.planId, requestId: input.requestId });
        if (input.inputDigest !== operationDigest(input.planId) || !['app', 'cli', 'mcp'].includes(input.actor)) throw new Error('Invalid operation digest or actor');
      }, catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
      const previousId = requests.get(input.requestId);
      if (previousId) {
        const previous = receipts.get(previousId)!;
        if (previous.view.intent.inputDigest !== input.inputDigest || previous.view.intent.planId !== input.planId || previous.actor !== input.actor) {
          return yield* Effect.fail(new RunError('REQUEST_CONFLICT', 'This request ID already belongs to different input'));
        }
        return publicView(previous);
      }
      const runId = randomUUID();
      let noteLimit = 500;
      let durabilityFailed = false;
      const lifecycle: RunLifecycle = {
        runId, requestId: input.requestId, actor: input.actor,
        accepted: (change, keys, skillAddition) => Effect.gen(function* () {
          const view = yield* Effect.try({ try: () => decodeRunView({ runId, state: 'accepted', operation: 'applyChange', scope: { kind: 'machine' },
            intent: { requestId: input.requestId, inputDigest: input.inputDigest, planId: input.planId, change: copy(change), ...(skillAddition ? { skillAddition: copy(skillAddition) } : {}) },
            ...(skillAddition ? { intentState: 'pending' } : {}), intentSaved: false, steps: [], result: null }), catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
          // Reserve room for all outcomes and remaining keys before accepting any work.
          const largest = { ...view, steps: keys.map(key => ({ key, outcome: 'cancelled', note: '' })), result: { status: 'cancelled', remaining: keys } };
          yield* Effect.try({ try: () => decodeRunView(largest), catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
          if (Buffer.byteLength(JSON.stringify(largest)) > 256 * 1024) return yield* Effect.fail(new RunError('INVALID_INPUT', 'The plan is too large for a run receipt'));
          noteLimit = Math.min(500, Math.floor(64 * 1024 / Math.max(1, keys.length) / 4));
          yield* save({ version: 1, sequence: ++sequence, actor: input.actor, view, inFlight: null });
        }),
        addition: update => Effect.gen(function* () {
          const receipt = yield* find(runId);
          const updated = { ...receipt, view: { ...receipt.view, ...copy(update) } };
          receipts.set(runId, copy(updated)); publish(updated);
          yield* save(updated);
        }).pipe(Effect.tapError(() => Effect.sync(() => { durabilityFailed = true; }))),
        progress: progress => Effect.gen(function* () {
          const receipt = yield* find(runId);
          if (progress.type === 'started') yield* save({ ...receipt, inFlight: progress.step.key, view: { ...receipt.view, state: 'running' } });
          if (progress.type === 'finished') {
            const committed: RunReceipt = { ...receipt, inFlight: null, view: { ...receipt.view, steps: [...receipt.view.steps, {
              key: progress.key, outcome: progress.outcome, note: bounded(progress.note, noteLimit),
            }] } };
            // Keep observed evidence available even when its durable write fails. The run stops.
            receipts.set(runId, copy(committed));
            yield* save(committed);
          }
        }).pipe(Effect.tapError(() => Effect.sync(() => { durabilityFailed = true; }))),
        finished: progress => Effect.gen(function* () {
          const receipt = yield* find(runId);
          const result: NonNullable<RunView['result']> = durabilityFailed ? { status: 'interrupted', message: 'Run receipt could not be saved; inspect the machine before trying again' } : progress.type === 'failed' ? { status: 'failed', message: bounded(progress.message) }
            : progress.type === 'cancelled' ? { status: 'cancelled', remaining: [...progress.remaining] }
            : { status: 'done', ok: progress.ok, failed: progress.failed };
          const state: RunView['state'] = result.status === 'done' ? result.failed > 0 ? 'failed' : 'succeeded' : result.status;
          const ended = { ...receipt, inFlight: result.status === 'done' || result.status === 'cancelled' ? null : receipt.inFlight, view: { ...receipt.view, state, result } };
          yield* save(ended).pipe(Effect.catch(cause => {
            const interrupted: RunReceipt = { ...ended, view: { ...ended.view, state: 'interrupted', result: {
              status: 'interrupted', message: 'The final receipt could not be saved; inspect the machine before trying again',
            } } };
            receipts.set(runId, interrupted); publish(interrupted);
            return Effect.fail(cause);
          }));
        }),
      };
      const result = yield* driver.start(input, lifecycle).pipe(Effect.mapError(e => {
        if (e instanceof Error && 'code' in e && typeof e.code === 'string') return new RunError(e.code, bounded(e.message));
        return error(e);
      }));
      if (result.status === 'stale') return yield* Effect.fail(new RunError('STALE_PLAN', 'The plan changed', result.preview));
      return yield* get(result.runId);
    }).pipe(gate.withPermit);
  };
  const runs: AgentRuns = {
    submit,
    get,
    list: input => Effect.gen(function* () {
      yield* Effect.try({ try: () => decodeOperationInput('listRuns', input), catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
      const sorted = [...receipts.values()].sort((a, b) => b.sequence - a.sequence || b.view.runId.localeCompare(a.view.runId));
      const offset = input.before === undefined ? 0 : sorted.findIndex(r => r.view.runId === input.before) + 1;
      if (input.before !== undefined && offset === 0) return yield* Effect.fail(new RunError('UNKNOWN_RUN', 'Unknown run cursor'));
      const page: RunReceipt[] = [];
      let bytes = 100;
      for (const receipt of sorted.slice(offset, offset + input.limit)) {
        const size = Buffer.byteLength(JSON.stringify(publicView(receipt))) + 1;
        if (page.length > 0 && bytes + size > MAX_RUN_BYTES) break;
        page.push(receipt); bytes += size;
      }
      return { runs: page.map(r => publicView(r)), nextBefore: offset + page.length < sorted.length ? page.at(-1)!.view.runId : null };
    }),
    cancel: runId => Effect.gen(function* () {
      const receipt = yield* find(runId);
      if (receipt.view.result === null) yield* driver.cancel(runId);
      return yield* get(runId);
    }),
    subscribe: (runId, listener) => {
      const set = listeners.get(runId) ?? new Set();
      listeners.set(runId, set); set.add(listener);
      const receipt = receipts.get(runId);
      if (receipt) { try { listener(publicView(receipt)); } catch {} }
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true; set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },
  };
  return runs;
});
