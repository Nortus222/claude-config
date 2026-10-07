import { join } from 'node:path';
import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { Fs, MachinePaths } from '@nortuscc/machine';
import { DecisionSchema, DisplayNameSchema, IdSchema, IsoTimeSchema, MachinePatchSchema, SequenceSchema, SetupCursorSchema,
  SyncedDecisionSchema, SyncMachineSchema, SyncRevisionSchema, SyncSetupSchema, decodeHosted, type SyncRevision } from '@nortuscc/hosted-protocol';
import { HOSTED_FAILURE_CODES, HostedFailure } from './transport.ts';

const OutboxEntrySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('decision'), decision: DecisionSchema, decidedAt: IsoTimeSchema }),
  Schema.Struct({ kind: Schema.Literal('machine'), patch: MachinePatchSchema }),
]);
export type OutboxEntry = typeof OutboxEntrySchema.Type;
const AccountSchema = Schema.Struct({
  accountId: IdSchema, login: DisplayNameSchema, machineId: IdSchema,
  auth: Schema.Literals(['signed-in', 'signed-out', 'unauthenticated']),
  seq: SequenceSchema, cursors: Schema.Array(SetupCursorSchema), setups: Schema.Array(SyncSetupSchema),
  authoritative: Schema.Array(SyncedDecisionSchema), outbox: Schema.Array(OutboxEntrySchema), machine: SyncMachineSchema,
  lastSyncAt: Schema.NullOr(IsoTimeSchema), retryAt: Schema.NullOr(IsoTimeSchema), pollAfter: SequenceSchema,
  error: Schema.NullOr(Schema.Literals(HOSTED_FAILURE_CODES)),
  etag: Schema.optionalKey(Schema.String),
});
export type HostedAccount = typeof AccountSchema.Type;
const StoreDocumentSchema = Schema.Struct({ version: Schema.Literal(1), activeAccountId: Schema.NullOr(IdSchema), accounts: Schema.Array(AccountSchema) }).check(
  Schema.makeFilter((doc) => new Set(doc.accounts.map((a) => a.accountId)).size === doc.accounts.length
    && (doc.activeAccountId === null || doc.accounts.some((a) => a.accountId === doc.activeAccountId))
    && doc.accounts.every((a) => new Set(a.cursors.map((c) => c.setupId)).size === a.cursors.length
      && new Set(a.setups.map((s) => s.setupId)).size === a.setups.length
      && new Set(a.authoritative.map((d) => `${d.setupId}:${d.itemId}`)).size === a.authoritative.length)),
);
export type HostedDocument = typeof StoreDocumentSchema.Type;
const CacheSchema = Schema.Struct({ version: Schema.Literal(1), accountId: IdSchema, setupId: IdSchema, revisions: Schema.Array(SyncRevisionSchema) }).check(
  Schema.makeFilter((cache) => cache.revisions.every((r, i) => r.setupId === cache.setupId && r.number === i + 1)),
);
const storageFailure = () => new HostedFailure({ code: 'storage' });
const decoded = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) => Effect.try({
  try: () => decodeHosted(schema, value), catch: storageFailure,
});

export class HostedStore extends Context.Service<HostedStore, {
  readonly read: Effect.Effect<HostedDocument, HostedFailure>;
  readonly update: (change: (document: HostedDocument) => HostedDocument) => Effect.Effect<HostedDocument, HostedFailure>;
  readonly revisions: (accountId: string, setupId: string) => Effect.Effect<ReadonlyArray<SyncRevision>, HostedFailure>;
  // Immutable, contiguous cache. Identical records already written before a crash may be replayed.
  readonly cache: (accountId: string, setupId: string, records: ReadonlyArray<SyncRevision>) => Effect.Effect<void, HostedFailure>;
}>()('hosted-client/HostedStore') {}

// Sync checkpoints/outbox share one atomic document; record files are written before checkpointing.
export const hostedStore = Layer.effect(HostedStore, Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const lock = yield* Semaphore.make(1);
  const statePath = join(paths.stateRoot, 'agent', 'sync.json');
  const parse = (text: string) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: storageFailure });
  const read = Effect.gen(function* () {
    const text = yield* fs.readText(statePath).pipe(Effect.mapError(storageFailure));
    return text === undefined ? { version: 1 as const, activeAccountId: null, accounts: [] } : yield* decoded(StoreDocumentSchema, yield* parse(text));
  });
  const cachePath = (accountId: string, setupId: string) => Effect.gen(function* () {
    yield* decoded(IdSchema, accountId); yield* decoded(IdSchema, setupId);
    return join(paths.stateRoot, 'agent', 'revisions', accountId, `${setupId}.json`);
  });
  const revisions = (accountId: string, setupId: string) => Effect.gen(function* () {
    const path = yield* cachePath(accountId, setupId);
    const text = yield* fs.readText(path).pipe(Effect.mapError(storageFailure));
    if (text === undefined) return [];
    const cache = yield* decoded(CacheSchema, yield* parse(text));
    if (cache.accountId !== accountId || cache.setupId !== setupId) return yield* Effect.fail(storageFailure());
    return cache.revisions;
  });
  return {
    read,
    update: (change: (document: HostedDocument) => HostedDocument) => Effect.gen(function* () {
      const before = yield* read;
      const next = yield* Effect.try({ try: () => change(before), catch: storageFailure }).pipe(Effect.flatMap((value) => decoded(StoreDocumentSchema, value)));
      yield* fs.writeTextAtomic(statePath, JSON.stringify(next, null, 2) + '\n').pipe(Effect.mapError(storageFailure));
      return next;
    }).pipe(lock.withPermit),
    revisions,
    cache: (accountId: string, setupId: string, records: ReadonlyArray<SyncRevision>) => Effect.gen(function* () {
      const path = yield* cachePath(accountId, setupId);
      const before = yield* revisions(accountId, setupId);
      const next = [...before];
      for (const record of records) {
        const checked = yield* decoded(SyncRevisionSchema, record).pipe(Effect.mapError(() => new HostedFailure({ code: 'invalid_response' })));
        if (checked.setupId !== setupId || checked.number > next.length + 1
          || (checked.number <= next.length && JSON.stringify(next[checked.number - 1]) !== JSON.stringify(checked))) {
          return yield* Effect.fail(new HostedFailure({ code: 'invalid_response' }));
        }
        if (checked.number === next.length + 1) next.push(checked);
      }
      yield* fs.writeTextAtomic(path, JSON.stringify({ version: 1, accountId, setupId, revisions: next }, null, 2) + '\n').pipe(Effect.mapError(storageFailure));
    }).pipe(lock.withPermit),
  };
}));
