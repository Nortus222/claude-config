import { Cause, Effect, Exit } from 'effect';
import type { DesiredConfig, ResolvedFile } from '@nortuscc/profile-engine';
import type { FsFailed } from '../errors.ts';
import type { Fs } from '../fs.ts';
import type { Disposition, Observed } from '../model.ts';
import type { MachinePaths } from '../paths.ts';
import { StateStore } from '../state.ts';
import { readCopy, readMerge, type Reading } from './observe.ts';

const disposition = (file: ResolvedFile, state: string): Disposition => {
  if (!file.managed) return 'excluded';
  if (state === 'clean') return 'in-sync';
  if (state === 'repo-ahead' || state === 'unmanaged') return 'apply';
  if (state === 'local-ahead') return 'capture';
  return 'blocked';
};

const problem = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return `config: ${error instanceof Error && error.message ? error.message : String(error)}`;
};

// Every managed file's state, including files this machine does not manage: uninstall still needs
// those. A file that cannot be read is a probe error, never a guessed state.
export const inspectConfig = (desired: DesiredConfig) =>
  Effect.gen(function* () {
    const items: Observed[] = [];
    const probeErrors: string[] = [];
    const state = yield* Effect.exit((yield* StateStore).read);
    if (Exit.isFailure(state)) return { items, probeErrors: [problem(state.cause)] };

    for (const file of desired.files) {
      const read: Effect.Effect<ReadonlyArray<Reading>, FsFailed, Fs | MachinePaths> = file.mode === 'copy'
        ? Effect.map(readCopy(file, state.value.files), (reading) => [reading])
        : Effect.map(readMerge(file, desired, state.value.files), (document) => document.readings);
      const result = yield* Effect.exit(read);
      if (Exit.isFailure(result)) {
        probeErrors.push(problem(result.cause));
        continue;
      }
      for (const r of result.value) {
        items.push({
          key: r.key, domain: 'config', target: file.target, label: r.label, group: file.target, state: r.state,
          disposition: disposition(file, r.state), facts: r.facts, from: r.from, ...(r.note ? { note: r.note } : {}),
        });
      }
    }
    return { items, probeErrors };
  });
