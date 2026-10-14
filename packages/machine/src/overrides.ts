import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { decodeOverrides, serializeOverrides, overridesFromLegacyState, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';
import { Backups } from './backups.ts';

// overrides.json is the only record of this machine's choices. A machine whose choices are still
// in state.json's legacy skillsOnly/configTargets has them moved here by the first state write
// (StateStore.write); until then they are read from state.json.
export class OverridesStore extends Context.Service<
  OverridesStore,
  {
    readonly read: Effect.Effect<Input<MachineOverrides>, FsFailed>;
    readonly write: (overrides: MachineOverrides) => Effect.Effect<void, FsFailed, Backups>;
  }
>()('machine/OverridesStore') {}

// overrides.json: this machine's choices. When the file is absent the legacy state.json fields
// are read in its place, so a never-migrated machine reports its choices without a write.
export const overridesStore = Layer.effect(
  OverridesStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const path = join(paths.stateRoot, 'overrides.json');
    const statePath = join(paths.stateRoot, 'state.json');

    const read = Effect.gen(function* () {
      const text = yield* fs.readText(path);
      if (text === undefined) return overridesFromLegacyState(yield* fs.readText(statePath), statePath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const message = `not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        return { value: {}, source: path, issues: [{ layer: 'machine' as const, source: path, path: '', message }] };
      }
      return decodeOverrides(parsed, path);
    });

    return {
      read,
      write: (overrides) => Effect.gen(function* () {
        const text = yield* fs.readText(path);
        let current: unknown;
        try { current = text === undefined ? undefined : JSON.parse(text); }
        catch { return yield* Effect.fail(new FsFailed({ op: 'write overrides', path, reason: 'current document is invalid JSON' })); }
        const serialized = serializeOverrides(overrides, current, path);
        if (!serialized.ok) return yield* Effect.fail(new FsFailed({ op: 'write overrides', path, reason: 'current or proposed overrides are invalid' }));
        const backups = yield* Backups;
        yield* backups.preserve(path, 'overrides.json', undefined, { private: true });
        if (text === undefined) yield* backups.preserve(statePath, 'state.json', undefined, { private: true });
        // Callers hold the apply lock; refuse an external edit during preservation as well.
        if ((yield* fs.readText(path)) !== text) return yield* Effect.fail(new FsFailed({ op: 'write overrides', path, reason: 'document changed before replacement' }));
        yield* fs.writeTextAtomic(path, serialized.text);
      }),
    };
  }),
);
