import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import type { ServiceDocument } from './documents.ts';
import { ServiceFailure } from './errors.ts';
import { MAX_PARTITION_MUTATIONS, PARTITION_MARKER_ID, Store, type Container, type Mutation, type PartitionSnapshot } from './store.ts';

const belongsTo = (document: ServiceDocument, container: Container, key: string): boolean => {
  switch (document.type) {
    case 'account': case 'machine': case 'decision': case 'status':
      return container === 'accounts' && document.accountId === key;
    case 'setup': case 'revision':
      return container === 'setups' && document.setupId === key;
    case 'identity': case 'deviceSession':
      return container === 'identities' && document.id === key;
  }
};

const validMutations = (container: Container, key: string, mutations: ReadonlyArray<Mutation>): boolean => {
  if (!key || mutations.length > MAX_PARTITION_MUTATIONS) return false;
  const targets = new Set<string>();
  for (const mutation of mutations) {
    const id = mutation.type === 'upsert' ? mutation.document.id : mutation.id;
    if (!id || id === PARTITION_MARKER_ID || targets.has(id)) return false;
    if (container === 'identities' && id !== key) return false;
    if (mutation.type === 'upsert' && !belongsTo(mutation.document, container, key)) return false;
    targets.add(id);
  }
  return true;
};

export const makeMemoryStore = (): Store['Service'] => {
  const containers = new Map<Container, Map<string, PartitionSnapshot>>();
  return {
    readPartition: (container, key) => Effect.sync(() =>
      structuredClone(containers.get(container)?.get(key) ?? { version: null, documents: [] })),
    commitPartition: (container, key, expectedVersion, mutations) => Effect.suspend(() => {
      if (!validMutations(container, key, mutations)) return Effect.fail(new ServiceFailure({ code: 'invalid' }));
      const partitions = containers.get(container) ?? new Map<string, PartitionSnapshot>();
      const current = partitions.get(key);
      if ((current?.version ?? null) !== expectedVersion) return Effect.succeed(false);
      const documents = new Map(current?.documents.map((document) => [document.id, document]));
      for (const mutation of mutations) {
        if (mutation.type === 'delete') documents.delete(mutation.id);
        else documents.set(mutation.document.id, structuredClone(mutation.document));
      }
      if (documents.size === 0) partitions.delete(key);
      else partitions.set(key, { version: randomUUID(), documents: [...documents.values()] });
      containers.set(container, partitions);
      return Effect.succeed(true);
    }),
  };
};

export const memoryStore = (): Layer.Layer<Store> => Layer.succeed(Store, makeMemoryStore());
