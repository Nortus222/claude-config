import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { StartupDiagnostics, StartupPhase, StartupStatus } from './startup-diagnostics.ts';

export type LoginEnvironment = { readonly env: Readonly<Record<string, string>>; readonly error?: string };
export const DEFAULT_TOOLS = ['npx', 'claude', 'codex'] as const;
export const SHELL_STARTUP_VARIABLES = ['ZDOTDIR', 'XDG_CONFIG_HOME', 'ENV'] as const;

const MARK = '__NORTUSCC_ENV__';
const MAX_OUTPUT = 1_048_576;
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
// Fixed: the shell runs only this, so rc-file output around the markers is ignored. The agent's own
// runtime prints what the shell exported, as JSON, so any value survives intact. It runs from `/`
// because Bun loads `.env` and `bunfig.toml` from its cwd, and an rc file may have `cd`ed into a project.
const script = (runtime: string) =>
  `printf '${MARK}'; cd / && ${quote(runtime)} -e 'process.stdout.write(JSON.stringify(process.env))'; printf '${MARK}'`;

const FOUND = new RegExp(`${MARK}(.*?)${MARK}`, 's');

const strings = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

const parse = (text: string | undefined): Record<string, string> | undefined => {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? strings(value as Record<string, string | undefined>) : undefined;
  } catch {
    return undefined;
  }
};

// Stops the detached probe group once capture ends and joins the child and pipes before settling.
const capture = (shell: string, script: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number, progress: StartupDiagnostics['record'], signal?: AbortSignal) =>
  new Promise<string | undefined>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Login environment probe cancelled', 'AbortError')); return; }
    let phase: StartupPhase = 'shell_spawn';
    progress(phase, 'started');
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch (error) { progress(phase, 'failed'); reject(error); return; }
    let out = '';
    let bytes = 0;
    let settled = false;
    let complete: (() => void) | undefined;
    const cancelled = () => finish('cancelled', () => reject(new DOMException('Login environment probe cancelled', 'AbortError')));
    const finish = (status: StartupStatus, settle: () => void) => {
      if (settled) return;
      settled = true;
      complete = settle;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      progress(phase, status);
      progress('probe_cleanup', 'started');
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => finish('timed_out', () => reject(new Error(`timed out after ${timeoutMs} ms`))), timeoutMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    child.once('spawn', () => {
      if (settled) return;
      progress(phase, 'completed');
      phase = 'shell_ready';
      progress(phase, 'started');
    });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_OUTPUT) {
        finish('failed', () => reject(new Error('login environment output exceeds limit')));
        return;
      }
      out += chunk.toString();
      if (phase === 'shell_ready' && out.includes(MARK)) {
        progress(phase, 'completed');
        phase = 'environment_ready';
        progress(phase, 'started');
      }
      const found = out.match(FOUND);
      if (found) finish('completed', () => resolve(found[1]));
    });
    child.once('error', (error) => finish('failed', () => reject(error)));
    child.once('close', () => {
      finish('failed', () => resolve(undefined));
      progress('probe_cleanup', 'completed');
      complete!();
    });
  });

// The shell selected for the probe and subsequent service starts.
export const loginShell = (env: Readonly<Record<string, string | undefined>>): string =>
  env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';

// Reads the environment once from the user's login shell, so installers and MCP prerequisites see
// what a terminal sees. Failures fall back to inherited values; cancellation rejects after cleanup.
export async function probeLoginEnvironment(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly runtime?: string;
  readonly onProgress?: StartupDiagnostics['record'];
  readonly signal?: AbortSignal;
}): Promise<LoginEnvironment> {
  const fallback = strings(input.env);
  const shell = loginShell(input.env);
  const progress: StartupDiagnostics['record'] = (phase, status) => {
    try { input.onProgress?.(phase, status); } catch {}
  };
  try {
    const found = parse(await capture(shell, script(input.runtime ?? process.execPath), input.env, input.timeoutMs ?? 5000, progress, input.signal));
    input.signal?.throwIfAborted();
    if (found) return { env: found };
    return { env: fallback, error: `login shell ${shell} reported no environment; using the app's` };
  } catch (err) {
    if (input.signal?.aborted) throw new DOMException('Login environment probe cancelled', 'AbortError');
    return { env: fallback, error: `could not read the environment from login shell ${shell}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// One probe failure per tool that is not an executable file on `path`.
export const missingTools = (tools: ReadonlyArray<string>, path: string): string[] =>
  tools
    .filter((tool) => !path.split(':').some((dir) => dir !== '' && executable(join(dir, tool))))
    .map((tool) => `'${tool}' was not found on the login shell's PATH`);
