import { Context, type Effect } from 'effect';
import type { ServiceDocument } from './documents.ts';
import type { ServiceFailure } from './errors.ts';

export type Container = 'accounts' | 'setups' | 'identities';
export const MAX_PARTITION_MUTATIONS = 99;
export const PARTITION_MARKER_ID = '__partition';

export interface PartitionSnapshot {
  // Opaque concurrency token, Cosmos ETag in a persistent adapter; null means absent.
  readonly version: string | null;
  readonly closed: boolean;
  readonly documents: ReadonlyArray<ServiceDocument>;
}

export type Mutation = { readonly type: 'upsert'; readonly document: ServiceDocument }
  | { readonly type: 'delete'; readonly id: string };

export class Store extends Context.Service<Store, {
  // Collect every page under a stable marker before returning detached documents.
  readonly readPartition: (container: Container, key: string) => Effect.Effect<PartitionSnapshot, ServiceFailure>;
  // One partition only. At most 99 distinct document targets plus its concurrency marker.
  // Conflict or an upsert into a closed partition returns false, with no writes.
  // Empty closed markers persist; other empty partitions remove their marker.
  readonly commitPartition: (container: Container, key: string, expectedVersion: string | null,
    mutations: ReadonlyArray<Mutation>) => Effect.Effect<boolean, ServiceFailure>;
  // Terminal CAS fence, including absent targets. Retains documents for bounded delete-only sweeps.
  // Persistent markers contain only the opaque partition ID, closed flag and concurrency version.
  readonly closePartition: (container: 'accounts' | 'setups', key: string,
    expectedVersion: string | null) => Effect.Effect<boolean, ServiceFailure>;
}>()('hosted/Store') {}
