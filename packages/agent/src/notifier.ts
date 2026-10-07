import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Effect, Semaphore } from 'effect';
import { Fs, HistoryStore, MachinePaths, Processes } from '@nortuscc/machine';
import { AgentStateStore } from './state.ts';
import type { AgentStatus } from './job.ts';

export type Notification = { readonly id: string; readonly title: string; readonly body: string };
export type Notifier = {
  readonly notify: (status: AgentStatus) => Effect.Effect<void>;
  readonly get: (id: string) => Effect.Effect<Notification | undefined>;
  readonly receipt: (id: string) => string | undefined;
  readonly acknowledge: (id: string, delivered: boolean, receipt: string) => boolean;
  readonly setConnected: (deliver: ((notification: Notification) => Effect.Effect<boolean>) | undefined) => void;
};
type Batch = { notification: Notification; identities: string[]; delivered: boolean };
type Store = { version: 1; batches: Record<string, Batch> };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (ids: readonly string[]) => createHash('sha256').update(JSON.stringify([...new Set(ids)].sort())).digest('hex');
const identity = (...parts: string[]) => JSON.stringify(parts);

// Invalid state is preserved, never silently replaced with an empty delivery ledger.
const decode = (text: string | undefined): Store | undefined => {
  if (text === undefined) return { version: 1, batches: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (!record(value) || value.version !== 1 || !record(value.batches)) return undefined;
    for (const [id, batch] of Object.entries(value.batches)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !record(batch) || !record(batch.notification)
        || batch.notification.id !== id || typeof batch.notification.title !== 'string' || batch.notification.title.length > 100
        || typeof batch.notification.body !== 'string' || batch.notification.body.length > 500
        || typeof batch.delivered !== 'boolean' || !Array.isArray(batch.identities) || !batch.identities.every((v) => typeof v === 'string')
        || hash(batch.identities) !== id) return undefined;
    }
    return value as Store;
  } catch { return undefined; }
};

