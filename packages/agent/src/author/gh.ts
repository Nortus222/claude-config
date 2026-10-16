import { Effect } from 'effect';
import { Processes, type Command } from '@nortuscc/machine';

export const GH_LOGIN_TIMEOUT_MS = 900_000;
const GH_STATUS_TIMEOUT_MS = 30_000;
const GH_OUTPUT_BYTES = 64 * 1024;
const DEVICE_URL = 'https://github.com/login/device';
export type GhState = 'ready' | 'missing' | 'signed-out' | 'error';

const command = (args: readonly string[], onOutput?: Command['onOutput']): Command => ({
  cmd: 'gh', args, output: 'capture', stderr: 'capture',
  captureLimit: { stdout: GH_OUTPUT_BYTES, stderr: GH_OUTPUT_BYTES }, onOutput,
});
const launchState = (error: { reason: string }): GhState => /\bENOENT\b/.test(error.reason) ? 'missing' : 'error';

export const ghStatus = (): Effect.Effect<GhState, never, Processes> => Effect.gen(function* () {
  const processes = yield* Processes;
  const version = yield* processes.run(command(['--version']));
  if (version.code !== 0) return 'error' as const;
  const status = yield* processes.run(command(['auth', 'status', '--hostname', 'github.com']));
  return status.code === 0 ? 'ready' as const : status.code === 1 || status.code === 4 ? 'signed-out' as const : 'error' as const;
}).pipe(
  Effect.catch(error => Effect.succeed(launchState(error))),
  Effect.timeoutOption(GH_STATUS_TIMEOUT_MS),
  Effect.map(result => result._tag === 'Some' ? result.value : 'error'),
);

export const ghLogin = (onCode: (code: string, url: string) => void): Effect.Effect<GhState, never, Processes> => Effect.suspend(() => {
  let stderr = '';
  let reported = false;
  return Processes.use(processes => processes.run(command([
    'auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--skip-ssh-key',
  ], (stream, chunk) => {
    if (stream !== 'stderr' || reported) return;
    stderr = (stderr + chunk).slice(-GH_OUTPUT_BYTES);
    const match = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})(?=\s|$)/.exec(stderr);
    if (match) { reported = true; onCode(match[1]!, DEVICE_URL); }
  }))).pipe(
    Effect.map(result => result.code === 0 ? 'ready' as const : result.code === 2 || result.code === 4 ? 'signed-out' as const : 'error' as const),
    Effect.catch(error => Effect.succeed(launchState(error))),
    Effect.timeoutOption(GH_LOGIN_TIMEOUT_MS),
    Effect.map(result => result._tag === 'Some' ? result.value : 'error'),
  );
});
