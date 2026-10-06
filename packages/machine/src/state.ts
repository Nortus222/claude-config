import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { overridesFromLegacyState } from '@nortuscc/profile-engine';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

export type Baseline = { readonly hash: string; readonly appliedAt: string };
export type MachineState = {
  readonly version: 1;
  readonly repo: string | null;
  readonly files: Readonly<Record<string, Baseline>>;
};

export const emptyState: MachineState = { version: 1, repo: null, files: {} };

// The one legacy key worth carrying forward from the pre-Codex lock.
const LEGACY_KEYS: Record<string, string> = { 'CLAUDE.md': 'claude:CLAUDE.md' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A record that is not the expected shape is treated as absent rather than trusted halfway. The
// legacy machine choices (skillsOnly, configTargets) are not state: they live in overrides.json.
export const parseState = (text: string): MachineState | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.files)) return undefined;
  return {
    version: 1,
    repo: typeof parsed.repo === 'string' ? parsed.repo : null,
    files: parsed.files as Record<string, Baseline>,
  };
};

export const withBaseline = (state: MachineState, key: string, hash: string, now = new Date()): MachineState => ({
  ...state,
  files: { ...state.files, [key]: { hash, appliedAt: now.toISOString() } },
});

export const withoutBaseline = (state: MachineState, key: string): MachineState => {
  const { [key]: _removed, ...files } = state.files;
  return { ...state, files };
};

export class StateStore extends Context.Service<
  StateStore,
  {
    readonly read: Effect.Effect<MachineState, FsFailed>;
    readonly write: (state: MachineState) => Effect.Effect<void, FsFailed>;
    readonly update: (f: (state: MachineState) => MachineState) => Effect.Effect<MachineState, FsFailed>;
  }
>()('machine/StateStore') {}

// state.json: nortuscc's own bookkeeping, in the legacy CLI's exact format.
export const stateStore = Layer.effect(
  StateStore,
  Effect.gen(function* () {
    const paths = yield* MachinePaths;
    const fs = yield* Fs;
    const statePath = join(paths.stateRoot, 'state.json');
    const overridesPath = join(paths.stateRoot, 'overrides.json');
    const legacyPath = join(paths.claude, '.nortuscc-lock.json');

    // The first state write migrates the legacy machine choices from the on-disk state.json into
    // overrides.json, unless that file already exists; reads never write it. state.json is then
    // written without them.
    const write = (state: MachineState) => Effect.gen(function* () {
      if ((yield* fs.readText(overridesPath)) === undefined) {
        const legacy = overridesFromLegacyState(yield* fs.readText(statePath)).value;
        if (Object.keys(legacy).length > 0) {
          yield* fs.writeTextAtomic(overridesPath, JSON.stringify({ version: 1, ...legacy }, null, 2) + '\n');
        }
      }
      const { version, repo, files } = state;
      yield* fs.writeTextAtomic(statePath, JSON.stringify({ version, repo, files }, null, 2) + '\n');
    });

    // Migrates the pre-Codex lock only when no state file exists; the old lock is left untouched.
    const read = Effect.gen(function* () {
      const text = yield* fs.readText(statePath);
      if (text !== undefined) return parseState(text) ?? emptyState;
      const legacyText = yield* fs.readText(legacyPath);
      const legacy = legacyText === undefined ? undefined : parseState(legacyText);
      if (!legacy) return emptyState;
      const files: Record<string, Baseline> = {};
      for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
        if (legacy.files[oldKey]) files[newKey] = legacy.files[oldKey];
      }
      const migrated: MachineState = { ...emptyState, repo: legacy.repo, files };
      yield* write(migrated);
      return migrated;
    });

    return {
      read,
      write,
      update: (f) => Effect.flatMap(read, (state) => {
        const next = f(state);
        return Effect.as(write(next), next);
      }),
    };
  }),
);
