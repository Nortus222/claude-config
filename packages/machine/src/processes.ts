import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import { LaunchFailed } from './errors.ts';

export type Command = {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  // Merged over the layer's environment for this command only.
  readonly env?: Readonly<Record<string, string>>;
  // Sent only through the child's stdin pipe, which is closed after the input.
  readonly input?: string;
  readonly output: 'inherit' | 'capture';
  // With `output: 'capture'`, also captures stderr into Completed.stderr instead of inheriting it.
  readonly stderr?: 'capture';
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

type Env = Readonly<Record<string, string | undefined>>;

// Windows variables are case-insensitive: `Path` and `PATH` name one variable.
const lookup = (env: Env, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

// `env` with `extra` set over it; on Windows an extra name replaces the same name in any case.
const withVariables = (env: Env, extra: Readonly<Record<string, string>> | undefined): Env => {
  if (extra === undefined) return env;
  const names = new Set(Object.keys(extra).map((name) => (process.platform === 'win32' ? name.toUpperCase() : name)));
  const kept = Object.entries(env).filter(([key]) => !names.has(process.platform === 'win32' ? key.toUpperCase() : key));
  return { ...Object.fromEntries(kept), ...extra };
};

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

// The batch file Windows would run for `cmd`, if that is what it resolves to. npm installs npx, claude
// and codex as .cmd shims, which only cmd.exe can start.
const batchFile = (cmd: string, cwd: string | undefined, env: Env): string | undefined => {
  const extensions = (lookup(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = extname(cmd) ? [cmd] : extensions.map((ext) => cmd + ext);
  const dirs = /[\\/]/.test(cmd) ? [cwd ?? ''] : (lookup(env, 'PATH') ?? '').split(';').map((dir) => dir.replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const file = resolve(dir, name);
      if (isFile(file)) return /\.(cmd|bat)$/i.test(file) ? file : undefined;
    }
  }
  return undefined;
};

// Everything cmd.exe treats specially, caret-escaped so the line has no unquoted operators.
const cmdMeta = /([()\][%!^"`<>&|;, *?])/g;

// One argument for a batch file: quoted for the program's own argv parser, then caret-escaped twice,
// because cmd.exe parses the line and the shim parses its `%*` again.
const batchArgument = (arg: string) =>
  `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(cmdMeta, '^$1').replace(cmdMeta, '^$1');

// argv only: names and commands come from manifests. A batch file goes through cmd.exe with every
// argument escaped, never as a shell string built from raw input.
export const nodeProcesses = (options: ProcessesOptions = {}) =>
  Layer.succeed(Processes, {
    run: (command) =>
      Effect.callback<Completed, LaunchFailed>((resume) => {
        const base: Env = options.env ?? process.env;
        const env = withVariables(options.path === undefined ? base
          : { ...Object.fromEntries(Object.entries(base).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: options.path }, command.env);
        const batch = process.platform === 'win32' ? batchFile(command.cmd, command.cwd, env) : undefined;
        if (batch !== undefined && command.args.some((arg) => /[\r\n]/.test(arg))) {
          resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'a batch file cannot take an argument with a line break' })));
          return;
        }
        const [file, args] = batch === undefined ? [command.cmd, [...command.args]]
          : [lookup(env, 'COMSPEC') ?? 'cmd.exe', ['/d', '/s', '/c', `"${[batch.replace(cmdMeta, '^$1'), ...command.args.map(batchArgument)].join(' ')}"`]];
        const captureStderr = command.output === 'capture' && command.stderr === 'capture';
        const child = spawn(file, args, {
          cwd: command.cwd,
          env,
          shell: false,
          windowsVerbatimArguments: batch !== undefined,
          // Its own process group, so cancelling reaches the installer's own children too.
          detached: process.platform !== 'win32',
          stdio: command.output === 'capture' ? [command.input === undefined ? 'ignore' : 'pipe', 'pipe', captureStderr ? 'pipe' : 'inherit']
            : options.inherit === 'stderr' ? [command.input === undefined ? 'ignore' : 'pipe', 2, 2]
            : command.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
        });
        let stdout = '';
        let stderr = '';
        let closed = false;
        // Decoded as one stream each, so a character split across chunks is not mangled.
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        // A tool may close stdin before consuming all input. Its exit still determines success.
        child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EPIPE') resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: 'stdin write failed' })));
        });
        if (command.input !== undefined) child.stdin?.end(command.input, 'utf8');
        child.on('error', (err) => resume(Effect.fail(new LaunchFailed({ cmd: command.cmd, reason: err.message }))));
        child.on('close', (code, signal) => {
          closed = true;
          const exit = code ?? (signal ? 128 : 1);
          resume(Effect.succeed(captureStderr ? { code: exit, stdout, stderr } : { code: exit, stdout }));
        });

        return Effect.promise(() => new Promise<void>((done) => {
          if (closed) return done();
          const signalGroup = (sig: NodeJS.Signals) => {
            try {
              if (child.pid === undefined) child.kill(sig);
              // Windows has no process groups; taskkill /T ends the tree, such as the node a shim started.
              else if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('error', () => child.kill(sig));
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
