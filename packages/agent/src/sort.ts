import { join } from 'node:path';
import { Effect } from 'effect';
import { canonical, Fs, hashText, type FsFailed, type MachineReport, type Observed } from '@nortuscc/machine';
import { classify, type Entry, type Verdict } from './classifier.ts';
import { itemIdOf } from './item-ids.ts';
import type { Snapshot } from './source.ts';

export type Pending = { readonly key: string; readonly itemId: string; readonly verdict: Verdict };
export type Sorted = { readonly pending: ReadonlyArray<Pending>; readonly drift: ReadonlyArray<string> };

// The machine differs from what this item should be.
export const differs = (item: Observed): boolean => item.disposition === 'apply' || item.disposition === 'capture';

// An item's entry in one snapshot, or undefined when the snapshot does not declare it.
export const entryOf = (itemId: string, snapshot: Snapshot): Effect.Effect<Entry | undefined, FsFailed, Fs> =>
  Effect.gen(function* () {
    const { desired } = snapshot;
    if (itemId.startsWith('setting:')) {
      const rest = itemId.slice('setting:'.length);
      const at = rest.indexOf('#');
      const fileId = rest.slice(0, at);
      const key = rest.slice(at + 1);
      const file = desired.files.find((f) => f.id === fileId);
      const owned = file?.keys !== undefined && Object.hasOwn(file.keys, key) ? file.keys[key] : undefined;
      if (!file || !owned) return undefined;
      const entry: Entry = { kind: 'setting', fileId, key, managed: file.managed, value: owned.value };
      return entry;
    }
    if (itemId.startsWith('file:')) {
      const file = desired.files.find((f) => f.id === itemId.slice('file:'.length));
      if (!file) return undefined;
      const text = yield* (yield* Fs).readText(join(snapshot.repo, file.src));
      const entry: Entry = {
        kind: 'file', fileId: file.id, mode: file.mode, dest: file.dest, managed: file.managed,
        hash: text === undefined ? undefined : hashText(text),
      };
      return entry;
    }
    if (itemId.startsWith('skill:')) {
      const skill = desired.skills.find((s) => `skill:${s.source}/${s.name}` === itemId);
      if (!skill) return undefined;
      const entry: Entry = {
        kind: 'skill', value: { install: skill.install, exact: skill.exact, optional: skill.optional, pin: skill.pin?.ref ?? null },
      };
      return entry;
    }
    if (itemId.startsWith('integration:')) {
      const integration = desired.integrations.find((i) => `integration:${i.id}` === itemId);
      if (!integration) return undefined;
      const entry: Entry = { kind: 'integration', value: { declaration: integration.declaration, enabled: integration.enabled } };
      return entry;
    }
    return undefined;
  });

const sameEntry = (a: Entry | undefined, b: Entry | undefined): boolean =>
  a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);

// Pending: an item the machine is behind on (`apply`) whose desired value changed between the applied revision and the effective
// configuration, because a person accepted the change. Drift: every other differing item, including
// machine-local keys with no item id and every `capture` item, since a local edit may be deliberate. Only pending items are ever auto-applied.
export const sortItems = (report: MachineReport, applied: Snapshot, effective: Snapshot): Effect.Effect<Sorted, FsFailed, Fs> =>
  Effect.gen(function* () {
    const pending: Pending[] = [];
    const drift: string[] = [];
    for (const item of report.items) {
      if (!differs(item)) continue;
      if (item.disposition === 'capture') {
        drift.push(item.key);
        continue;
      }
      const itemId = itemIdOf(item.key, effective.desired);
      if (itemId === undefined) {
        drift.push(item.key);
        continue;
      }
      const before = yield* entryOf(itemId, applied);
      const after = yield* entryOf(itemId, effective);
      if (sameEntry(before, after)) drift.push(item.key);
      else pending.push({ key: item.key, itemId, verdict: classify({ itemId, before, after }) });
    }
    return { pending, drift };
  });
