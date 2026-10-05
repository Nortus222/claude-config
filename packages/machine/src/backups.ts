import { join } from 'node:path';
import { Context, Effect, Layer, Ref } from 'effect';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

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
      const used = yield* Ref.make(false);
      const target = (relative: string, agent?: string) => join(folder, ...(agent ? [agent] : []), relative);
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string) =>
        Effect.gen(function* () {
          if (!(yield* fs.exists(path))) return undefined;
          const to = target(relative, agent);
          yield* (op === 'move' ? fs.move(path, to) : fs.copy(path, to));
          yield* Ref.set(used, true);
          return to;
        });
      return {
        dir: Effect.map(Ref.get(used), (u) => (u ? folder : undefined)),
        moveAside: keep('move'),
        preserve: keep('copy'),
      };
    }),
  );
