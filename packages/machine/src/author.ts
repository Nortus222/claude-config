import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import { Fs } from './fs.ts';
import { Processes } from './processes.ts';
import { MachinePaths, type MachinePathsValue } from './paths.ts';
import { Backups } from './backups.ts';
import type { StateStore } from './state.ts';
import type { MutationObserver } from './history.ts';

export class AuthorUnavailable extends Error {
  readonly _tag = 'AuthorUnavailable';
  constructor() { super('Author checkout is unavailable or changed; check for new changes again'); }
}
export type AuthorBinding = {
  readonly checkout: string; readonly realCheckout: string; readonly gitDir: string; readonly head: string;
  readonly files: readonly { readonly path: string; readonly kind: 'absent' | 'file'; readonly sha256: string | null; readonly indexBlob: string | null }[];
};
export type AuthorServices = Fs | Processes | MachinePaths | StateStore;
export type AuthorDocument = { readonly path: string; readonly beforeSha256: string | null; readonly text: string; readonly afterSha256: string };
export type PreparedAuthorEdit = { readonly author: AuthorBinding; readonly documents: readonly AuthorDocument[] };
export const authorDigest = (bytes: Uint8Array | string | undefined): string | null => bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
const refuse = () => Effect.fail(new AuthorUnavailable());
// Metadata only. Explicit roots and a minimal environment prevent inherited Git redirection.
const git = (checkout: string, args: readonly string[]) => Effect.gen(function* () {
  const result = yield* (yield* Processes).run({ cmd: 'git', cwd: checkout,
    args: ['--git-dir', join(checkout, '.git'), '--work-tree', checkout, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.bare=false', ...args],
    envAllow: ['PATH', 'SystemRoot', 'WINDIR'], env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    output: 'capture', stderr: 'capture', captureLimit: { stdout: 1024 * 1024, stderr: 4096 },
  }).pipe(Effect.timeout('5 seconds'));
  if (result.code !== 0) return yield* refuse();
  return result.stdout;
});
const safeFile = (root: string, path: string) => Effect.gen(function* () {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part === '.git')) return yield* refuse();
  const fs = yield* Fs; const absolute = resolve(root, path);
  if (relative(root, absolute).startsWith(`..${sep}`)) return yield* refuse();
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = yield* fs.stat(join(root, ...parts.slice(0, i)));
    if (stat && stat.kind !== (i === parts.length ? 'file' : 'directory')) return yield* refuse();
  }
  const bytes = yield* fs.readBytes(absolute);
  if (bytes !== undefined) yield* Effect.try({ try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes), catch: () => new AuthorUnavailable() });
  return bytes;
});
const bind = (checkout: string, paths: readonly string[]) => Effect.gen(function* () {
  const fs = yield* Fs;
  const realCheckout = yield* fs.realPath(checkout);
  if (!realCheckout || !(yield* fs.stat(join(realCheckout, '.git')))) return yield* refuse();
  const gitDir = (yield* git(realCheckout, ['rev-parse', '--absolute-git-dir'])).trim();
  const realGitDir = yield* fs.realPath(gitDir);
  if (!realGitDir) return yield* refuse();
  const head = (yield* git(realCheckout, ['rev-parse', '--verify', 'HEAD'])).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return yield* refuse();
  const files: AuthorBinding['files'][number][] = [];
  for (const path of [...new Set(paths)]) {
    const bytes = yield* safeFile(realCheckout, path);
    // Bind mode, blob, stage and index flags, including mode-only staged edits.
    const entry = yield* git(realCheckout, ['ls-files', '--stage', '--debug', '--', path]);
    files.push({ path, kind: bytes === undefined ? 'absent' : 'file', sha256: authorDigest(bytes), indexBlob: entry ? authorDigest(entry) : null });
  }
  return { checkout, realCheckout, gitDir: realGitDir, head, files } satisfies AuthorBinding;
});
export const bindAuthorCheckout = (configured: MachinePathsValue, relativeFiles: readonly string[]): Effect.Effect<AuthorBinding, AuthorUnavailable, Fs | Processes> =>
  bind(configured.repo, relativeFiles).pipe(Effect.mapError(() => new AuthorUnavailable()));
export const validateAuthorBinding = (binding: AuthorBinding): Effect.Effect<void, AuthorUnavailable, Fs | Processes> =>
  Effect.gen(function* () {
    const current = yield* bind(binding.checkout, binding.files.map(file => file.path));
    if (JSON.stringify(current) !== JSON.stringify(binding)) return yield* refuse();
  }).pipe(Effect.mapError(() => new AuthorUnavailable()));

// Advance only the bytes we just observed ourselves, retaining HEAD, Git dir and every index entry.
export const observedAuthorReplacement = (binding: AuthorBinding, path: string, text: string): AuthorBinding => ({
  ...binding, files: binding.files.map(file => file.path === path ? { ...file, kind: 'file', sha256: authorDigest(text) } : file),
});
export const executeAuthorEdit = (edit: PreparedAuthorEdit, signal: AbortSignal, observer: MutationObserver): Effect.Effect<{ committedPaths: readonly string[]; remainingPaths: readonly string[] }, unknown, AuthorServices | Backups> => Effect.gen(function* () {
  const fs = yield* Fs; const backups = yield* Backups; let accepted = edit.author; const committedPaths: string[] = [];
  for (const document of edit.documents) {
    if (signal.aborted) return { committedPaths, remainingPaths: edit.documents.map(d => d.path).filter(path => !committedPaths.includes(path)) };
    const file = accepted.files.find(file => file.path === document.path);
    if (!file || file.sha256 !== document.beforeSha256 || authorDigest(document.text) !== document.afterSha256) return yield* refuse();
    yield* validateAuthorBinding(accepted);
    yield* observer.pending(document.path);
    yield* backups.preserve(join(accepted.realCheckout, document.path), join('author', document.path));
    yield* validateAuthorBinding(accepted);
    if (signal.aborted) return yield* refuse();
    yield* fs.writeTextAtomic(join(accepted.realCheckout, document.path), document.text);
    accepted = observedAuthorReplacement(accepted, document.path, document.text);
    committedPaths.push(document.path);
    yield* observer.committed(document.path);
  }
  return { committedPaths, remainingPaths: [] };
});
