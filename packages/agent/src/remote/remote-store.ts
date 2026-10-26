import { join } from 'node:path';
import { Context, Deferred, Effect, Layer, Ref, Semaphore } from 'effect';
import { Backups, backupsForRun, Fs, MachinePaths, type FsFailed } from '@nortuscc/machine';
import { TailscaleAccess, type TailscaleState } from './tailscale.ts';

export const MAX_KNOWN = 64;
export type KnownMachine = { readonly nodeId: string; readonly name: string; readonly os: string; readonly lastReachedAt: string };
export type RemoteState = { readonly version: 1; readonly enabled: boolean; readonly known: ReadonlyArray<KnownMachine> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isKnown = (value: unknown): value is KnownMachine => isRecord(value)
  && typeof value.nodeId === 'string' && typeof value.name === 'string' && typeof value.os === 'string' && typeof value.lastReachedAt === 'string';

export class RemoteStore extends Context.Service<
  RemoteStore,
  {
    readonly get: Effect.Effect<RemoteState, FsFailed>;
    readonly setEnabled: (enabled: boolean) => Effect.Effect<RemoteState, FsFailed>;
    // A wait that completes on the next `setEnabled` after this is read.
    readonly changed: Effect.Effect<Effect.Effect<void>>;
    // Adds or refreshes machines by nodeId; keeps the 64 most recently reached.
    readonly remember: (machines: ReadonlyArray<KnownMachine>) => Effect.Effect<RemoteState, FsFailed>;
    // Whether the listener is accepting callers; in memory only, set by the listener.
    readonly listening: Effect.Effect<boolean>;
    readonly setListening: (listening: boolean) => Effect.Effect<void>;
  }
>()('agent/RemoteStore') {}

// <stateRoot>/agent/remote.json. A missing or malformed file reads as disabled with no known machines;
// a malformed one is backed up before the next write replaces it.
export const remoteStore = Layer.effect(RemoteStore, Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const path = join(paths.stateRoot, 'agent', 'remote.json');
  const lock = yield* Semaphore.make(1);
  const listening = yield* Ref.make(false);
  const change = yield* Ref.make(yield* Deferred.make<void>());
  const signal = Effect.flatMap(Deferred.make<void>(), (next) => Effect.flatMap(Ref.getAndSet(change, next), (current) => Deferred.succeed(current, undefined)));
  const backups = backupsForRun().pipe(Layer.provide(Layer.mergeAll(Layer.succeed(MachinePaths, paths), Layer.succeed(Fs, fs))));
  const load = Effect.gen(function* () {
    const text = yield* fs.readText(path);
    const empty: RemoteState = { version: 1, enabled: false, known: [] };
    if (text === undefined) return { state: empty, malformed: false };
    try {
      const value: unknown = JSON.parse(text);
      if (isRecord(value) && value.version === 1 && typeof value.enabled === 'boolean' && Array.isArray(value.known)) {
        return { state: { version: 1, enabled: value.enabled, known: value.known.filter(isKnown).slice(0, MAX_KNOWN).map(({ nodeId, name, os, lastReachedAt }) => ({ nodeId, name, os, lastReachedAt })) } satisfies RemoteState, malformed: false };
      }
    } catch { /* malformed */ }
    return { state: empty, malformed: true };
  });
  const update = (f: (state: RemoteState) => RemoteState) => Effect.gen(function* () {
    const { state, malformed } = yield* load;
    if (malformed) yield* Backups.use((b) => b.preserve(path, 'agent/remote.json')).pipe(Effect.provide(backups));
    const next = f(state);
    yield* fs.writeTextAtomic(path, JSON.stringify(next, null, 2) + '\n');
    return next;
  }).pipe(lock.withPermit);
  return {
    get: Effect.map(load, (r) => r.state),
    setEnabled: (enabled) => update((s) => ({ ...s, enabled })).pipe(Effect.tap(() => signal)),
    changed: Effect.map(Ref.get(change), (current) => Deferred.await(current)),
    remember: (machines) => update((s) => {
      const byId = new Map(s.known.map((k) => [k.nodeId, k]));
      for (const m of machines) byId.set(m.nodeId, m);
      const known = [...byId.values()].sort((a, b) => b.lastReachedAt.localeCompare(a.lastReachedAt)).slice(0, MAX_KNOWN);
      return { ...s, known };
    }),
    listening: Ref.get(listening),
    setListening: (value) => Ref.set(listening, value),
  };
}));

export type RemoteAccessView = { enabled: boolean; tailscale: TailscaleState; self: { name: string; login: string } | null; listening: boolean };

// The switch, Tailscale's state on this machine, and whether the listener is up.
export const remoteAccessView = Effect.gen(function* () {
  const store = yield* RemoteStore;
  const status = yield* (yield* TailscaleAccess).status();
  const state = yield* store.get;
  return {
    enabled: state.enabled,
    tailscale: typeof status === 'string' ? status : 'ready',
    self: typeof status === 'string' ? null : { name: status.self.hostName, login: status.self.login },
    listening: yield* store.listening,
  } satisfies RemoteAccessView;
});
