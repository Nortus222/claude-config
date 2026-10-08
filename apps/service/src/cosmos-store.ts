import { Buffer } from 'node:buffer';
import { ConsistencyLevel, type Database, type OperationInput, type RequestOptions } from '@azure/cosmos';
import { Effect } from 'effect';
import type { ServiceDocument } from './documents.ts';
import { ServiceFailure } from './errors.ts';
import { PARTITION_MARKER_ID, type Container, type Mutation, type PartitionSnapshot, type Store } from './store.ts';
import { belongsTo, validMutations } from './store-validation.ts';
import { recoverExpiredDeviceSession } from './auth.ts';

// Leave room below Cosmos's 2 MB request limit for its batch serialization overhead.
export const MAX_COSMOS_BATCH_BYTES = 1_800_000;
const strong: RequestOptions = { consistencyLevel: ConsistencyLevel.Strong, bypassIntegratedCache: true };
const partitionFields = { accounts: 'accountId', setups: 'setupId', identities: 'id' } as const;
export const cosmosDocumentId = (id: string): string => `~${Buffer.from(id).toString('base64url')}`;

interface StoredDocument {
  id: string;
  accountId?: string;
  setupId?: string;
  payload?: ServiceDocument;
  closed?: boolean;
  ttl?: number;
  _etag?: string;
}

