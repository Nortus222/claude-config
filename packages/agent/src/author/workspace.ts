import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { Backups, Fs, MachinePaths, Processes } from '@nortuscc/machine';
import { AccessDenied, GitFailed, gitAuthArgs } from '@nortuscc/sync';

export const GIT_TIMEOUT_MS = 120_000;
export const GIT_OUTPUT_BYTES = 1024 * 1024;
const MAIN = 'refs/remotes/origin/main';
const denied = (reason: string) => /authentication failed|permission.*denied|access denied|could not read (?:username|password)|terminal prompts disabled|authorization failed|repository not found|protected branch|GH006|GH013|returned error:?\s*(?:401|403|404)/i.test(reason);
const hash = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

export type PushOutcome = { kind: 'pushed'; commit: string } | { kind: 'moved' } | { kind: 'denied' } | { kind: 'failed'; detail: string };
export type CommitInput = {
  dir: string; base: string; files: Readonly<Record<string, string | null>>; message: string;
  onCommit: (sha: string) => Effect.Effect<void>;
};
export class AuthorWorkspace extends Context.Service<AuthorWorkspace, {
  readonly fresh: (repoUrl: string) => Effect.Effect<{ dir: string; base: string }, GitFailed | AccessDenied>;
  readonly commitAndPush: (input: CommitInput) => Effect.Effect<PushOutcome>;
  readonly tag: (dir: string, commit: string) => Effect.Effect<void, GitFailed>;
  readonly isPublished: (dir: string, commit: string) => Effect.Effect<boolean | 'unknown'>;
}>()('agent/AuthorWorkspace') {}

