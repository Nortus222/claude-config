import { join } from 'node:path';
import { Context, Data, Effect, Layer } from 'effect';
import { Fs, MachinePaths, type FsFailed } from '@nortuscc/machine';
import { parseItemId } from './items.ts';

// Held items: each item id maps to the commit whose value this machine keeps.
export type Holds = Readonly<Record<string, string>>;

// sync.json exists but is not a sync file; nothing rewrites it until a person fixes it.
export class SyncStateInvalid extends Data.TaggedError('SyncStateInvalid')<{ readonly path: string; readonly reason: string }> {
  override get message() {
    return `${this.path} is not valid (${this.reason}), so nothing was changed; fix it by hand and re-run.`;
  }
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// All or nothing, like overrides.json: one unreadable hold makes the whole file the person's to fix.
export const decodeSyncState = (text: string | undefined, path: string): Effect.Effect<Holds, SyncStateInvalid> => {
  if (text === undefined) return Effect.succeed({});
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return Effect.fail(new SyncStateInvalid({ path, reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }));
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.held)) {
    return Effect.fail(new SyncStateInvalid({ path, reason: 'expected { "version": 1, "held": { ... } }' }));
  }
  for (const [itemId, commit] of Object.entries(parsed.held)) {
    if (parseItemId(itemId) === undefined) return Effect.fail(new SyncStateInvalid({ path, reason: `'${itemId}' is not an item id` }));
    if (typeof commit !== 'string' || !COMMIT.test(commit)) {
      return Effect.fail(new SyncStateInvalid({ path, reason: `the hold on '${itemId}' does not name a commit` }));
    }
  }
  return Effect.succeed(parsed.held as Holds);
};

export class SyncStore extends Context.Service<
  SyncStore,
  {
    readonly read: Effect.Effect<Holds, FsFailed | SyncStateInvalid>;
    readonly write: (held: Holds) => Effect.Effect<void, FsFailed>;
  }
>()('sync/SyncStore') {}

// <stateRoot>/sync.json, replaced atomically. Composition reads it; only `nortuscc sync` writes it.
export const syncStore = Layer.effect(
  SyncStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'sync.json');
    return {
      read: Effect.flatMap(fs.readText(path), (text) => decodeSyncState(text, path)),
      write: (held: Holds) => {
        const sorted = Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        return fs.writeTextAtomic(path, JSON.stringify({ version: 1, held: sorted }, null, 2) + '\n');
      },
    };
  }),
);
