import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Context, Effect, Layer, Semaphore } from 'effect';
import { Fs, MachinePaths } from '@nortuscc/machine';
import { decodeRunView, type RunView } from './operations/index.ts';

export type RunActor = 'app' | 'cli' | 'mcp';
export type RunReceipt = {
  readonly version: 1;
  readonly sequence: number;
  readonly actor: RunActor;
  readonly view: RunView;
  // A crash here leaves the step's outcome unknown, so recovery never retries it.
  readonly inFlight: string | null;
};
export class RunStoreError extends Error {}
export const MAX_RUN_BYTES = 512 * 1024;
const filename = (requestId: string) => `${createHash('sha256').update(requestId).digest('hex')}.json`;

export class RunStore extends Context.Service<RunStore, {
  readonly read: Effect.Effect<readonly RunReceipt[], RunStoreError>;
  readonly write: (receipt: RunReceipt) => Effect.Effect<void, RunStoreError>;
}>()('agent/RunStore') {}

const decode = (text: string): RunReceipt => {
  if (Buffer.byteLength(text) > MAX_RUN_BYTES) throw new RunStoreError('Run receipt is too large');
  const raw = JSON.parse(text);
  const view = decodeRunView(raw.view);
  if (raw.version !== 1 || !Number.isSafeInteger(raw.sequence) || raw.sequence < 1
    || !['app', 'cli', 'mcp'].includes(raw.actor)
    || !(raw.inFlight === null || typeof raw.inFlight === 'string' && [...raw.inFlight].length <= 500)) {
    throw new RunStoreError('Invalid run receipt');
  }
  return { version: 1, sequence: raw.sequence, actor: raw.actor, view, inFlight: raw.inFlight };
};
const failure = (error: unknown) => new RunStoreError(error instanceof Error ? error.message : String(error));

// Atomic snapshots, keyed by request ID. Corruption fails closed rather than losing retry ownership.
export const runStore = Layer.effect(RunStore, Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const dir = join(paths.stateRoot, 'agent', 'runs');
  const writes = yield* Semaphore.make(1);
  return {
    read: Effect.gen(function* () {
      const receipts: RunReceipt[] = [];
      for (const name of (yield* fs.list(dir)) ?? []) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const text = yield* fs.readText(join(dir, name));
        const receipt = yield* Effect.try({ try: () => decode(text ?? ''), catch: failure });
        if (filename(receipt.view.intent.requestId) !== name) return yield* Effect.fail(new RunStoreError('Run receipt identity mismatch'));
        receipts.push(receipt);
      }
      return receipts;
    }).pipe(Effect.mapError(failure)),
    write: (receipt: RunReceipt) => Effect.gen(function* () {
      const text = JSON.stringify(receipt);
      yield* Effect.try({ try: () => decode(text), catch: failure });
      const path = join(dir, filename(receipt.view.intent.requestId));
      const before = yield* fs.readText(path);
      if (before !== undefined) {
        const previous = yield* Effect.try({ try: () => decode(before), catch: failure });
        const binding = (r: RunReceipt) => JSON.stringify([
          r.sequence, r.actor, r.view.runId, r.view.operation, r.view.scope.kind,
          r.view.intent.requestId, r.view.intent.inputDigest, r.view.intent.planId,
          r.view.intent.change.kind, r.view.intent.change.only, r.view.intentSaved,
        ]);
        if (binding(previous) !== binding(receipt)) return yield* Effect.fail(new RunStoreError('A run receipt binding cannot change'));
      }
      yield* fs.writeTextAtomic(path, text + '\n');
    }).pipe(Effect.mapError(failure), writes.withPermit),
  };
}));
