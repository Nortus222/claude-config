import { join } from 'node:path';
import { Context, Effect, Layer, Ref } from 'effect';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// moveAside/preserve return the backup path, or undefined when nothing was there. Within a run the
// first copy of a destination wins: a repeat returns it untouched (moveAside still removes the live path).
export class Backups extends Context.Service<
  Backups,
  {
    readonly dir: Effect.Effect<string | undefined>;
    readonly moveAside: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly preserve: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>;
  }
>()('machine/Backups') {}

// One folder per run, so a run's displaced files stay together; created only when needed.
export const backupsForRun = (started = new Date()) =>
  Layer.effect(
    Backups,
    Effect.gen(function* () {
      const paths = yield* MachinePaths;
      const fs = yield* Fs;
      const folder = join(paths.backups, `nortuscc-${started.toISOString().replace(/[:.]/g, '-')}`);
      // Destinations already holding this run's copy: the first copy is the pre-run original.
      const taken = yield* Ref.make<ReadonlySet<string>>(new Set());
      const target = (relative: string, agent?: string) => join(folder, ...(agent ? [agent] : []), relative);
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string) =>
        Effect.gen(function* () {
          const to = target(relative, agent);
          if ((yield* Ref.get(taken)).has(to)) {
            // Already backed up this run: never overwrite it. moveAside still vacates the live path.
            if (op === 'move') yield* fs.remove(path);
            return to;
          }
          if (!(yield* fs.exists(path))) return undefined;
          yield* (op === 'move' ? fs.move(path, to) : fs.copy(path, to));
          yield* Ref.update(taken, (set) => new Set(set).add(to));
          return to;
        });
      return {
        dir: Effect.map(Ref.get(taken), (set) => (set.size > 0 ? folder : undefined)),
        moveAside: keep('move'),
        preserve: keep('copy'),
      };
    }),
  );
