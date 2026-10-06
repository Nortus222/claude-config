import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { decodeOverrides, overridesFromLegacyState, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// overrides.json is the only record of this machine's choices. A machine whose choices are still
// in state.json's legacy skillsOnly/configTargets has them moved here by the first state write
// (StateStore.write); until then they are read from state.json.
export class OverridesStore extends Context.Service<
  OverridesStore,
  {
    readonly read: Effect.Effect<Input<MachineOverrides>, FsFailed>;
    readonly write: (overrides: MachineOverrides) => Effect.Effect<void, FsFailed>;
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
      write: (overrides) => fs.writeTextAtomic(path, JSON.stringify({ version: 1, ...overrides }, null, 2) + '\n'),
    };
  }),
);
