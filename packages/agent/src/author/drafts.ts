import { join } from 'node:path';
import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { Backups, Fs, MachinePaths } from '@nortuscc/machine';
import { IntentSchema } from './intents.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
export const DraftSchema = Schema.Struct({
  version: Schema.Literal(1), id: Schema.String.check(Schema.isPattern(UUID)),
  repoUrl: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String.check(Schema.makeFilter(value => Number.isFinite(Date.parse(value)))),
  intents: Schema.Array(IntentSchema),
});
export type Draft = typeof DraftSchema.Type;
export type DraftListEntry = Draft | { readonly id: string; readonly error: string };
export class DraftStoreError extends Error {}
const failure = (error: unknown) => new DraftStoreError(error instanceof Error ? error.message : String(error));
const decode = Schema.decodeUnknownSync(DraftSchema);

export class DraftStore extends Context.Service<DraftStore, {
  readonly list: () => Effect.Effect<DraftListEntry[], DraftStoreError>;
  readonly read: (id: string) => Effect.Effect<Draft | undefined, DraftStoreError>;
  readonly write: (draft: Draft) => Effect.Effect<void, DraftStoreError>;
  readonly delete: (id: string) => Effect.Effect<void, DraftStoreError>;
}>()('agent/author/DraftStore') {}

// Atomic local draft snapshots. Replacements and deletion preserve the previous draft first.
export const draftStore = Layer.effect(DraftStore, Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const backups = yield* Backups;
  const writes = yield* Semaphore.make(1);
  const dir = join(paths.stateRoot, 'agent', 'author', 'drafts');
  const pathFor = (id: string) => Effect.try({ try: () => {
    if (!UUID.test(id)) throw new DraftStoreError('Invalid draft ID');
    return join(dir, `${id}.json`);
  }, catch: failure });
  const read = (id: string) => Effect.gen(function* () {
    const path = yield* pathFor(id);
    const text = yield* fs.readText(path);
    if (text === undefined) return undefined;
    const draft = yield* Effect.try({ try: () => decode(JSON.parse(text)), catch: failure });
    if (draft.id !== id) return yield* Effect.fail(new DraftStoreError('Draft identity mismatch'));
    return draft;
  }).pipe(Effect.mapError(failure));
  return {
    read,
    list: () => Effect.gen(function* () {
      const drafts: DraftListEntry[] = [];
      for (const name of (yield* fs.list(dir)) ?? []) {
        if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
        const id = name.slice(0, -5);
        const draft = yield* read(id).pipe(Effect.catch(error => Effect.succeed({ id, error: error.message })));
        if (draft !== undefined) drafts.push(draft);
      }
      return drafts;
    }).pipe(Effect.mapError(failure)),
    write: (draft: Draft) => Effect.gen(function* () {
      const path = yield* pathFor(draft.id);
      if (yield* fs.exists(path)) yield* backups.preserve(path, join('agent', 'author', 'drafts', `${draft.id}.json`));
      yield* fs.writeTextAtomic(path, JSON.stringify(draft, null, 2) + '\n');
    }).pipe(Effect.mapError(failure), writes.withPermit),
    delete: (id: string) => Effect.gen(function* () {
      const path = yield* pathFor(id);
      if (yield* fs.exists(path)) yield* backups.preserve(path, join('agent', 'author', 'drafts', `${id}.json`));
      yield* fs.remove(path);
    }).pipe(Effect.mapError(failure), writes.withPermit),
  };
}));
