import { createHash, randomUUID } from 'node:crypto';
import { Effect, Semaphore } from 'effect';
import type { OperationProgress as Progress, ParityAcceptance, ParityRunEvidence } from './operations/index.ts';
import { decodeOperationInput, decodeRunView, type RunView, type ChangePreview, type OperationChange } from './operations/index.ts';
import { MAX_RUN_BYTES, RunStore, validSignInFlow, type RunActor, type RunReceipt } from './run-store.ts';

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
  readonly abandon: (runId: string) => Effect.Effect<RunView, RunError>;
  readonly onChange: (listener: (runId: string) => void) => () => void;
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
  readonly accepted: (change: OperationChange, keys: readonly string[], skillAddition?: RunView['intent']['skillAddition'], parity?: ParityAcceptance) => Effect.Effect<void, RunError>;
  readonly bindSignInFlow: (flow: string) => Effect.Effect<void, RunError>;
  readonly parity: (update: ParityRunEvidence) => Effect.Effect<void, RunError>;
  readonly publication: (update: NonNullable<RunView['publication']>) => Effect.Effect<void, RunError>;
  readonly publicationResult: (result: typeof import('./operations/schemas.ts').PublicationResultSchema.Type) => Effect.Effect<void, RunError>;
  readonly addition: (update: Pick<RunView, 'intentSaved' | 'intentState' | 'installation'>) => Effect.Effect<void, RunError>;
  readonly progress: (progress: Progress) => Effect.Effect<void, RunError>;
  readonly finished: (progress: { readonly type: 'failed'; readonly message: string } | Extract<Progress, { type: 'done' | 'cancelled' }>) => Effect.Effect<void, RunError>;
};
const bounded = (text: string, limit = 500) => [...text].slice(0, limit).join('');
const error = (cause: unknown): RunError => cause instanceof RunError ? cause : new RunError('RUN_FAILED', bounded(cause instanceof Error ? cause.message : String(cause)));
const copy = <T>(value: T): T => structuredClone(value);
// Attribution comes from the immutable receipt owner, including older receipts without a view actor.
const publicView = (receipt: RunReceipt): RunView => copy({ ...receipt.view, actor: receipt.actor });
// Push notifications contain no device challenge. Read the current display through get/list.
const notificationView = (receipt: RunReceipt): RunView => {
  const view = publicView(receipt);
  if (view.parity?.kind === 'signIn' && view.parity.signIn) {
    const challenge = view.parity.signIn;
    return { ...view, parity: { ...view.parity, signIn: {
      kind: 'signIn', state: challenge.state, expiresAt: challenge.expiresAt,
    } } } as RunView;
  }
  return view;
};

