import { join } from 'node:path';
import { Context, Effect, Layer, Ref } from 'effect';
import type { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';

// moveAside/preserve return the backup path, or undefined when nothing was there. Within a run the
// first call for a destination decides: a repeat returns that first answer untouched (the pre-run
// copy, or undefined when the path was absent then), and moveAside still vacates the live path.
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
      // Each destination's first answer this run: its backup, or undefined when the path was absent.
      // Remembering absence keeps a later call from saving content this run wrote.
      const first = yield* Ref.make<ReadonlyMap<string, string | undefined>>(new Map());
      const target = (relative: string, agent?: string) => join(folder, ...(agent ? [agent] : []), relative);
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string) =>
        Effect.gen(function* () {
          const to = target(relative, agent);
          const seen = yield* Ref.get(first);
          if (seen.has(to)) {
            if (op === 'move') yield* fs.remove(path);
            return seen.get(to);
          }
          const present = yield* fs.exists(path);
          if (present) yield* (op === 'move' ? fs.move(path, to) : fs.copy(path, to));
          const answer = present ? to : undefined;
          yield* Ref.update(first, (map) => new Map(map).set(to, answer));
          return answer;
        });
      return {
        dir: Effect.map(Ref.get(first), (map) => ([...map.values()].some((v) => v !== undefined) ? folder : undefined)),
        moveAside: keep('move'),
        preserve: keep('copy'),
      };
    }),
  );
