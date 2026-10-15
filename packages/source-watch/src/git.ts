import { Processes } from '@nortuscc/machine';
import { joinedDeadline, SourceCleanupFailed } from './services.ts';
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
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM'];

// Reads use no prompts, stable messages, literal pathspecs and no optional index refreshes.
// Disable log signatures so they cannot enter formatted log output.
function environment(input: Readonly<Record<string, string | undefined>>, allowProtocols: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };
  for (const name of INHERITED) delete env[name];
  // Config appended after any the parent passes via GIT_CONFIG_COUNT, so user config survives.
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  env[`GIT_CONFIG_KEY_${count}`] = 'log.showSignature';
  env[`GIT_CONFIG_VALUE_${count}`] = 'false';
  env.GIT_CONFIG_COUNT = String(count + 1);
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
          env: environment(process.env, options.allowProtocols),
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

// Agent callers supply the complete environment. Credential helpers remain configured.
export const machineGit = (input: { readonly env: Readonly<Record<string,string>>; readonly timeoutMs:number; readonly maxBytes:number }): Layer.Layer<Git,never,Processes> =>
  Layer.effect(Git, Effect.map(Processes, processes => ({
    run: (args: ReadonlyArray<string>, {cwd,ok=[0]}: RunOptions = {}) => Effect.suspend(() => {
      if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||!Number.isSafeInteger(input.maxBytes)||input.maxBytes<1) return Effect.fail(new GitFailed({reason:'Invalid source read bounds'}));
      let uncertain = false;
      const stderrBytes=Math.min(16384,Math.floor(input.maxBytes/4));
      const env = Object.fromEntries(Object.entries(environment(input.env, undefined)).filter((entry): entry is [string,string] => entry[1] !== undefined));
      return joinedDeadline(processes.run({cmd:'git',args,...(cwd ? {cwd} : {}),env,envAllow:[],output:'capture',stderr:'capture',
        captureLimit:{stdout:input.maxBytes-stderrBytes,stderr:stderrBytes},onCleanup: outcome => { if (!outcome.joined) uncertain=true; }}),input.timeoutMs).pipe(
        Effect.mapError(() => new GitFailed({reason:'Source Git read unavailable'})),
        Effect.flatMap(result => ok.includes(result.code) && Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr ?? '')<=input.maxBytes
          ? Effect.succeed(result.stdout) : Effect.fail(new GitFailed({reason:'Source Git read unavailable'}))),
        Effect.ensuring(Effect.suspend(() => uncertain ? Effect.die(new SourceCleanupFailed({...(cwd ? {retainedDirectory:cwd} : args[0]==='clone' ? {retainedDirectory:args.at(-1)} : {})})) : Effect.void)),
      );
    }),
  })));