// Delivery and persistence cannot be atomic: a crash after OS posting but before writing the ACK
// can repeat a notification. Persisting before posting instead would lose undelivered batches.
export const makeNotifier = (options: { readonly platform: string; readonly timeoutMs?: number }) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const processes = yield* Processes;
  const state = yield* AgentStateStore;
  const history = yield* HistoryStore;
  const lock = yield* Semaphore.make(1);
  const path = join(paths.stateRoot, 'agent', 'notified.json');
  const timeoutMs = options.timeoutMs ?? 5000;
  let connected: ((notification: Notification) => Effect.Effect<boolean>) | undefined;
  const waiters = new Map<string, { receipt: string; deadline: number; resume: (delivered: boolean) => void }>();
  const read = Effect.map(fs.readText(path), decode);
  const save = (store: Store) => fs.writeTextAtomic(path, JSON.stringify(store, null, 2) + '\n');
  const attempt = <E>(effect: Effect.Effect<boolean, E>): Effect.Effect<boolean> => effect.pipe(
    Effect.timeout(timeoutMs), Effect.catchCause(() => Effect.succeed(false)),
  );
  const deliver = (notification: Notification) => Effect.gen(function* () {
    const current = connected;
    if (current !== undefined && (yield* attempt(Effect.suspend(() => current(notification))))) return true;
    const registered = yield* state.read.pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (registered?.installedBy === 'app' && registered.appPath && isAbsolute(registered.appPath)) {
      const executable = registered.appPath;
      const bundle = options.platform === 'darwin' ? executable.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/)?.[1] : undefined;
      if (options.platform !== 'darwin' || bundle !== undefined) {
        // Install the waiter synchronously before invoking Processes: a fast helper can ACK inside run.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const acknowledged = new Promise<boolean>((resolve) => {
          waiters.set(notification.id, { receipt: randomUUID(), deadline: Date.now() + timeoutMs, resume: resolve });
          timer = setTimeout(() => { waiters.delete(notification.id); resolve(false); }, timeoutMs);
        });
        const launch = processes.run({ cmd: bundle === undefined ? executable : 'open',
          args: bundle === undefined ? ['--notify', notification.id] : ['-g', '-a', bundle, '--args', '--notify', notification.id],
          output: 'capture', stderr: 'capture' });
        const posted = yield* Effect.gen(function* () {
          const launched = yield* attempt(Effect.map(launch, (result) => result.code === 0));
          return launched ? yield* Effect.promise(() => acknowledged) : false;
        }).pipe(Effect.ensuring(Effect.sync(() => { clearTimeout(timer); waiters.delete(notification.id); })));
        if (posted) return true;
      }
    }
    if (options.platform === 'linux') return yield* attempt(Effect.map(processes.run({ cmd: 'notify-send', args: ['--', notification.title, notification.body], output: 'capture', stderr: 'capture' }), (result) => result.code === 0));
    return false;
  });
  const notify = (status: AgentStatus) => Effect.gen(function* () {
    const store = yield* read;
    if (store === undefined) return;
    const events = yield* history.read;
    const freshFailures: string[] = [];
    for (const event of events) {
      if (event.kind === 'apply-finished' && event.steps.some((step) => step.outcome === 'failed')) freshFailures.push(identity('apply-failed', event.runId));
      if (event.kind === 'paused') freshFailures.push(identity('paused', event.runId ?? event.at, event.reason));
      if (event.kind === 'revision-rejected') freshFailures.push(identity('revision-rejected', event.setupId, event.revision));
    }
    if (status.paused) freshFailures.push(identity('paused', status.paused.runId ?? status.paused.at, status.paused.reason));
    if (status.error) freshFailures.push(identity('inspection-error', status.error, status.detail ?? ''));
    for (const error of status.probeErrors) freshFailures.push(identity('probe-error', error));
    const post = (batch: Batch) => Effect.gen(function* () {
      if (batch.delivered) return;
      if (yield* deliver(batch.notification)) {
        batch.delivered = true;
        yield* save(store);
      }
    });
    const pending = status.pending.filter((p) => p.verdict.kind === 'held' || status.policy === 'notify');
    const currentItems = pending.map((p) => identity('item', p.itemId));
    const currentHash = hash(currentItems);
    for (const batch of Object.values(store.batches)) {
      const itemBatch = batch.identities.some((id) => id.startsWith('["item",'));
      // A person may already have applied items while their earlier delivery was unavailable.
      if (!itemBatch || batch.notification.id === currentHash) yield* post(batch);
    }
    const add = (identities: string[], title: string, body: string) => Effect.gen(function* () {
      if (identities.length === 0) return;
      const unique = [...new Set(identities)].sort();
      const id = hash(unique);
      if (Object.hasOwn(store.batches, id)) return;
      const batch: Batch = { notification: { id, title: title.slice(0, 100), body: body.slice(0, 500) }, identities: unique, delivered: false };
      store.batches[id] = batch;
      yield* save(store); // Lookup payload is durable before either app delivery path starts.
      yield* post(batch);
    });
    yield* add(currentItems, 'Review & apply', `${new Set(pending.map((p) => p.itemId)).size} items need review.`);
    // Pending failure payloads already cover these identities even when delivery is unavailable.
    const queued = new Set(Object.values(store.batches).flatMap((b) => b.identities));
    yield* add(freshFailures.filter((id) => !queued.has(id)), 'Agent needs review', status.detail ?? status.paused?.reason ?? 'An apply, inspection, or revision verification needs review.');
  }).pipe(lock.withPermit, Effect.catchCause(() => Effect.void));
  return {
    notify,
    get: (id: string) => Effect.map(read, (store) => store?.batches[id]?.notification).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
    receipt: (id: string) => {
      const waiter = waiters.get(id);
      return waiter !== undefined && Date.now() < waiter.deadline ? waiter.receipt : undefined;
    },
    acknowledge: (id: string, delivered: boolean, receipt: string) => {
      const waiter = waiters.get(id);
      if (waiter === undefined || waiter.receipt !== receipt || Date.now() >= waiter.deadline) return false;
      waiters.delete(id); waiter.resume(delivered); return true;
    },
    setConnected: (callback) => { connected = callback; },
  } satisfies Notifier;
});
