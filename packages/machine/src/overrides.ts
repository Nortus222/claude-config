import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { decodeOverrides, overridesFromLegacyState, type Input, type MachineOverrides } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// Migration rule until cutover (#59): anything that writes overrides.json must also write
// state.json's skillsOnly/configTargets, and the legacy writeLock mirrors state.json into an
// existing overrides.json.
export class OverridesStore extends Context.Service<
  OverridesStore,
  {
    readonly read: Effect.Effect<Input<MachineOverrides>, FsFailed>;
    readonly write: (overrides: MachineOverrides) => Effect.Effect<void, FsFailed>;
  }
>()('machine/OverridesStore') {}

// overrides.json: this machine's choices. Until cutover (#59) the legacy state.json fields
// are read when the file is absent, and writing never removes them.
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
