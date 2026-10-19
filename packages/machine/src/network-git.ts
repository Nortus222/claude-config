import { Effect } from 'effect';
import { redactSecretValues } from '@nortuscc/profile-engine';
import type { LaunchFailed } from './errors.ts';
import { Processes, type Completed } from './processes.ts';

// How long a network git command may run before its process group is killed and it counts as failed.
export const FETCH_TIMEOUT_MS = 120_000;

// git config for a network command: an HTTPS transfer below 1000 bytes/s for 30 s aborts instead of
// waiting on a dead connection. The caller's timeout still bounds connecting and ssh.
export const STALL_LIMIT_ARGS: readonly string[] = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];

// How much output a network git command may write to each stream before it is stopped as failed.
export const NETWORK_OUTPUT_BYTES = 64 * 1024;

// Userinfo runs to its last @ before the path. Linear: the text is capped at 1000 characters first,
// and each scheme's scan stops at the next slash.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]*@/gi;
const clean = (text: string) => redactSecretValues(text.slice(0, 1000).replace(URL_USERINFO, '$1')).slice(0, 300);

// One redacted line for a failed network git command, from its captured stderr: which host could
// not be reached when git or ssh says so, otherwise its fatal or error line.
export const networkFailure = (what: string, result: Pick<Completed, 'code' | 'stderr'>): string => {
  const lines = (result.stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (const line of lines) {
    // Userinfo cannot hold an @, so it can end in only one place and the match stays linear.
    const https = /^fatal: unable to access '[a-z][a-z0-9+.-]{0,31}:\/\/(?:[^@/'\s]*@)?([^/:'\s]{1,253})[^']{0,2048}': (.+)$/i.exec(line);
    const ssh = /^ssh: (?:connect to host (\S{1,253}) port \d+|Could not resolve hostname (\S{1,253}?)): (.+)$/.exec(line);
    if (https) return `Couldn't reach ${https[1]}: ${clean(https[2]!)}`;
    if (ssh) return `Couldn't reach ${ssh[1] ?? ssh[2]}: ${clean(ssh[3]!)}`;
  }
  const line = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.find((l) => !/^(warning|hint):/.test(l));
  return line === undefined ? `${what} exited with code ${result.code}` : `${what} failed: ${clean(line.replace(/^(fatal|error):\s*/, ''))}`;
};

// Bounds a network git command, which should capture its stderr, to `timeoutMs`: interruption kills
// its process group. Answers undefined when it succeeded, otherwise a redacted one-line cause.
export const boundedNetworkGit = <E, R>(what: string, run: Effect.Effect<Completed, E, R>, timeoutMs: number = FETCH_TIMEOUT_MS): Effect.Effect<string | undefined, E, R> =>
  run.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map((result) => result._tag === 'None' ? `${what} timed out after ${timeoutMs / 1000} s`
      : result.value.code === 0 ? undefined : networkFailure(what, result.value)),
  );

// Runs `git <args>` in `cwd` against the network, unattended and bounded. git, credential helpers and
// ssh never prompt: ssh keeps the core.sshCommand configured where `cwd` is (its repository's, or system
// and global config outside one) with batch mode added, and replaces any GIT_SSH_COMMAND in the
// environment. A stalled HTTPS transfer aborts, output past NETWORK_OUTPUT_BYTES or a run past
// `timeoutMs` stops its process group, and stderr is captured, never shown. Answers undefined when it
// succeeded, otherwise a redacted one-line cause; fails only when git cannot be launched.
export const networkGit = (
  what: string,
  command: { readonly args: readonly string[]; readonly cwd: string },
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Effect.Effect<string | undefined, LaunchFailed, Processes> =>
  Effect.gen(function* () {
    const processes = yield* Processes;
    const configured = yield* processes.run({ cmd: 'git', args: ['config', '--get', 'core.sshCommand'], cwd: command.cwd, output: 'capture' });
    const ssh = configured.code === 0 && configured.stdout.trim() !== '' ? configured.stdout.trim() : 'ssh';
    const run = processes.run({
      cmd: 'git',
      args: ['-c', 'credential.interactive=never', ...STALL_LIMIT_ARGS, ...command.args],
      cwd: command.cwd,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` },
      output: 'capture',
      stderr: 'capture',
      captureLimit: { stdout: NETWORK_OUTPUT_BYTES, stderr: NETWORK_OUTPUT_BYTES },
    });
    const overflowed = `${what} failed: its output exceeded ${NETWORK_OUTPUT_BYTES / 1024} KiB`;
    return yield* boundedNetworkGit(what, run, timeoutMs).pipe(
      Effect.catchIf((error) => error.reason === 'capture byte limit exceeded', () => Effect.succeed(overflowed)),
    );
  });
