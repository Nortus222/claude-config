import type { ServiceDocument } from './documents.ts';
import { MAX_PARTITION_MUTATIONS, PARTITION_MARKER_ID, type Container, type Mutation } from './store.ts';

export const belongsTo = (document: ServiceDocument, container: Container, key: string): boolean => {
  switch (document.type) {
    case 'account': case 'machine': case 'issuanceFence': case 'deviceReservation': case 'decision': case 'status':
      return container === 'accounts' && document.accountId === key;
    case 'setup': case 'revision':
      return container === 'setups' && document.setupId === key;
    case 'identity': case 'deviceSession':
      return container === 'identities' && document.id === key;
  }
};

export const validMutations = (container: Container, key: string, mutations: ReadonlyArray<Mutation>): boolean => {
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
