import { Context, Effect, Layer, Option } from 'effect';
import { boundedNetworkGit, Processes, STALL_LIMIT_ARGS, type LaunchFailed } from '@nortuscc/machine';
import { readDocuments, type Documents } from './documents.ts';
import { RevisionUnavailable } from './source.ts';

// Read-only git in `repo`, stdout captured; stderr goes where the caller's Processes sends it.
const git = (repo: string, args: ReadonlyArray<string>) =>
  Processes.use((p) => p.run({ cmd: 'git', args: [...args], cwd: repo, output: 'capture' }));

// The full SHA of the commit a revision names, or undefined when this repository has none.
export const revParse = (repo: string, revision: string): Effect.Effect<string | undefined, LaunchFailed, Processes> =>
  revision.startsWith('-')
    ? Effect.succeed(undefined)
    : Effect.map(git(repo, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]), ({ code, stdout }) =>
      (code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined));

// Documents already read at a resolved commit, keyed by repository and SHA. A commit's objects never
// change, so a source that provides this reads each commit once instead of once per caller; every
// read otherwise costs one git process per document.
export class CommitDocumentsCache extends Context.Service<CommitDocumentsCache, Map<string, Documents>>()('sync/CommitDocumentsCache') {}
const CACHED_COMMITS = 32;
export const commitDocumentsCache: Layer.Layer<CommitDocumentsCache> = Layer.sync(CommitDocumentsCache, () => new Map());

// A commit's profile documents, read from git objects alone. The commit must exist in `repo`.
export const commitDocuments = (repo: string, commit: string): Effect.Effect<Documents, RevisionUnavailable | LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const sha = yield* revParse(repo, commit);
    if (sha === undefined) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: 'no such commit in the checkout' }));
    const cache = Option.getOrUndefined(yield* Effect.serviceOption(CommitDocumentsCache));
    const key = `${repo}\0${sha}`;
    const documents = cache?.get(key) ?? (yield* readCommitDocuments(repo, commit, sha));
    if (cache !== undefined) {
      // Most recently read last, so eviction drops the least recently read commit.
      cache.delete(key);
      cache.set(key, documents);
      if (cache.size > CACHED_COMMITS) cache.delete(cache.keys().next().value!);
    }
    return documents;
  });

const readCommitDocuments = (repo: string, commit: string, sha: string): Effect.Effect<Documents, RevisionUnavailable | LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const listed = yield* git(repo, ['ls-tree', '-r', '-z', '--name-only', sha]);
    if (listed.code !== 0) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: 'its tree could not be listed' }));
    const tree = new Set(listed.stdout.split('\0').filter(Boolean));
    return yield* readDocuments((path) =>
      Effect.gen(function* () {
        if (!tree.has(path)) return undefined;
        const blob = yield* git(repo, ['cat-file', 'blob', `${sha}:${path}`]);
        if (blob.code !== 0) return yield* Effect.fail(new RevisionUnavailable({ revision: commit, reason: `${path} could not be read` }));
        return blob.stdout;
      }), [...tree].some(path => path.startsWith('profiles/')) ? [...tree].filter(path => /^profiles\/[^/]+\.json$/.test(path)).map(path => path.slice('profiles/'.length)) : undefined);
  });

// Whether `ancestor` is reachable from `descendant`; undefined when git cannot tell.
export const isAncestor = (repo: string, ancestor: string, descendant: string): Effect.Effect<boolean | undefined, LaunchFailed, Processes> =>
  Effect.map(git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]), ({ code }) =>
    (code === 0 ? true : code === 1 ? false : undefined));

// The branch the checkout's current branch tracks: its remote, its name there, and the
// remote-tracking ref a fetch updates.
export type Upstream = { readonly remote: string; readonly branch: string; readonly ref: string };

// undefined on a detached HEAD, a branch with no upstream, or one tracking a local branch.
export const upstreamOf = (repo: string): Effect.Effect<Upstream | undefined, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const head = yield* git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (head.code !== 0) return undefined;
    const local = head.stdout.trim();
    const remote = yield* git(repo, ['config', '--get', `branch.${local}.remote`]);
    const merge = yield* git(repo, ['config', '--get', `branch.${local}.merge`]);
    if (remote.code !== 0 || merge.code !== 0) return undefined;
    const name = remote.stdout.trim();
    const ref = merge.stdout.trim();
    if (name === '' || name === '.' || !ref.startsWith('refs/heads/')) return undefined;
    const branch = ref.slice('refs/heads/'.length);
    return { remote: name, branch, ref: `refs/remotes/${name}/${branch}` };
  });

// origin's URL as configured, or undefined without one.
export const originUrl = (repo: string): Effect.Effect<string | undefined, LaunchFailed, Processes> =>
  Effect.map(git(repo, ['remote', 'get-url', 'origin']), ({ code, stdout }) =>
    (code === 0 && stdout.trim() !== '' ? stdout.trim() : undefined));

// Updates the tracked branch's remote-tracking ref only: never the working tree, the index or HEAD.
// Runs unattended: git, its credential helpers and ssh are told never to prompt, a stalled transfer
// aborts, and a fetch still running after `timeoutMs` has its process group killed. Answers undefined
// once fetched, otherwise a redacted cause; git's stderr is captured, never passed through.
// ssh keeps the repository's core.sshCommand; a GIT_SSH_COMMAND already in the environment is
// replaced, not honoured.
export const fetchTracked = (
  repo: string,
  upstream: Upstream,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<string | undefined, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const configured = yield* git(repo, ['config', '--get', 'core.sshCommand']);
    const ssh = configured.code === 0 && configured.stdout.trim() !== '' ? configured.stdout.trim() : 'ssh';
    return yield* boundedNetworkGit(`git fetch of ${upstream.remote}/${upstream.branch}`, Processes.use((p) => p.run({
      cmd: 'git',
      args: ['-c', 'credential.interactive=never', ...STALL_LIMIT_ARGS, 'fetch', '--quiet', '--no-tags', upstream.remote, `+refs/heads/${upstream.branch}:${upstream.ref}`],
      cwd: repo,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` },
      output: 'capture',
      stderr: 'capture',
    })), options.timeoutMs);
  });
