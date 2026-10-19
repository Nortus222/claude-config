import { Effect } from 'effect';
import { redactSecretValues } from '@nortuscc/profile-engine';
import type { Completed } from './processes.ts';

// How long a network git command may run before its process group is killed and it counts as failed.
export const FETCH_TIMEOUT_MS = 120_000;

// git config for a network command: an HTTPS transfer below 1000 bytes/s for 30 s aborts instead of
// waiting on a dead connection. The caller's timeout still bounds connecting and ssh.
export const STALL_LIMIT_ARGS: readonly string[] = ['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=30'];

const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]{0,512}@/gi;
const clean = (text: string) => redactSecretValues(text.slice(0, 1000).replace(URL_USERINFO, '$1')).slice(0, 300);

// One redacted line for a failed network git command, from its captured stderr: which host could
// not be reached when git or ssh says so, otherwise its fatal or error line.
export const networkFailure = (what: string, result: Pick<Completed, 'code' | 'stderr'>): string => {
  const lines = (result.stderr ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (const line of lines) {
    const https = /^fatal: unable to access '[a-z][a-z0-9+.-]{0,31}:\/\/(?:[^@/'\s]{0,512}@)?([^/:'\s]{1,253})[^']{0,2048}': (.+)$/i.exec(line);
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
