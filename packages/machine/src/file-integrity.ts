import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { FsFailed } from './errors.ts';

// Binary identities and explicit durability, kept separate from the text-oriented Fs contract.
export class FileIntegrity extends Context.Service<FileIntegrity, {
  readonly digestTree: (path: string) => Effect.Effect<string, FsFailed>;
  readonly sha256File: (path: string) => Effect.Effect<string, FsFailed>;
  // Flush an existing Unix file or directory; unsupported platforms report FsFailed.
  readonly syncPath: (path: string) => Effect.Effect<void, FsFailed>;
}>()('machine/FileIntegrity') {}
const attempt = <A>(op: string, path: string, run: () => Promise<A>) => Effect.tryPromise({
  try: run, catch: error => new FsFailed({ op, path, reason: error instanceof Error ? error.message : String(error) }),
});
const digestTree = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  const visit = async (entry: string, name: string): Promise<void> => {
    const stat = await lstat(entry); hash.update(JSON.stringify(name));
    if (stat.isSymbolicLink()) hash.update('link:' + await readlink(entry));
    else if (stat.isDirectory()) { hash.update('dir'); for (const child of (await readdir(entry)).sort()) await visit(join(entry, child), join(name, child)); }
    else if (stat.isFile()) { hash.update('file:' + stat.mode); hash.update(await readFile(entry)); }
    else throw new Error('unsupported app bundle entry');
  };
  await visit(path, ''); return hash.digest('hex');
};

export const nodeFileIntegrity = Layer.succeed(FileIntegrity, {
  digestTree: (path) => attempt('hash tree', path, () => digestTree(path)),
  sha256File: (path) => attempt('hash file', path, async () => createHash('sha256').update(await readFile(path)).digest('hex')),
  syncPath: (path) => attempt('sync', path, async () => {
    const file = await open(path, 'r');
    try { await file.sync(); } finally { await file.close(); }
  }),
});
