import { Context, type Effect } from 'effect';
import type { ServiceDocument } from './documents.ts';
import type { ServiceFailure } from './errors.ts';

export type Container = 'accounts' | 'setups' | 'identities';
export const MAX_PARTITION_MUTATIONS = 99;
export const PARTITION_MARKER_ID = '__partition';

export interface PartitionSnapshot {
  // Opaque concurrency token, Cosmos ETag in a persistent adapter; null means absent.
  readonly version: string | null;
  readonly documents: ReadonlyArray<ServiceDocument>;
}

export type Mutation = { readonly type: 'upsert'; readonly document: ServiceDocument }
  | { readonly type: 'delete'; readonly id: string };

export class Store extends Context.Service<Store, {
  // Collect every page under a stable marker before returning detached documents.
  readonly readPartition: (container: Container, key: string) => Effect.Effect<PartitionSnapshot, ServiceFailure>;
  // One partition only. At most 99 distinct document targets plus its concurrency marker.
  // Conflict returns false, with no writes. Deleting the last document removes the marker.
  readonly commitPartition: (container: Container, key: string, expectedVersion: string | null,
    mutations: ReadonlyArray<Mutation>) => Effect.Effect<boolean, ServiceFailure>;
}>()('hosted/Store') {}
