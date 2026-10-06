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

// Why a held map is not a set of holds, or undefined when every entry is an item id with a commit.
const holdsProblem = (held: Record<string, unknown>): string | undefined => {
  for (const [itemId, commit] of Object.entries(held)) {
    if (parseItemId(itemId) === undefined) return `'${itemId}' is not an item id`;
    if (typeof commit !== 'string' || !COMMIT.test(commit)) return `the hold on '${itemId}' does not name a commit`;
  }
  return undefined;
};

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
  const reason = holdsProblem(parsed.held);
  if (reason !== undefined) return Effect.fail(new SyncStateInvalid({ path, reason }));
  return Effect.succeed(parsed.held as Holds);
};

export class SyncStore extends Context.Service<
  SyncStore,
  {
    readonly read: Effect.Effect<Holds, FsFailed | SyncStateInvalid>;
    readonly write: (held: Holds) => Effect.Effect<void, FsFailed | SyncStateInvalid>;
  }
>()('sync/SyncStore') {}

// <stateRoot>/sync.json, replaced atomically. `write` refuses an invalid existing file or invalid holds. Composition reads it; only `nortuscc sync` writes it.
export const syncStore = Layer.effect(
  SyncStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'sync.json');
    const read = Effect.flatMap(fs.readText(path), (text) => decodeSyncState(text, path));
    return {
      read,
      write: (held: Holds) =>
        Effect.gen(function* () {
          yield* read; // an invalid file is never overwritten
          const reason = holdsProblem(held);
          if (reason !== undefined) return yield* new SyncStateInvalid({ path, reason });
          const sorted = Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
          yield* fs.writeTextAtomic(path, JSON.stringify({ version: 1, held: sorted }, null, 2) + '\n');
        }),
    };
  }),
);
