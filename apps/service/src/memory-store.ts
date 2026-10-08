import { randomUUID } from 'node:crypto';
import { Effect, Layer } from 'effect';
import { validMutations } from './store-validation.ts';
import { ServiceFailure } from './errors.ts';
import { Store, type Container, type PartitionSnapshot } from './store.ts';

export const makeMemoryStore = (): Store['Service'] => {
  const containers = new Map<Container, Map<string, PartitionSnapshot>>();
  return {
    readPartition: (container, key) => Effect.sync(() =>
      structuredClone(containers.get(container)?.get(key) ?? { version: null, closed: false, documents: [] })),
    closePartition: (container, key, expectedVersion) => Effect.suspend(() => {
      if (!key || (container !== 'accounts' && container !== 'setups')) return Effect.fail(new ServiceFailure({ code: 'invalid' }));
      const partitions = containers.get(container) ?? new Map<string, PartitionSnapshot>();
      const current = partitions.get(key);
      if ((current?.version ?? null) !== expectedVersion) return Effect.succeed(false);
      if (!current?.closed) partitions.set(key, { version: randomUUID(), closed: true, documents: current?.documents ?? [] });
      containers.set(container, partitions);
      return Effect.succeed(true);
    }),
    commitPartition: (container, key, expectedVersion, mutations) => Effect.suspend(() => {
      if (!validMutations(container, key, mutations)) return Effect.fail(new ServiceFailure({ code: 'invalid' }));
      const partitions = containers.get(container) ?? new Map<string, PartitionSnapshot>();
      const current = partitions.get(key);
      if ((current?.version ?? null) !== expectedVersion) return Effect.succeed(false);
      if (current?.closed && mutations.some((mutation) => mutation.type === 'upsert')) return Effect.succeed(false);
      const documents = new Map(current?.documents.map((document) => [document.id, document]));
      for (const mutation of mutations) {
        if (mutation.type === 'delete') documents.delete(mutation.id);
        else documents.set(mutation.document.id, structuredClone(mutation.document));
      }
      if (documents.size === 0 && !current?.closed) partitions.delete(key);
      else partitions.set(key, { version: randomUUID(), closed: current?.closed ?? false, documents: [...documents.values()] });
      containers.set(container, partitions);
      return Effect.succeed(true);
    }),
  };
};

export const memoryStore = (): Layer.Layer<Store> => Layer.succeed(Store, makeMemoryStore());
