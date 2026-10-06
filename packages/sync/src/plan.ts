import { Effect } from 'effect';
import type { MachineOverrides } from '@nortuscc/profile-engine';
import type { Fs, FsFailed, LaunchFailed, Processes } from '@nortuscc/machine';
import { composeDocuments } from './compose.ts';
import { commitDocuments } from './git.ts';
import { diffItems, itemValues, parseItemId, type ItemChange, type ItemValues } from './items.ts';
import type { RevisionUnavailable } from './source.ts';
import type { Holds } from './store.ts';

// An incoming item a machine override shadows: shown, never resolved silently.
export type Conflict = { readonly itemId: string; readonly override: string };
export type Incoming = { readonly changes: ReadonlyArray<ItemChange>; readonly conflicts: ReadonlyArray<Conflict> };

// What upstream changed since the applied commit, as this machine sees it: an item counts when its
// value moved between the applied and head commits, and its old value is what this machine holds
// now (the applied commit with today's holds). An item already at its head value is not listed.
export const incomingChanges = (input: {
  readonly rawApplied: ItemValues;
  readonly current: ItemValues;
  readonly head: ItemValues;
}): ReadonlyArray<ItemChange> =>
  diffItems(input.rawApplied, input.head).flatMap((change): ItemChange[] => {
    const before = input.current.get(change.itemId);
    return before === change.after ? [] : [{ ...change, before }];
  });

const hasOwnKey = (record: Readonly<Record<string, unknown>> | undefined, key: string) =>
  record !== undefined && Object.hasOwn(record, key);

// The overrides entry that shadows an item on this machine, as a dotted path; files have none.
export const overrideOf = (itemId: string, overrides: MachineOverrides): string | undefined => {
  const ref = parseItemId(itemId);
  if (ref?.kind === 'setting') {
    return hasOwnKey(overrides.settings?.[ref.fileId], ref.key) ? `settings.${ref.fileId}.${ref.key}` : undefined;
  }
  if (ref?.kind === 'skill') return hasOwnKey(overrides.skills, ref.name) ? `skills.${ref.name}` : undefined;
  if (ref?.kind === 'integration') return hasOwnKey(overrides.integrations, ref.id) ? `integrations.${ref.id}` : undefined;
  return undefined;
};

export const conflictsOf = (changes: ReadonlyArray<ItemChange>, overrides: MachineOverrides): ReadonlyArray<Conflict> =>
  changes.flatMap((change) => {
    const override = overrideOf(change.itemId, overrides);
    return override === undefined ? [] : [{ itemId: change.itemId, override }];
  });

const dropKey = <T>(record: Readonly<Record<string, T>> | undefined, key: string): Readonly<Record<string, T>> | undefined => {
  if (record === undefined) return undefined;
  const { [key]: _dropped, ...rest } = record;
  return Object.keys(rest).length > 0 ? rest : undefined;
};

const setField = (overrides: MachineOverrides, field: 'settings' | 'skills' | 'integrations', value: unknown): MachineOverrides => {
  const next: Record<string, unknown> = { ...overrides };
  if (value === undefined) delete next[field];
  else next[field] = value;
  return next as MachineOverrides;
};

// *Take theirs*: overrides without the entry that shadows `itemId`, and without containers that
// leaves empty. Unchanged (the same object) when nothing shadows it.
export const withoutOverride = (overrides: MachineOverrides, itemId: string): MachineOverrides => {
  if (overrideOf(itemId, overrides) === undefined) return overrides;
  const ref = parseItemId(itemId)!;
  if (ref.kind === 'setting') {
    const file = dropKey(overrides.settings![ref.fileId], ref.key);
    const settings = file === undefined ? dropKey(overrides.settings, ref.fileId) : { ...overrides.settings, [ref.fileId]: file };
    return setField(overrides, 'settings', settings);
  }
  if (ref.kind === 'skill') return setField(overrides, 'skills', dropKey(overrides.skills, ref.name));
  if (ref.kind === 'integration') return setField(overrides, 'integrations', dropKey(overrides.integrations, ref.id));
  return overrides;
};

// The holds after a choice: an accepted item is released; a skipped one keeps its existing hold or is
// held at the applied commit; holds on items that did not change stay.
export const nextHolds = (input: {
  readonly holds: Holds;
  readonly changes: ReadonlyArray<ItemChange>;
  readonly accepted: ReadonlySet<string>;
  readonly applied: string;
}): Holds => {
  const next: Record<string, string> = { ...input.holds };
  for (const change of input.changes) {
    if (input.accepted.has(change.itemId)) delete next[change.itemId];
    else next[change.itemId] = input.holds[change.itemId] ?? input.applied;
  }
  return next;
};

// Incoming items between the applied commit and `head`, from git objects, and their conflicts.
export const incoming = (input: {
  readonly repo: string;
  readonly applied: string;
  readonly head: string;
  readonly holds: Holds;
  readonly overrides: MachineOverrides;
}): Effect.Effect<Incoming, FsFailed | LaunchFailed | RevisionUnavailable, Fs | Processes> =>
  Effect.gen(function* () {
    if (input.applied === input.head) return { changes: [], conflicts: [] };
    const rawApplied = itemValues(yield* commitDocuments(input.repo, input.applied));
    const current = itemValues(yield* composeDocuments({ repo: input.repo, head: { kind: 'commit', commit: input.applied }, held: input.holds }));
    const head = itemValues(yield* commitDocuments(input.repo, input.head));
    const changes = incomingChanges({ rawApplied, current, head });
    return { changes, conflicts: conflictsOf(changes, input.overrides) };
  });
