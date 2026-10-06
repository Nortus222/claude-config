import { Effect } from 'effect';
import { canonical, type Fs, type FsFailed, type MachineReport, type Observed } from '@nortuscc/machine';
import { entryOf, itemIdOf, type Entry, type Snapshot } from '@nortuscc/sync';
import { classify, type Verdict } from './classifier.ts';

export type Pending = { readonly key: string; readonly itemId: string; readonly verdict: Verdict };
export type Sorted = { readonly pending: ReadonlyArray<Pending>; readonly drift: ReadonlyArray<string> };

// The machine differs from what this item should be.
export const differs = (item: Observed): boolean => item.disposition === 'apply' || item.disposition === 'capture';

const sameEntry = (a: Entry | undefined, b: Entry | undefined): boolean =>
  a === undefined || b === undefined ? a === b : canonical(a) === canonical(b);

// A config item with no recorded baseline that the machine already holds a value for: set by hand,
// never applied by nortuscc, so it may be deliberate.
const heldWithoutBaseline = (item: Observed): boolean =>
  item.domain === 'config' && item.state === 'unmanaged' && !(item.facts ?? []).includes('local-absent');

// Pending: an item the machine is behind on (`apply`) whose desired value changed between the applied revision and the effective
// configuration, because a person accepted the change. Drift: every other differing item, including
// machine-local keys with no item id, every `capture` item and every value held without a baseline,
// since a local edit may be deliberate. Only pending items are ever auto-applied.
export const sortItems = (report: MachineReport, applied: Snapshot, effective: Snapshot): Effect.Effect<Sorted, FsFailed, Fs> =>
  Effect.gen(function* () {
    const pending: Pending[] = [];
    const drift: string[] = [];
    for (const item of report.items) {
      if (!differs(item)) continue;
      if (item.disposition === 'capture' || heldWithoutBaseline(item)) {
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
