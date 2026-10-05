import { spawn } from 'node:child_process';
import { Context, Effect, Layer } from 'effect';
import { LaunchFailed } from './errors.ts';

export type Command = {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly output: 'inherit' | 'capture';
};
export type Completed = { readonly code: number; readonly stdout: string };

export class Processes extends Context.Service<
  Processes,
  { readonly run: (command: Command) => Effect.Effect<Completed, LaunchFailed> }
>()('machine/Processes') {}

// argv only, never a shell: names and commands come from manifests.
export const nodeProcesses = (options: { readonly path?: string } = {}) =>
  Layer.succeed(Processes, {
    run: (command) =>
      Effect.callback<Completed, LaunchFailed>((resume) => {
        const env = options.path === undefined ? process.env : { ...process.env, PATH: options.path };
        const child = spawn(command.cmd, [...command.args], {
          cwd: command.cwd,
          env,
          shell: false,
          // Its own process group, so cancelling reaches the installer's own children too.
          detached: process.platform !== 'win32',
          stdio: command.output === 'capture' ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        });
        let stdout = '';
        let closed = false;
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.on('error', (err) => resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: err.message }))));
        child.on('close', (code, signal) => {
          closed = true;
          resume(Effect.succeed({ code: code ?? (signal ? 128 : 1), stdout }));
        });

        return Effect.promise(() => new Promise<void>((done) => {
          if (closed) return done();
          const signalGroup = (sig: NodeJS.Signals) => {
            try {
              if (process.platform === 'win32' || child.pid === undefined) child.kill(sig);
              else process.kill(-child.pid, sig);
            } catch {
              // Already gone.
            }
          };
          const force = setTimeout(() => signalGroup('SIGKILL'), 1000);
          child.once('close', () => { clearTimeout(force); done(); });
          signalGroup('SIGTERM');
        }));
      }),
  });
