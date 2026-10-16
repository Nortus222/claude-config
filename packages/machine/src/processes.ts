import { spawn } from 'node:child_process';
import { processInvocation } from './process-invocation.ts';
import { ownedProcessGroup } from './process-group.ts';
import { StringDecoder } from 'node:string_decoder';
import { Context, Effect, Layer } from 'effect';
import { LaunchFailed } from './errors.ts';

export type Command = {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  // Merged over the layer's environment for this command only.
  readonly env?: Readonly<Record<string, string>>;
  // Opt-in inherited variable allowlist, applied before Command.env overrides.
  readonly envAllow?: ReadonlyArray<string>;
  // Sent only through the child's stdin pipe, which is closed after the input.
  readonly input?: string;
  readonly output: 'inherit' | 'capture';
  // With `output: 'capture'`, also captures stderr into Completed.stderr instead of inheriting it.
  readonly stderr?: 'capture';
  // Opt-in raw byte bounds. Overflow stops the group, with a two-second cleanup deadline.
  readonly captureLimit?: { readonly stdout?: number; readonly stderr?: number };
  // Observes decoded captured chunks while the child runs, within the same byte limits. Exceptions are ignored.
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  // Trusted local observer of bounded forced shutdown, including interruption. Exceptions are ignored.
  readonly onCleanup?: (outcome: { readonly joined: boolean }) => void;
};
// `stderr` is present only when the command asked to capture it.
export type Completed = { readonly code: number; readonly stdout: string; readonly stderr?: string };

export type ProcessesOptions = {
  // The child's whole environment; defaults to this process's.
  readonly env?: Readonly<Record<string, string | undefined>>;
  // Replaces PATH in that environment.
  readonly path?: string;
  // Where an `inherit` command's output goes. 'stderr' keeps it off a stdout that carries a protocol
  // and gives the child no inherited stdin. Explicit Command.input still uses its own pipe.
  readonly inherit?: 'stdio' | 'stderr';
};

export class Processes extends Context.Service<
  Processes,
  { readonly run: (command: Command) => Effect.Effect<Completed, LaunchFailed> }
>()('machine/Processes') {}

// argv only: names and commands come from manifests. A batch file goes through cmd.exe with every
// argument escaped, never as a shell string built from raw input.
export const nodeProcesses = (options: ProcessesOptions = {}) =>
  Layer.succeed(Processes, {
    run: (command) =>
      Effect.callback<Completed, LaunchFailed>((resume) => {
        const invocation = processInvocation(command, options.env ?? process.env, options.path);
        if (invocation === undefined) {
          resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'a batch file cannot take an argument with a line break' })));
          return;
        }
        const { file, args, env, windowsVerbatimArguments } = invocation;
        const captureStderr = command.output === 'capture' && command.stderr === 'capture';
        if (command.captureLimit !== undefined && (command.output !== 'capture'
          || Object.values(command.captureLimit).some(n => !Number.isSafeInteger(n) || n < 0)
          || (command.captureLimit.stderr !== undefined && !captureStderr))) {
          resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'invalid capture byte limit' })));
          return;
        }
        const child = spawn(file, args, {
          cwd: command.cwd,
          env,
          shell: false,
          windowsVerbatimArguments,
          // Its own process group, so cancelling reaches the installer's own children too.
          detached: process.platform !== 'win32',
          stdio: command.output === 'capture' ? [command.input === undefined ? 'ignore' : 'pipe', 'pipe', captureStderr ? 'pipe' : 'inherit']
            : options.inherit === 'stderr' ? [command.input === undefined ? 'ignore' : 'pipe', 2, 2]
            : command.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
        });
        let stdout = '';
        let stderr = '';
        let closed = false;
        let exceeded = false;
        let cleanup: Promise<boolean> | undefined;
        const group = ownedProcessGroup(child);
        const signalGroup = group.signal;
        const stopCapturedGroup = () => group.stop();
        const beginCleanup = () => stopCapturedGroup().then(joined => {
          try { command.onCleanup?.({ joined }); } catch { /* Observers cannot change ownership cleanup. */ }
          return joined;
        });
        // Decoded as one stream each, so a character split across chunks is not mangled.
        const stdoutDecoder = new StringDecoder('utf8');
        const stderrDecoder = new StringDecoder('utf8');
        const deliver = (stream: 'stdout' | 'stderr', chunk: string) => {
          if (stream === 'stdout') stdout += chunk;
          else stderr += chunk;
          if (chunk) {
            try { command.onOutput?.(stream, chunk); } catch { /* Observers cannot change capture or cleanup. */ }
          }
        };
        const capture = (stream: 'stdout' | 'stderr', decoder: StringDecoder) => {
          let bytes = 0;
          return (chunk: Buffer) => {
            if (exceeded) return;
            bytes += chunk.length;
            const limit = command.captureLimit?.[stream];
            if (limit !== undefined && bytes > limit) {
              exceeded = true;
              stdout = ''; stderr = '';
              cleanup = beginCleanup();
              void cleanup.then(joined => resume(Effect.fail(new LaunchFailed({ cmd: command.cmd,
                reason: joined ? 'capture byte limit exceeded' : 'capture cleanup deadline exceeded' }))));
              return;
            }
            deliver(stream, decoder.write(chunk));
          };
        };
        child.stdout?.on('data', capture('stdout', stdoutDecoder));
        child.stderr?.on('data', capture('stderr', stderrDecoder));
        // A closed stdin pipe reports EPIPE or EOF (Windows); the child's exit still determines success.
        child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE' && err.code !== 'EOF') resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'stdin write failed' })));
        });
        if (command.input !== undefined) child.stdin?.end(command.input, 'utf8');
        child.on('error', (err) => resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: err.message }))));
        child.on('close', (code, signal) => {
          closed = true;
          if (exceeded) return;
          deliver('stdout', stdoutDecoder.end()); deliver('stderr', stderrDecoder.end());
          const exit = code ?? (signal ? 128 : 1);
          resume(Effect.succeed(captureStderr ? { code: exit, stdout, stderr } : { code: exit, stdout }));
        });

        return Effect.promise(() => new Promise<void>((done) => {
          if (cleanup !== undefined) { void cleanup.then(() => done()); return; }
          if (closed) return done();
          if (command.captureLimit !== undefined) {
            cleanup = beginCleanup();
            void cleanup.then(() => done());
            return;
          }
          const force = setTimeout(() => { void signalGroup('SIGKILL'); }, 1000);
          child.once('close', () => { clearTimeout(force); done(); });
          void signalGroup('SIGTERM');
        }));
      }),
  });
