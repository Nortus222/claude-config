import { Data, Effect } from 'effect';
import { Processes, STALL_LIMIT_ARGS } from '@nortuscc/machine';

export const ACCESS_TIMEOUT_MS = 30_000;
const ACCESS_OUTPUT_BYTES = 64 * 1024;
export class AccessDenied extends Data.TaggedError('AccessDenied')<{ readonly repoUrl: string; readonly reason: string }> {}
export class GitFailed extends Data.TaggedError('GitFailed')<{ readonly repoUrl: string; readonly reason: string }> {}

// Use gh's existing credentials and disable repository-provided hooks.
export const gitAuthArgs = (hooksDir: string): readonly string[] => [
  '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-c', `core.hooksPath=${hooksDir}`,
];

// Prove repository access before creating a subscription, without prompting for credentials.
export const proveReadAccess = (repoUrl: string, hooksDir: string): Effect.Effect<void, AccessDenied | GitFailed, Processes> =>
  Effect.gen(function* () {
    const result = yield* Processes.use(processes => processes.run({
      cmd: 'git', args: [...gitAuthArgs(hooksDir), ...STALL_LIMIT_ARGS, 'ls-remote', '--symref', '--', repoUrl, 'HEAD'],
      env: { GIT_TERMINAL_PROMPT: '0' }, output: 'capture', stderr: 'capture',
      captureLimit: { stdout: ACCESS_OUTPUT_BYTES, stderr: ACCESS_OUTPUT_BYTES },
    })).pipe(Effect.mapError(error => new GitFailed({ repoUrl, reason: error.reason })));
    if (result.code === 0) return;
    const reason = result.stderr?.trim() || `git exited with code ${result.code}`;
    const denied = /authentication failed|not found|permission denied|could not read (?:username|password)|terminal prompts disabled|access denied|authorization failed|(?:HTTP|returned error:?)\s*(?:401|403|404)/i.test(reason);
    return yield* Effect.fail(denied ? new AccessDenied({ repoUrl, reason }) : new GitFailed({ repoUrl, reason }));
  }).pipe(
    Effect.timeoutOption(ACCESS_TIMEOUT_MS),
    Effect.flatMap(result => result._tag === 'Some' ? Effect.void : Effect.fail(new GitFailed({ repoUrl, reason: 'repository access check timed out' }))),
  );
