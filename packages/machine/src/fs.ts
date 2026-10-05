import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { FsFailed } from './errors.ts';

export class Fs extends Context.Service<
  Fs,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly writeTextAtomic: (path: string, text: string) => Effect.Effect<void, FsFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly copy: (from: string, to: string) => Effect.Effect<void, FsFailed>;
    readonly move: (from: string, to: string) => Effect.Effect<void, FsFailed>;
    readonly remove: (path: string) => Effect.Effect<void, FsFailed>;
  }
>()('machine/Fs') {}

const attempt = <A>(op: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (err) => new FsFailed({ op, path, reason: err instanceof Error ? err.message : String(err) }),
  });

const copyTree = (from: string, to: string) => async () => {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
};

export const nodeFs = Layer.succeed(Fs, {
  readText: (path) =>
    attempt('read', path, () =>
      readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      })),
  // A reader sees the old file or the whole new one, never half of it.
  writeTextAtomic: (path, text) =>
    attempt('write', path, async () => {
      await mkdir(dirname(path), { recursive: true });
      const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text, 'utf8');
        await rename(temp, path);
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
    }),
  exists: (path) => Effect.promise(() => lstat(path).then(() => true, () => false)),
  copy: (from, to) => attempt('copy', from, copyTree(from, to)),
  // rename fails across volumes; copy then remove covers that.
  move: (from, to) =>
    attempt('move', from, async () => {
      await mkdir(dirname(to), { recursive: true });
      try {
        await rename(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await copyTree(from, to)();
        await rm(from, { recursive: true, force: true });
      }
    }),
  remove: (path) => attempt('remove', path, () => rm(path, { recursive: true, force: true })),
});
