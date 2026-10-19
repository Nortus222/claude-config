import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Effect } from 'effect';
import { Fs, Processes, type MachinePathsValue } from '@nortuscc/machine';
import { gitAuthArgs, proveReadAccess } from './git-auth.ts';
import { FETCH_TIMEOUT_MS, STALL_LIMIT_ARGS } from './git.ts';
import type { FollowedProfile } from './followed.ts';
import { RevisionUnavailable, type Revision } from './source.ts';
const unavailable = (revision: Revision, reason: string) => Effect.fail(new RevisionUnavailable({ revision, reason }));
export const FOLLOWED_MAIN = 'refs/remotes/origin/main';
export const followedClone = (paths: MachinePathsValue, repoUrl: string): string =>
  join(paths.stateRoot, 'agent', 'follow', `${createHash('sha256').update(repoUrl).digest('hex').slice(0, 16)}.git`);

export const followedGit = (paths: MachinePathsValue, repo: string, args: readonly string[]) => Processes.use(p => p.run({
  cmd: 'git', cwd: repo, args: [...gitAuthArgs(join(paths.stateRoot, 'agent', 'empty-hooks')), ...args],
  env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
  output: 'capture', stderr: 'capture',
}));

// A bare repository owned by this source, never the CLI checkout. Retrying an interrupted init is safe.
export const privateFollowedRepository = (paths: MachinePathsValue, followed: FollowedProfile, options: { readonly proveAccess?: boolean } = {}) => Effect.gen(function* () {
  const repo = followedClone(paths, followed.repoUrl);
  const fs = yield* Fs;
  const marker = join(repo, '.nortuscc-follow');
  const hooks = join(paths.stateRoot, 'agent', 'empty-hooks');
  yield* fs.createDirectory(hooks, { recursive: true });
  if (!(yield* fs.exists(repo))) {
    if (options.proveAccess !== false) yield* proveReadAccess(followed.repoUrl, hooks);
    yield* fs.writeTextAtomic(marker, followed.repoUrl + '\n');
  }
  if ((yield* fs.readText(marker)) !== followed.repoUrl + '\n') return yield* unavailable('HEAD', 'private clone is not owned by this repository');
  if (!(yield* fs.exists(join(repo, 'HEAD')))) {
    if ((yield* followedGit(paths, repo, ['init', '--bare', '--quiet'])).code !== 0) return yield* unavailable('HEAD', 'private clone initialization failed');
  }
  const result = yield* followedGit(paths, repo, ['remote', 'get-url', 'origin']);
  const origin = result.code === 0 ? result.stdout.trim() : undefined;
  if (origin === undefined) {
    if ((yield* followedGit(paths, repo, ['remote', 'add', 'origin', followed.repoUrl])).code !== 0) return yield* unavailable('HEAD', 'private origin initialization failed');
  } else if (origin !== followed.repoUrl) return yield* unavailable('HEAD', 'private origin changed');
  return repo;
});

export const fetchFollowedMain = (paths: MachinePathsValue, repo: string, repoUrl: string) => followedGit(paths, repo, [
  ...STALL_LIMIT_ARGS, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', repoUrl, `+refs/heads/main:${FOLLOWED_MAIN}`,
]).pipe(Effect.timeoutOption(FETCH_TIMEOUT_MS), Effect.map(result => result._tag === 'Some' && result.value.code === 0));
