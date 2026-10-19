import { parsePins, PINS_SOURCE } from '@nortuscc/profile-engine';
import { desiredOfDocuments, hasProfile, PROFILE_DOCUMENTS, type Documents } from './documents.ts';
import { itemValues, parseItemId } from './items.ts';
import { patchItem } from './patch.ts';
import type { SyncDecisionChange } from './decisions.ts';
import type { Holds } from './store.ts';

export type SetupChoice = Pick<SyncDecisionChange, 'itemId' | 'action'>;
export type SetupPinGroup = { source: string; itemIds: string[] };

export const setupPinGroups = (current: Documents, offered: Documents, heldItemIds: readonly string[] = [], profile?: string): SetupPinGroup[] => {
  const groups = new Map<string, string[]>();
  for (const id of [...new Set([...itemValues(current, profile).keys(), ...itemValues(offered, profile).keys(), ...heldItemIds])].sort()) {
    const ref = parseItemId(id);
    if (ref?.kind === 'skill') groups.set(ref.source, [...(groups.get(ref.source) ?? []), id]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([source, itemIds]) => ({ source, itemIds }));
};
const pinError = (source: string) => new Error(`Choices for ${source} must match: its items share one pin.`);
export const validateSetupPinChoices = (groups: readonly SetupPinGroup[], choices: readonly SetupChoice[]): void => {
  const selected = new Map(choices.map(c => [c.itemId, c.action]));
  for (const group of groups) {
    const actions = group.itemIds.map(id => selected.get(id));
    if (actions.some(action => action !== undefined) && new Set(actions).size !== 1) throw pinError(group.source);
  }
};
const pinAt = (documents: Documents, source: string) => {
  const pins = parsePins(documents[PINS_SOURCE]).value;
  return Object.hasOwn(pins, source) ? pins[source]! : null;
};

// Compose each selected item from its actual current or offered origin, including shared executable bytes.
export const composeSetupChoices = (input: {
  current: Documents; offered: Documents; accepted: readonly string[]; holds: Holds; profile?: string;
}): Documents => {
  const accepted = new Set(input.accepted);
  const ids = [...new Set([...itemValues(input.current, input.profile).keys(), ...itemValues(input.offered, input.profile).keys(), ...Object.keys(input.holds)])].sort();
  const pins = new Map<string, string | null>(), hooks = new Map<string, string>();
  const selections = ids.map(id => {
    const documents = accepted.has(id) ? input.offered : hasProfile(input.current, input.profile) ? input.current : { [`profiles/${input.profile}.json`]: '{}' };
    const value = itemValues(documents, input.profile).get(id), ref = parseItemId(id);
    if (ref?.kind === 'skill' && (value !== undefined || Object.hasOwn(input.holds, id))) {
      const pin = pinAt(documents, ref.source);
      if (pins.has(ref.source) && pins.get(ref.source) !== pin) throw pinError(ref.source);
      pins.set(ref.source, pin);
    }
    if (ref?.kind === 'integration' && value !== undefined) {
      const declaration = desiredOfDocuments(documents, undefined, input.profile).integrations.find(i => i.id === ref.id)?.declaration;
      if (declaration?.type === 'hook' && typeof declaration.file === 'string') {
        const body = documents[declaration.file];
        if (body === undefined || hooks.has(declaration.file) && hooks.get(declaration.file) !== body)
          throw new Error('Selected hook declarations require incompatible file bytes');
        hooks.set(declaration.file, body);
      }
    }
    return { id, documents, value };
  });
  let documents = input.offered;
  for (const selection of [...selections.filter(s => s.value === undefined), ...selections.filter(s => s.value !== undefined)])
    documents = patchItem(documents, selection.id, selection.documents, input.profile);
  const files = desiredOfDocuments(documents, undefined, input.profile).files.map(file => file.src);
  documents = { ...Object.fromEntries(Object.entries(documents).filter(([path]) => PROFILE_DOCUMENTS.includes(path) || files.includes(path) || path.startsWith('profiles/'))), ...Object.fromEntries(hooks) };
  const values = itemValues(documents, input.profile);
  if (selections.some(s => values.get(s.id) !== s.value) || desiredOfDocuments(documents, undefined, input.profile).issues.length)
    throw new Error('Selected setup choices cannot be composed');
  return documents;
};

// Refuse a composition that would silently replace selected values or executable bytes.
export const validateSetupComposition = (expected: Documents, actual: Documents, profile?: string): void => {
  for (const integration of desiredOfDocuments(expected, undefined, profile).integrations) {
    const declaration = integration.declaration;
    if (declaration.type === 'hook' && typeof declaration.file === 'string' && expected[declaration.file] !== actual[declaration.file])
      throw new Error('Selected hook bytes cannot be retained by this setup composition');
  }
  const wanted = itemValues(expected, profile), got = itemValues(actual, profile);
  if (wanted.size !== got.size || [...wanted].some(([id, value]) => got.get(id) !== value))
    throw new Error('Selected setup item values changed during composition');
};
