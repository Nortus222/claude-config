import { basename, dirname, join, sep } from 'node:path';
import { Context, Effect, Layer, Ref } from 'effect';
import { FsFailed } from './errors.ts';
import { Fs } from './fs.ts';
import { MachinePaths } from './paths.ts';
import { privateFile } from './private-file.ts';

// moveAside moves a live link as a link. preserve copies what a live link points at, so the backup
// holds the content at that time rather than a link to the file about to change; a dangling link
// is copied as a link.
// moveAside/preserve return the backup path, or undefined when nothing was there. Within a run the
// first call for a destination decides: a repeat returns that first answer untouched (the pre-run
// copy, or undefined when the path was absent then), and moveAside still vacates the live path.
// Private preservation accepts regular UTF-8 config files and writes 0600 bytes inside private
// directories. It refuses redirected destinations and leaves the source permissions unchanged.
export class Backups extends Context.Service<
  Backups,
  {
    readonly dir: Effect.Effect<string | undefined>;
    readonly moveAside: (path: string, relative: string, agent?: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly preserve: (path: string, relative: string, agent?: string, options?: { readonly private?: boolean }) => Effect.Effect<string | undefined, FsFailed>;
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
      const copyOf = (path: string, to: string) =>
        Effect.gen(function* () {
          if ((yield* fs.stat(path))?.kind === 'symlink') {
            const followed = yield* fs.copy(path, to, { follow: true }).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)));
            if (followed) return;
            yield* fs.remove(to);
          }
          yield* fs.copy(path, to);
        });
      const keep = (op: 'move' | 'copy') => (path: string, relative: string, agent?: string, options?: { readonly private?: boolean }) =>
        Effect.gen(function* () {
          const to = target(relative, agent);
          const seen = yield* Ref.get(first);
          if (seen.has(to)) {
            if (op === 'move') yield* fs.remove(path);
            return seen.get(to);
          }
          const present = yield* fs.exists(path);
          if (present) {
            if (op === 'move') yield* fs.move(path, to);
            else if (options?.private) {
              if ((yield* fs.stat(path))?.kind !== 'file') return yield* Effect.fail(new FsFailed({ op: 'private backup', path, reason: 'requires a regular file' }));
              const text = yield* fs.readText(path);
              if (text === undefined) return yield* Effect.fail(new FsFailed({ op: 'private backup', path, reason: 'file disappeared' }));
              // Resolve existing ancestors (including macOS's /var alias) before the private writer
              // creates every new directory with 0700 and opens its temporary file with 0600.
              let checked = dirname(to);
              while (checked === paths.backups || checked.startsWith(paths.backups + sep)) {
                const entry = yield* fs.stat(checked);
                if (entry && entry.kind !== 'directory') return yield* Effect.fail(new FsFailed({ op: 'private backup', path: checked, reason: 'backup directory is redirected' }));
                if (checked === paths.backups) break;
                checked = dirname(checked);
              }
              let ancestor = dirname(to); const suffix = [basename(to)];
              let real = yield* fs.realPath(ancestor);
              while (!real && dirname(ancestor) !== ancestor) {
                suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); real = yield* fs.realPath(ancestor);
              }
              if (!real) return yield* Effect.fail(new FsFailed({ op: 'private backup', path, reason: 'backup parent unavailable' }));
              yield* privateFile(join(real, ...suffix)).write(text);
            } else yield* copyOf(path, to);
          }
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