const unavailable = (retryAfter?: number) => new ServiceFailure({ code: 'unavailable', retryAfter });
const invalid = () => new ServiceFailure({ code: 'invalid' });
const errorDetails = (error: unknown): { status?: number; retryAfter?: number } => {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const entry = current as { code?: unknown; statusCode?: unknown; retryAfterInMs?: unknown; headers?: Record<string, unknown>; cause?: unknown };
    const status = Number(entry.statusCode ?? entry.code);
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      const milliseconds = Number(entry.retryAfterInMs ?? entry.headers?.['x-ms-retry-after-ms']);
      return { status, retryAfter: Number.isFinite(milliseconds) && milliseconds > 0 ? Math.ceil(milliseconds / 1000) : undefined };
    }
    current = entry.cause;
  }
  return {};
};
const failure = (error: unknown): ServiceFailure => error instanceof ServiceFailure ? error : unavailable(errorDetails(error).retryAfter);
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, ServiceFailure> => Effect.tryPromise({ try: run, catch: failure });
const conflict = (error: unknown): boolean => [404, 409, 412].includes(errorDetails(error).status ?? 0);
const validKey = (key: string): boolean => typeof key === 'string' && key.length > 0 && Buffer.from(key).toString() === key && Buffer.byteLength(key) <= 2048;
const validId = (id: string, container: Container): boolean => Buffer.from(id).toString() === id && (container === 'identities'
  ? !/[/#?\\]/.test(id) && Buffer.byteLength(id) <= 1023
  : Buffer.byteLength(cosmosDocumentId(id)) <= 1023);
const etag = (raw: StoredDocument | undefined): string | null => {
  if (!raw) return null;
  if (typeof raw._etag !== 'string' || !raw._etag) throw unavailable();
  return raw._etag;
};

/** Read-only prerequisite check. The embedder owns provisioning and must call this before serving. */
export const validateCosmosConfiguration = (database: Database, options: { readonly localEmulator?: boolean } = {}): Effect.Effect<void, ServiceFailure> => attempt(async () => {
  const account = await database.client.getDatabaseAccount();
  if (options.localEmulator) {
    const endpoint = new URL(await database.client.getWriteEndpoint());
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw unavailable();
  } else if (account.resource?.consistencyPolicy !== ConsistencyLevel.Strong) throw unavailable();
  for (const name of ['accounts', 'setups', 'identities'] as const) {
    const { resource } = await database.container(name).read();
    if (resource?.partitionKey?.paths.length !== 1 || resource.partitionKey.paths[0] !== `/${partitionFields[name]}`
      || (name === 'identities' ? resource.defaultTtl !== -1 : resource.defaultTtl !== undefined && resource.defaultTtl !== -1)) throw unavailable();
  }
});

export interface CosmosStoreOptions {
  readonly database: Database;
  readonly now?: () => number;
  readonly pageSize?: number;
  readonly maxSnapshotAttempts?: number;
}

export type CosmosStore = Store['Service'] & {
  readonly sweepExpiredDevices: () => Effect.Effect<void, ServiceFailure>;
};

/** Atomic partition writes and Strong marker-bookended reads over an injected SDK database. */
export const makeCosmosStore = ({ database, now = Date.now, pageSize = 100, maxSnapshotAttempts = 5 }: CosmosStoreOptions): CosmosStore => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxSnapshotAttempts) || maxSnapshotAttempts < 1) throw invalid();
  const point = async (container: Container, key: string, id: string): Promise<StoredDocument | undefined> => {
    try {
      const response = await database.container(container).item(id, key).read<StoredDocument>(strong);
      if (response.statusCode === 404) return undefined;
      return response.resource;
    } catch (error) {
      if (errorDetails(error).status === 404) return undefined;
      throw error;
    }
  };
  const payload = (raw: StoredDocument, container: Container, key: string): ServiceDocument => {
    const document = raw.payload;
    if (!document || !belongsTo(document, container, key) || document.id === PARTITION_MARKER_ID
      || raw.id !== (container === 'identities' ? document.id : cosmosDocumentId(document.id))
      || raw[partitionFields[container]] !== key) throw unavailable();
    return structuredClone(document);
  };
  const snapshot = async (container: Container, key: string): Promise<PartitionSnapshot> => {
    if (!validKey(key) || (container === 'identities' && !validId(key, container))) throw invalid();
    if (container === 'identities') {
      const raw = await point(container, key, key);
      return { version: etag(raw), closed: false, documents: raw ? [payload(raw, container, key)] : [] };
    }
    for (let count = 0; count < maxSnapshotAttempts; count++) {
      const before = await point(container, key, PARTITION_MARKER_ID);
      const iterator = database.container(container).items.query<StoredDocument>({
        query: `SELECT * FROM c WHERE c.${partitionFields[container]} = @key AND c.id != @marker`,
        parameters: [{ name: '@key', value: key }, { name: '@marker', value: PARTITION_MARKER_ID }],
      }, { ...strong, partitionKey: key, maxItemCount: pageSize });
      const documents: ServiceDocument[] = [];
      while (iterator.hasMoreResults()) {
        const page = await iterator.fetchNext();
        for (const raw of page.resources) documents.push(payload(raw, container, key));
      }
      const after = await point(container, key, PARTITION_MARKER_ID);
      if (etag(before) !== etag(after)) continue;
      if ((!after && documents.length) || (after && (typeof after.closed !== 'boolean' || after[partitionFields[container]] !== key))) throw unavailable();
      return { version: etag(after), closed: after?.closed ?? false, documents };
    }
    throw unavailable();
  };
  const stored = (container: Container, key: string, document: ServiceDocument): StoredDocument => ({
    id: container === 'identities' ? document.id : cosmosDocumentId(document.id),
    ...(container === 'identities' ? {} : { [partitionFields[container]]: key }),
    payload: structuredClone(document),
    ...(document.type === 'deviceSession' ? { ttl: document.claim ? -1 : Math.max(1, Math.ceil((document.expiresAt - now()) / 1000)) } : {}),
  });
  const batch = async (container: Container, key: string, operations: OperationInput[]): Promise<boolean> => {
    if (Buffer.byteLength(JSON.stringify(operations)) > MAX_COSMOS_BATCH_BYTES) throw new ServiceFailure({ code: 'payload_too_large' });
    try {
      const response = await database.container(container).items.batch(operations, key, strong);
      const failures = response.result?.filter((result) => result.statusCode >= 400) ?? [];
      // 424 only describes rolled-back siblings; classify the actual failing operation.
      const root = failures.find((result) => result.statusCode !== 424);
      if (root) {
        if ([404, 409, 412].includes(root.statusCode)) return false;
        throw unavailable(errorDetails({ statusCode: root.statusCode, headers: response.headers }).retryAfter);
      }
      if (failures.length || (response.code ?? 500) >= 400 || response.result?.length !== operations.length) throw unavailable();
      return true;
    } catch (error) {
      if (conflict(error)) return false;
      throw error;
    }
  };
  const marker = (container: 'accounts' | 'setups', key: string, closed: boolean) => ({ id: PARTITION_MARKER_ID, [partitionFields[container]]: key, closed });
  const commit = async (container: Container, key: string, expectedVersion: string | null, mutations: ReadonlyArray<Mutation>): Promise<boolean> => {
    if (!validKey(key) || !validMutations(container, key, mutations)
      || mutations.some((mutation) => !validId(mutation.type === 'upsert' ? mutation.document.id : mutation.id, container))) throw invalid();
    if (Buffer.byteLength(JSON.stringify(mutations)) > MAX_COSMOS_BATCH_BYTES) throw new ServiceFailure({ code: 'payload_too_large' });
    const current = await snapshot(container, key);
    if (current.version !== expectedVersion || (current.closed && mutations.some((mutation) => mutation.type === 'upsert'))) return false;
    if (container === 'identities') {
      const mutation = mutations[0];
      if (!mutation || (mutation.type === 'delete' && current.version === null)) return true;
      const target = database.container(container);
      try {
        const options = { ...strong, accessCondition: { type: 'IfMatch', condition: current.version! } };
        if (mutation.type === 'delete') await target.item(key, key).delete(options);
        else if (current.version === null) await target.items.create(stored(container, key, mutation.document), strong);
        else await target.item(key, key).replace(stored(container, key, mutation.document), options);
        return true;
      } catch (error) {
        if (conflict(error)) return false;
        throw error;
      }
    }
    const ids = new Set(current.documents.map(({ id }) => id));
    const operations: OperationInput[] = [];
    for (const mutation of mutations) {
      if (mutation.type === 'delete') {
        if (ids.delete(mutation.id)) operations.push({ operationType: 'Delete', id: cosmosDocumentId(mutation.id) });
      } else {
        ids.add(mutation.document.id);
        operations.push({ operationType: 'Upsert', resourceBody: JSON.parse(JSON.stringify(stored(container, key, mutation.document))) });
      }
    }
    if (ids.size === 0 && !current.closed) {
      if (current.version === null) return true;
      // SDK's DeleteOperationInput omits ifMatch, but batch wire serialization supports it.
      const remove = { operationType: 'Delete' as const, id: PARTITION_MARKER_ID, ifMatch: current.version };
      operations.unshift(remove);
    } else {
      const resourceBody = marker(container, key, current.closed);
      operations.unshift(current.version === null ? { operationType: 'Create', resourceBody }
        : { operationType: 'Replace', id: PARTITION_MARKER_ID, resourceBody, ifMatch: current.version });
    }
    return batch(container, key, operations);
  };
  const store: CosmosStore = {
    readPartition: (container, key) => attempt(() => snapshot(container, key)),
    commitPartition: (container, key, version, mutations) => attempt(() => commit(container, key, version, mutations)),
    closePartition: (container, key, version) => attempt(async () => {
      if (!validKey(key) || (container !== 'accounts' && container !== 'setups')) throw invalid();
      const current = await snapshot(container, key);
      if (current.version !== version) return false;
      if (current.closed) return true;
      const resourceBody = marker(container, key, true);
      return batch(container, key, [version === null ? { operationType: 'Create', resourceBody }
        : { operationType: 'Replace', id: PARTITION_MARKER_ID, ifMatch: version, resourceBody }]);
    }),
    // The caller owns scheduling and retries after interruption; scan rows are only candidates.
    sweepExpiredDevices: () => Effect.gen(function* () {
      const cutoff = now();
      const iterator = yield* attempt(async () => database.container('identities').items.query<{ id: string }>({
        query: "SELECT c.id FROM c WHERE c.payload.type = 'deviceSession' AND c.payload.expiresAt <= @now",
        parameters: [{ name: '@now', value: cutoff }],
      }, { ...strong, maxItemCount: pageSize }));
      const keys: string[] = [];
      while (iterator.hasMoreResults()) {
        const page = yield* attempt(() => iterator.fetchNext());
        for (const candidate of page.resources) keys.push(candidate.id);
      }
      // Deleting during pagination can shift continuation offsets and skip candidates.
      for (const key of keys) yield* recoverExpiredDeviceSession(store, key, cutoff);
    }),
  };
  return store;
};
