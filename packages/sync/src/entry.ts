import { join } from 'node:path';
import { Effect } from 'effect';
import { Fs, hashText, type FsFailed } from '@nortuscc/machine';
import type { Snapshot } from './source.ts';

// One setup item's value in one DesiredConfig, as the agent's classifier needs it.
export type Entry =
  | {
    readonly kind: 'file'; readonly fileId: string; readonly mode: 'copy' | 'merge-keys'; readonly dest: string;
    readonly managed: boolean; readonly hash: string | undefined;
  }
  | { readonly kind: 'setting'; readonly fileId: string; readonly key: string; readonly managed: boolean; readonly value: unknown }
  | { readonly kind: 'skill'; readonly value: unknown }
  | { readonly kind: 'integration'; readonly value: unknown };

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