// Created once alongside the shared session. The session retains lock and execution ownership.
export const makeAgentRuns = (driver: {
  readonly now?: Effect.Effect<Date>;
  readonly signInFlow?: Effect.Effect<string | null>;
  readonly start: (input: SubmitRun, lifecycle: RunLifecycle) => Effect.Effect<
    { readonly status: 'started'; readonly runId: string } | { readonly status: 'stale'; readonly preview: ChangePreview }, unknown>;
  readonly cancel: (runId: string) => Effect.Effect<void>;
}) => Effect.gen(function* () {
  const store = yield* RunStore;
  const gate = yield* Semaphore.make(1);
  const writes = yield* Semaphore.make(1);
  const hidden = new Map<string, 'expired' | 'needsInspection'>();
  const dirtyScrubs = new Set<string>();
  const now = driver.now ?? Effect.sync(() => new Date());
  const receipts = new Map<string, RunReceipt>();
  const requests = new Map<string, string>();
  const listeners = new Map<string, Set<(run: RunView) => void>>();
  const changes = new Set<(runId: string) => void>();
  yield* Effect.addFinalizer(() => Effect.sync(() => { listeners.clear(); changes.clear(); }));
  let sequence = 0;
  const publish = (receipt: RunReceipt) => {
    for (const listener of changes) {
      try { listener(receipt.view.runId); } catch {}
    }
    for (const listener of listeners.get(receipt.view.runId) ?? []) {
      try { listener(notificationView(receipt)); } catch {}
    }
  };
  const conceal = (receipt: RunReceipt, state: 'expired' | 'needsInspection'): RunReceipt => {
    const parity = receipt.view.parity;
    if (parity?.kind !== 'signIn' || !parity.signIn) return receipt;
    return { ...receipt, view: decodeRunView({ ...receipt.view, parity: { ...parity,
      signIn: { kind: 'signIn', state, expiresAt: parity.signIn.expiresAt },
    } }) };
  };
  const persist = (receipt: RunReceipt) => store.write(receipt).pipe(Effect.mapError(error), Effect.andThen(Effect.sync(() => {
    receipts.set(receipt.view.runId, copy(receipt));
    requests.set(receipt.view.intent.requestId, receipt.view.runId);
    publish(receipt);
  })));
  const invalidChallenge = (receipt: RunReceipt, restart = false) => Effect.gen(function* () {
    const challenge = receipt.view.parity?.kind === 'signIn' ? receipt.view.parity.signIn : undefined;
    if (challenge?.state !== 'awaiting-user') return undefined;
    if (restart) return 'needsInspection' as const;
    if ((yield* now).getTime() >= Date.parse(challenge.expiresAt)) return 'expired' as const;
    const current = yield* (driver.signInFlow ?? Effect.succeed(null));
    return !receipt.signInFlow || receipt.signInFlow !== current ? 'needsInspection' as const : undefined;
  });
  const hide = (receipt: RunReceipt, reason: 'expired' | 'needsInspection') => {
    const id = receipt.view.runId;
    hidden.set(id, reason); dirtyScrubs.add(id);
    const clean = conceal(receipt, reason);
    // Hide before I/O. A failed write cannot reveal a challenge through reads or retries.
    receipts.set(id, copy(clean));
    return clean;
  };
  const save = (receipt: RunReceipt) => Effect.gen(function* () {
    const reason = hidden.get(receipt.view.runId) ?? (yield* invalidChallenge(receipt));
    yield* persist(reason ? hide(receipt, reason) : receipt);
    dirtyScrubs.delete(receipt.view.runId);
  }).pipe(writes.withPermit);
  const scrub = (runId: string, restart = false) => Effect.gen(function* () {
    const receipt = receipts.get(runId)!;
    const reason = yield* invalidChallenge(receipt, restart);
    if (reason) hide(receipt, reason);
    if (!dirtyScrubs.has(runId)) return receipt;
    const clean = hide(receipts.get(runId)!, hidden.get(runId) ?? 'needsInspection');
    yield* persist(clean).pipe(Effect.match({
      onSuccess: () => { dirtyScrubs.delete(runId); },
      onFailure: () => { hide(clean, 'needsInspection'); },
    }));
    return receipts.get(runId)!;
  }).pipe(writes.withPermit);
  for (const receipt of yield* store.read.pipe(Effect.mapError(error))) {
    sequence = Math.max(sequence, receipt.sequence);
    if (receipts.has(receipt.view.runId) || requests.has(receipt.view.intent.requestId)) return yield* Effect.fail(new RunError('RUN_FAILED', 'Duplicate receipt identity'));
    const incomplete = receipt.view.state === 'accepted' || receipt.view.state === 'running';
    const recovered: RunReceipt = incomplete ? { ...receipt, view: decodeRunView({ ...receipt.view, state: 'interrupted', ...(receipt.view.parity ? { parity: { ...receipt.view.parity, state: 'needsInspection' as const } } : {}), ...(receipt.view.intent.skillAddition ? { installation: { ...receipt.view.installation, state: 'needsInspection' as const, message: 'Agent stopped; inspect saved intent and installed files before retrying', sharedStore: { codexScans: true as const, visibility: 'shared' as const }, nextActions: [] } } : {}), result: {
      status: 'interrupted', message: receipt.inFlight ? bounded(`Agent stopped while applying ${receipt.inFlight}; inspect before trying again`) : 'Agent stopped before the run finished; inspect before trying again',
    } }) } : receipt;
    receipts.set(receipt.view.runId, copy(recovered));
    requests.set(receipt.view.intent.requestId, receipt.view.runId);
    if (recovered.view.parity?.kind === 'signIn' && recovered.view.parity.signIn) yield* scrub(receipt.view.runId, true);
    else if (incomplete) yield* save(recovered);
  }
  const find = (runId: string) => Effect.suspend(() => {
    const receipt = receipts.get(runId);
    return receipt ? Effect.succeed(receipt) : Effect.fail(new RunError('UNKNOWN_RUN', 'No run has that ID'));
  });
  const get: AgentRuns['get'] = runId => Effect.andThen(find(runId), Effect.map(scrub(runId), publicView));
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
        return yield* get(previousId);
      }
      const runId = randomUUID();
      let noteLimit = 500;
      let durabilityFailed = false;
      const lifecycle: RunLifecycle = {
        runId, requestId: input.requestId, actor: input.actor,
        accepted: (change, keys, skillAddition, parity) => Effect.gen(function* () {
          const view = yield* Effect.try({ try: () => decodeRunView({ runId, state: 'accepted', operation: 'applyChange', scope: { kind: 'machine' },
            intent: { requestId: input.requestId, inputDigest: input.inputDigest, planId: input.planId, change: copy(change), ...(skillAddition ? { skillAddition: copy(skillAddition) } : {}), ...(parity ? { parity: copy(parity) } : {}) },
            ...(skillAddition || change.kind === 'machineIntent' ? { intentState: 'pending' } : {}), ...(parity ? { parity: { kind: parity.kind, state: 'pending', committedKeys: [], remainingKeys: [...keys], backupIds: [], ...(parity.kind === 'machineIntent' ? { intentState: 'pending', routingEffects: [] } : {}) } } : {}), intentSaved: false, steps: [], result: null }), catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
          if (parity && (new Set(keys).size !== keys.length || JSON.stringify(parity.plannedKeys) !== JSON.stringify(keys))) return yield* Effect.fail(new RunError('INVALID_INPUT', 'Parity acceptance keys differ from the plan'));
          // Reserve room for all outcomes and remaining keys before accepting any work.
          const largest = { ...view, steps: keys.map(key => ({ key, outcome: 'cancelled', note: '' })), result: { status: 'cancelled', remaining: keys } };
          yield* Effect.try({ try: () => decodeRunView(largest), catch: e => new RunError('INVALID_INPUT', bounded(String(e))) });
          if (Buffer.byteLength(JSON.stringify(largest)) > 256 * 1024) return yield* Effect.fail(new RunError('INVALID_INPUT', 'The plan is too large for a run receipt'));
          noteLimit = Math.min(500, Math.floor(64 * 1024 / Math.max(1, keys.length) / 4));
          yield* save({ version: 1, sequence: ++sequence, actor: input.actor, view, inFlight: null });
        }),
        bindSignInFlow: flow => Effect.gen(function* () {
          const receipt = yield* find(runId);
          if (receipt.view.intent.change.kind !== 'signIn' || !validSignInFlow(flow)
            || receipt.signInFlow !== undefined && receipt.signInFlow !== flow) {
            return yield* Effect.fail(new RunError('INVALID_INPUT', 'Invalid sign-in flow binding'));
          }
          yield* save({ ...receipt, signInFlow: flow });
        }).pipe(Effect.tapError(() => Effect.sync(() => { durabilityFailed = true; }))),
        parity: update => Effect.gen(function* () {
          const receipt = yield* find(runId);
          const view = yield* Effect.try({ try: () => decodeRunView({ ...receipt.view, parity: copy(update), ...(update.kind === 'machineIntent' ? { intentSaved: update.intentState === 'saved', intentState: update.intentState } : {}) }), catch: () => new RunError('INVALID_INPUT', 'Invalid operation evidence') });
          const accepted = view.intent.parity!;
          const keys = new Set(accepted.plannedKeys);
          if (new Set([...update.committedKeys, ...update.remainingKeys]).size !== keys.size
            || update.committedKeys.length + update.remainingKeys.length !== keys.size
            || update.state === 'committed' && update.remainingKeys.length !== 0
            || [...update.committedKeys, ...update.remainingKeys].some(key => !keys.has(key))
            || update.committedKeys.some(key => update.remainingKeys.includes(key))
            || receipt.view.parity?.committedKeys.some(key => !update.committedKeys.includes(key))
            || receipt.view.parity?.backupIds.some(id => !update.backupIds.includes(id))) return yield* Effect.fail(new RunError('INVALID_INPUT', 'Operation evidence contradicts acceptance'));
          const updated = { ...receipt, view };
          if (Buffer.byteLength(JSON.stringify(updated)) > MAX_RUN_BYTES - 4096) return yield* Effect.fail(new RunError('INVALID_INPUT', 'Operation evidence is too large for a run receipt'));
          // An observed commit survives a failed receipt write and cannot be replayed by a retry.
          receipts.set(runId, copy(updated)); publish(updated);
          yield* save(updated);
        }).pipe(Effect.tapError(() => Effect.sync(() => { durabilityFailed = true; }))),
        publication: update => Effect.gen(function* () {
          const receipt = yield* find(runId);
          const view = yield* Effect.try({ try: () => decodeRunView({ ...receipt.view, publication: copy(update) }), catch: () => new RunError('INVALID_INPUT', 'Invalid publication evidence') });
          if (receipt.view.publication?.commit && receipt.view.publication.commit !== update.commit) return yield* Effect.fail(new RunError('INVALID_INPUT', 'Publication commit cannot change'));
          const updated = { ...receipt, view };
          receipts.set(runId, copy(updated)); publish(updated);
          yield* save(updated);
        }).pipe(Effect.tapError(() => Effect.sync(() => { durabilityFailed = true; }))),
        publicationResult: result => Effect.gen(function* () {
          const receipt = yield* find(runId);
          const view = yield* Effect.try({ try: () => decodeRunView({ ...receipt.view, state: result.status === 'succeeded' ? 'succeeded' : result.status === 'interrupted' ? 'interrupted' : 'failed', result }), catch: () => new RunError('INVALID_INPUT', 'Invalid publication result') });
          yield* save({ ...receipt, view, inFlight: null });
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
          if (!durabilityFailed && receipt.view.publication?.pushed && receipt.view.result?.status === 'succeeded') {
            if (progress.type === 'failed') yield* save({ ...receipt, view: { ...receipt.view, result: { ...receipt.view.result, message: bounded(`${receipt.view.result.message}. ${progress.message}`) } } });
            return;
          }
          if (!durabilityFailed && receipt.view.publication && receipt.view.result !== null
            && (receipt.view.result.status !== 'succeeded' || progress.type === 'done')) return;
          const result: NonNullable<RunView['result']> = durabilityFailed ? { status: 'interrupted', message: 'Run receipt could not be saved; inspect the machine before trying again' } : progress.type === 'failed' ? { status: 'failed', message: bounded(progress.message) }
            : progress.type === 'cancelled' ? { status: 'cancelled', remaining: [...progress.remaining] }
            : { status: 'done', ok: progress.ok, failed: progress.failed };
          const state: RunView['state'] = result.status === 'done' ? result.failed > 0 ? 'failed' : 'succeeded' : result.status === 'needs-preview' ? 'failed' : result.status;
          const ended = { ...receipt, inFlight: result.status === 'done' || result.status === 'cancelled' ? null : receipt.inFlight, view: { ...receipt.view, state, result } };
          yield* save(ended).pipe(Effect.catch(cause => {
            const interrupted: RunReceipt = { ...ended, view: decodeRunView({ ...ended.view, state: 'interrupted', ...(ended.view.parity ? { parity: { ...ended.view.parity, state: 'needsInspection' as const } } : {}), ...(ended.view.intent.skillAddition ? {
              installation: { ...ended.view.installation, state: 'needsInspection', message: 'The final receipt could not be saved; inspect saved intent and installed files before retrying',
                sharedStore: { codexScans: true, visibility: 'shared' }, nextActions: [] },
            } : {}), result: {
              status: 'interrupted', message: 'The final receipt could not be saved; inspect the machine before trying again',
            } }) };
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
      for (const id of receipts.keys()) yield* scrub(id);
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
    abandon: runId => Effect.gen(function* () {
      const receipt = yield* find(runId);
      if (receipt.view.state === 'abandoned') return yield* get(runId);
      if (receipt.view.state !== 'interrupted') return yield* Effect.fail(new RunError('RUN_FAILED', 'Run is not interrupted'));
      const view = decodeRunView({ ...receipt.view, state: 'abandoned', abandonedAt: (yield* now).toISOString() });
      yield* save({ ...receipt, view });
      return yield* get(runId);
    }).pipe(gate.withPermit),
    onChange: listener => { changes.add(listener); return () => { changes.delete(listener); }; },
    subscribe: (runId, listener) => {
      const set = listeners.get(runId) ?? new Set();
      listeners.set(runId, set); set.add(listener);
      const receipt = receipts.get(runId);
      if (receipt) { try { listener(notificationView(receipt)); } catch {} }
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
