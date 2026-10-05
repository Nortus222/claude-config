import { spawn } from 'node:child_process';
import { Context, Data, Effect, Layer } from 'effect';
import type { Commit } from './model.ts';
import { redact } from './redact.ts';

// A git command exited outside its accepted codes or could not start. `reason` is redacted.
export class GitFailed extends Data.TaggedError('GitFailed')<{ readonly reason: string }> {}

// `ok` lists the exit codes that count as success; [0] by default.
export type RunOptions = { readonly cwd?: string; readonly ok?: ReadonlyArray<number> };

// git as the watcher needs it: run one command and get its stdout.
export class Git extends Context.Service<
  Git,
  { readonly run: (args: ReadonlyArray<string>, options?: RunOptions) => Effect.Effect<string, GitFailed> }
>()('source-watch/Git') {}

// Variables a parent git process (a hook, say) may export that would redirect our commands.
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'];

function environment(allowProtocols: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  for (const name of INHERITED) delete env[name];
  if (allowProtocols !== undefined) env.GIT_ALLOW_PROTOCOL = allowProtocols;
  return env;
}

// Extract the most relevant error message from git's stderr, preferring fatal/error lines.
function failure(stderr: string, args: ReadonlyArray<string>, code: number | null): GitFailed {
  const lines = stderr.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const fatalOrError = lines.find((l) => /^(fatal|error):/.test(l));
  const firstOther = lines.find((l) => !/^(warning|hint):/.test(l));
  const line = fatalOrError ?? firstOther ?? `git ${args[0] ?? ''} exited with code ${code}`;
  return new GitFailed({ reason: redact(line) });
}

// Runs the git on PATH without a shell, never prompting. `allowProtocols` limits the transports
// git may use (GIT_ALLOW_PROTOCOL); the user's credential helpers are left in place.
export const nodeGit = (options: { readonly allowProtocols?: string } = {}) =>
  Layer.succeed(Git, {
    run: (args, { cwd, ok = [0] } = {}) =>
      Effect.callback<string, GitFailed>((resume) => {
        const child = spawn('git', [...args], {
          cwd,
          env: environment(options.allowProtocols),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let settled = false;
        const settle = (effect: Effect.Effect<string, GitFailed>) => {
          if (settled) return;
          settled = true;
          resume(effect);
        };
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', (e) => settle(Effect.fail(new GitFailed({ reason: redact(e.message) }))));
        child.on('close', (code) =>
          settle(
            code !== null && ok.includes(code)
              ? Effect.succeed(Buffer.concat(out).toString('utf8'))
              : Effect.fail(failure(Buffer.concat(err).toString('utf8'), args, code)),
          ),
        );
        return Effect.sync(() => void child.kill());
      }),
  });

// Log output parseLog reads: sha, subject, author name and strict ISO committer date. No email.
export const LOG_FORMAT = '--format=%H%x1f%s%x1f%an%x1f%cI%x1e';

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', subject = '', author = '', date = ''] = record.split('\x1f');
      return { sha, subject, author, date };
    });
}

// Plain unified diffs, whatever diff drivers or colour the user configured.
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv'] as const;
