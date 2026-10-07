import { randomUUID } from 'node:crypto';
import { appendFile, chmod, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Context, Effect, Layer } from 'effect';
import { FsFailed } from './errors.ts';

export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

export class Fs extends Context.Service<
  Fs,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly writeTextAtomic: (path: string, text: string) => Effect.Effect<void, FsFailed>;
    // Appends `text` in one write, creating the file and its parents.
    readonly appendText: (path: string, text: string) => Effect.Effect<void, FsFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    // A link is copied as a link unless `follow`, which copies what it points at.
    readonly copy: (from: string, to: string, options?: { readonly follow?: boolean }) => Effect.Effect<void, FsFailed>;
    readonly move: (from: string, to: string) => Effect.Effect<void, FsFailed>;
    readonly remove: (path: string) => Effect.Effect<void, FsFailed>;
    // Entry names, sorted; undefined when the directory is absent.
    readonly list: (dir: string) => Effect.Effect<string[] | undefined, FsFailed>;
    // The path itself, never what a link points at; undefined when absent.
    readonly stat: (path: string) => Effect.Effect<{ readonly kind: FileKind } | undefined, FsFailed>;
    // Where `path` resolves after following every link; undefined when it, or a link's target, is absent.
    readonly realPath: (path: string) => Effect.Effect<string | undefined, FsFailed>;
    readonly readLink: (path: string) => Effect.Effect<string, FsFailed>;
    // Creates `path` as a link to `target`, creating parents.
    readonly symlink: (target: string, path: string) => Effect.Effect<void, FsFailed>;
  }
>()('machine/Fs') {}

const attempt = <A>(op: string, path: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (err) => new FsFailed({ op, path, reason: err instanceof Error ? err.message : String(err) }),
  });

const absent = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const lstatOrUndefined = (path: string) => lstat(path).catch((err) => {
  if (absent(err)) return undefined;
  throw err;
});

// Where a write to `path` lands: the file a symlink points at (even a dangling one), else `path`.
const writeTarget = async (path: string): Promise<string> => {
  if (!(await lstatOrUndefined(path))?.isSymbolicLink()) return path;
  try {
    return await realpath(path);
  } catch (err) {
    if (!absent(err)) throw err;
    return resolve(dirname(path), await readlink(path));
  }
};

const kindOf = (info: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileKind =>
  info.isSymbolicLink() ? 'symlink' : info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';

const copyTree = (from: string, to: string, follow = false) => async () => {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, follow ? { recursive: true, dereference: true } : { recursive: true, verbatimSymlinks: true });
};

// Windows can deny replacement briefly even when both files are writable. Keep the old file
// intact and retry only the atomic rename, with a bounded wait that cancellation can interrupt.
const replaceFile = async (from: string, to: string, signal: AbortSignal) => {
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || (err as NodeJS.ErrnoException).code !== 'EPERM' || retry === 5) throw err;
      await setTimeout(10 * 2 ** retry, undefined, { signal });
    }
  }
};

export const nodeFs = Layer.succeed(Fs, {
  readText: (path) =>
    attempt('read', path, () =>
      readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      })),
  // A reader sees the old file or the whole new one, never half of it. A symlink stays a link (its
  // target is replaced) and an existing file keeps its mode.
  writeTextAtomic: (path, text) =>
    attempt('write', path, async (signal) => {
      const target = await writeTarget(path);
      await mkdir(dirname(target), { recursive: true });
      const previous = await stat(target).catch((err) => {
        if (absent(err)) return undefined;
        throw err;
      });
      const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, text, 'utf8');
        if (previous) await chmod(temp, previous.mode & 0o7777);
        await replaceFile(temp, target, signal);
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
    }),
  exists: (path) => Effect.promise(() => lstat(path).then(() => true, () => false)),
  copy: (from, to, options) => attempt('copy', from, copyTree(from, to, options?.follow)),
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
  appendText: (path, text) =>
    attempt('append', path, async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text, 'utf8');
    }),
  remove: (path) => attempt('remove', path, () => rm(path, { recursive: true, force: true })),
  list: (dir) =>
    attempt('list', dir, () =>
      readdir(dir).then((names) => names.sort(), (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      })),
  stat: (path) => attempt('stat', path, async () => {
    const info = await lstatOrUndefined(path);
    return info && { kind: kindOf(info) };
  }),
  realPath: (path) => attempt('realpath', path, () => realpath(path).catch((err) => {
    if (absent(err)) return undefined;
    throw err;
  })),
  readLink: (path) => attempt('readlink', path, () => readlink(path)),
  symlink: (target, path) =>
    attempt('symlink', path, async () => {
      await mkdir(dirname(path), { recursive: true });
      await symlink(target, path);
    }),
});
