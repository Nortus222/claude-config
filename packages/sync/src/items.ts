import { parseItemId, type ItemKind } from '@nortuscc/hosted-protocol';
import { canonical, contentHash } from '@nortuscc/machine';
import { desiredOfDocuments, documentOf, type Documents } from './documents.ts';

export { parseItemId, type ItemKind, type ItemRef } from '@nortuscc/hosted-protocol';

// Each item's value in a setup as a comparable string; an absent item has no entry.
export type ItemValues = ReadonlyMap<string, string>;
export type ItemChange = {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly before: string | undefined;
  readonly after: string | undefined;
};

// Values come from the documents alone, never from machine overrides, so an override cannot hide
// an upstream change: a settings key's owned value, a copied file's content hash, a skill's group
// markers and its source's pin, an integration's declaration.
export const itemValues = (documents: Documents): ItemValues => {
  const desired = desiredOfDocuments(documents);
  const values = new Map<string, string>();
  for (const file of desired.files) {
    if (file.mode === 'copy') {
      const text = documentOf(documents, file.src);
      if (text !== undefined) values.set(`file:${file.id}`, contentHash(file, text)!);
      continue;
    }
    for (const [key, { value }] of Object.entries(file.keys ?? {})) values.set(`setting:${file.id}#${key}`, canonical(value));
  }
  for (const skill of desired.skills) {
    values.set(`skill:${skill.source}/${skill.name}`, canonical({ exact: skill.exact, optional: skill.optional, pin: skill.pin?.ref ?? null }));
  }
  for (const integration of desired.integrations) values.set(`integration:${integration.id}`, canonical(integration.declaration));
  return values;
};

// Every item whose value differs between two setups, sorted by id, with both values.
export const diffItems = (from: ItemValues, to: ItemValues): ReadonlyArray<ItemChange> =>
  [...new Set([...from.keys(), ...to.keys()])].sort().flatMap((itemId): ItemChange[] => {
    const before = from.get(itemId);
    const after = to.get(itemId);
    const ref = parseItemId(itemId);
    return before === after || ref === undefined ? [] : [{ itemId, kind: ref.kind, before, after }];
  });
