import { parseItemId, type ItemKind } from '@nortuscc/hosted-protocol';
import { resolvedItemValues } from './resolved-items.ts';
import { desiredOfDocuments, hasProfile, type Documents } from './documents.ts';

export { parseItemId, type ItemKind, type ItemRef } from '@nortuscc/hosted-protocol';

// Each item's value in a setup as a comparable string; an absent item has no entry.
export type ItemValues = ReadonlyMap<string, string>;
export type ItemChange = {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly before: string | undefined;
  readonly after: string | undefined;
};

// Resolve without machine overrides so local choices cannot hide incoming profile changes.
export const itemValues = (documents: Documents, profile?: string): ItemValues =>
  hasProfile(documents, profile) ? resolvedItemValues(desiredOfDocuments(documents, undefined, profile), documents) : new Map();

// Every item whose value differs between two setups, sorted by id, with both values.
export const diffItems = (from: ItemValues, to: ItemValues): ReadonlyArray<ItemChange> =>
  [...new Set([...from.keys(), ...to.keys()])].sort().flatMap((itemId): ItemChange[] => {
    const before = from.get(itemId);
    const after = to.get(itemId);
    const ref = parseItemId(itemId);
    return before === after || ref === undefined ? [] : [{ itemId, kind: ref.kind, before, after }];
  });