// The caller supplies its resolved login environment, including gh's credential configuration.
export const authorWorkspaceLayer = (input: { readonly env: Readonly<Record<string, string>> }) => Layer.effect(AuthorWorkspace, Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const fs = yield* Fs;
  const processes = yield* Processes;
  const backups = yield* Backups;
  const root = resolve(paths.stateRoot, 'agent', 'author');
  const hooks = join(root, 'empty-hooks');
  // Drop inherited Git directory, index, author and executable overrides. Keep login/keychain variables.
  const env = { ...Object.fromEntries(Object.entries(input.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
  const failed = (repoUrl: string, reason: string) => new GitFailed({ repoUrl, reason });
  const git = (args: readonly string[], cwd?: string) => processes.run({
    cmd: 'git', args: [...gitAuthArgs(hooks), ...args], cwd, env, envAllow: [],
    output: 'capture', stderr: 'capture', captureLimit: { stdout: GIT_OUTPUT_BYTES, stderr: GIT_OUTPUT_BYTES },
  }).pipe(
    Effect.mapError(error => failed(cwd ?? '', error.reason)),
    Effect.timeoutOption(GIT_TIMEOUT_MS),
    Effect.flatMap(result => result._tag === 'Some' ? Effect.succeed(result.value) : Effect.fail(failed(cwd ?? '', 'Git timed out'))),
  );
  const checkedGit = (args: readonly string[], cwd?: string) => git(args, cwd).pipe(Effect.flatMap(result => result.code === 0
    ? Effect.succeed(result.stdout.trim()) : Effect.fail(failed(cwd ?? '', result.stderr?.trim() || `Git exited with code ${result.code}`))));
  const fetch = (dir: string) => checkedGit(['fetch', '--prune', 'origin', `+refs/heads/main:${MAIN}`], dir);
  const ioError = <A, E extends { reason: string }>(effect: Effect.Effect<A, E>, dir: string) => effect.pipe(Effect.mapError(error => failed(dir, error.reason)));
  const ensureRoot = Effect.gen(function* () {
    for (const dir of [join(paths.stateRoot, 'agent'), root, hooks]) {
      const stat = yield* ioError(fs.stat(dir), dir);
      if (stat && stat.kind !== 'directory') return yield* Effect.fail(failed(dir, 'Author directory is redirected'));
      yield* ioError(fs.createDirectory(dir, { recursive: true }), dir);
    }
  });
  // Refuse a configured checkout, linked worktree or redirected clone before any Git mutation.
  const checked = (dir: string) => Effect.gen(function* () {
    if (dirname(dir) !== root || !/^[a-f0-9]{16}$/.test(basename(dir))) return yield* Effect.fail(failed(dir, 'Not a private author clone'));
    yield* ensureRoot;
    if ((yield* ioError(fs.stat(dir), dir))?.kind !== 'directory' || (yield* ioError(fs.stat(join(dir, '.git')), dir))?.kind !== 'directory') {
      return yield* Effect.fail(failed(dir, 'Not a private author clone'));
    }
    const top = yield* checkedGit(['rev-parse', '--show-toplevel'], dir);
    if ((yield* ioError(fs.realPath(top), dir)) !== (yield* ioError(fs.realPath(dir), dir))) {
      return yield* Effect.fail(failed(dir, 'Author Git work tree is redirected'));
    }
    const repoUrl = yield* checkedGit(['remote', 'get-url', 'origin'], dir);
    if (hash(repoUrl) !== basename(dir)) return yield* Effect.fail(failed(dir, 'Author origin does not match its directory'));
    return repoUrl;
  });
  const safeFile = (dir: string, path: string) => Effect.gen(function* () {
    const parts = path.split('/');
    if (!path || parts.some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git') || /[\\\x00]/.test(path) || resolve(dir, path) !== join(dir, path)) {
      return yield* Effect.fail(failed(dir, 'Invalid author file path'));
    }
    for (let i = 1; i <= parts.length; i++) {
      const stat = yield* ioError(fs.stat(join(dir, ...parts.slice(0, i))), dir);
      if (stat && (i < parts.length ? stat.kind !== 'directory' : stat.kind !== 'file')) return yield* Effect.fail(failed(dir, 'Author file is redirected or is not a regular file'));
    }
    return join(dir, path);
  });
  const preserve = (dir: string, path: string) => ioError(backups.preserve(join(dir, path), `author/${basename(dir)}/${path}`), dir);
  const identity = (dir: string) => Effect.gen(function* () {
    const email = yield* git(['config', 'user.email'], dir);
    if (email.code === 0 && email.stdout.trim()) return;
    const user = yield* processes.run({ cmd: 'gh', args: ['api', 'user'], env, envAllow: [], output: 'capture', stderr: 'capture', captureLimit: { stdout: GIT_OUTPUT_BYTES, stderr: GIT_OUTPUT_BYTES } }).pipe(
      Effect.mapError(error => failed(dir, error.reason)), Effect.timeoutOption(GIT_TIMEOUT_MS),
      Effect.flatMap(result => result._tag === 'Some' ? Effect.succeed(result.value) : Effect.fail(failed(dir, 'GitHub identity timed out'))),
    );
    const parsed = yield* Effect.try({ try: () => JSON.parse(user.stdout) as { login?: unknown; id?: unknown } | null, catch: () => failed(dir, 'Could not read GitHub identity') });
    if (user.code !== 0 || !parsed || typeof parsed.login !== 'string' || !parsed.login || typeof parsed.id !== 'number' || !Number.isSafeInteger(parsed.id) || parsed.id <= 0) return yield* Effect.fail(failed(dir, 'Could not read GitHub identity'));
    yield* preserve(dir, '.git/config');
    yield* checkedGit(['config', '--local', 'user.name', parsed.login], dir);
    yield* checkedGit(['config', '--local', 'user.email', `${parsed.id}+${parsed.login}@users.noreply.github.com`], dir);
  });
  const remoteTag = (dir: string, tag: string) => checkedGit(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], dir).pipe(Effect.map(text => {
    const refs = new Map(text.split('\n').filter(Boolean).map(line => line.split(/\s+/) as [string, string]).map(([sha, ref]) => [ref, sha]));
    return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  }));
  return {
    fresh: (repoUrl: string) => Effect.gen(function* () {
      yield* ensureRoot;
      const dir = join(root, hash(repoUrl));
      if (!(yield* fs.exists(dir))) yield* checkedGit(['clone', '--single-branch', '--branch', 'main', '--no-checkout', '--', repoUrl, dir]);
      yield* checked(dir);
      yield* fetch(dir);
      const dirty = yield* git(['diff', '--name-only', '-z', 'HEAD'], dir);
      if (dirty.code !== 0) return yield* Effect.fail(failed(repoUrl, dirty.stderr ?? 'Cannot read author changes'));
      const untracked = yield* git(['ls-files', '--others', '--exclude-standard', '-z'], dir);
      if (untracked.code !== 0) return yield* Effect.fail(failed(repoUrl, untracked.stderr ?? 'Cannot read author additions'));
      for (const path of new Set((dirty.stdout + untracked.stdout).split('\0').filter(Boolean))) yield* preserve(dir, path);
      yield* checkedGit(['checkout', '--detach', '--force', 'origin/main'], dir);
      yield* checkedGit(['reset', '--hard', 'origin/main'], dir);
      yield* checkedGit(['clean', '-fd'], dir);
      return { dir, base: yield* checkedGit(['rev-parse', 'origin/main'], dir) };
    }).pipe(Effect.mapError(error => denied(error.reason) ? new AccessDenied({ repoUrl, reason: error.reason }) : failed(repoUrl, error.reason))),
    commitAndPush: ({ dir, base, files, message, onCommit }: CommitInput) => Effect.gen(function* () {
      yield* checked(dir);
      if ((yield* checkedGit(['rev-parse', 'HEAD'], dir)) !== base) return { kind: 'moved' } as const;
      // Validate every destination before writing the first one.
      for (const path of Object.keys(files)) yield* safeFile(dir, path);
      for (const [path, text] of Object.entries(files)) {
        yield* preserve(dir, path);
        yield* ioError(text === null ? fs.remove(join(dir, path)) : fs.writeTextAtomic(join(dir, path), text), dir);
      }
      yield* identity(dir);
      yield* checkedGit(['add', '--', ...Object.keys(files)], dir);
      yield* checkedGit(['-c', 'commit.gpgSign=false', 'commit', '-m', message], dir);
      const commit = yield* checkedGit(['rev-parse', 'HEAD'], dir);
      yield* onCommit(commit);
      const push = yield* git(['push', '--porcelain', 'origin', 'HEAD:main'], dir);
      if (push.code === 0) return { kind: 'pushed', commit } as const;
      yield* fetch(dir);
      if ((yield* checkedGit(['rev-parse', 'origin/main'], dir)) !== base) return { kind: 'moved' } as const;
      const detail = push.stderr?.trim() || push.stdout.trim() || `Git push exited with code ${push.code}`;
      return denied(detail) ? { kind: 'denied' } as const : { kind: 'failed', detail } as const;
    }).pipe(Effect.catch(error => Effect.succeed<PushOutcome>(denied(error.reason) ? { kind: 'denied' } : { kind: 'failed', detail: error.reason }))),
    tag: (dir: string, commit: string) => Effect.gen(function* () {
      yield* checked(dir);
      const tag = `nortuscc/${commit}`;
      const existing = yield* remoteTag(dir, tag);
      if (existing === commit) return;
      if (existing !== undefined) return yield* Effect.fail(failed(dir, 'Publish tag points at another commit'));
      const local = yield* git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], dir);
      if (local.code === 0 && local.stdout.trim() !== commit) return yield* Effect.fail(failed(dir, 'Local publish tag points at another commit'));
      if (local.code !== 0) yield* checkedGit(['-c', 'tag.gpgSign=false', 'tag', tag, commit], dir);
      const pushed = yield* git(['push', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], dir);
      if (pushed.code !== 0 && (yield* remoteTag(dir, tag)) !== commit) return yield* Effect.fail(failed(dir, pushed.stderr ?? 'Could not push publish tag'));
    }),
    isPublished: (dir: string, commit: string) => Effect.gen(function* () {
      yield* checked(dir);
      yield* fetch(dir);
      const result = yield* git(['merge-base', '--is-ancestor', commit, 'origin/main'], dir);
      return result.code === 0 ? true : result.code === 1 ? false : 'unknown' as const;
    }).pipe(Effect.catch(() => Effect.succeed('unknown' as const))),
  };
}));
