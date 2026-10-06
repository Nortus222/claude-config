import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type LoginEnvironment = { readonly env: Readonly<Record<string, string>>; readonly error?: string };
export const DEFAULT_TOOLS = ['npx', 'claude', 'codex'] as const;

const MARK = '__NORTUSCC_ENV__';
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
// Fixed: the shell runs only this, so rc-file output around the markers is ignored. The backend's own
// runtime prints what the shell exported, as JSON, so any value survives intact.
const script = (runtime: string) =>
  `printf '${MARK}'; ${quote(runtime)} -e 'process.stdout.write(JSON.stringify(process.env))'; printf '${MARK}'`;

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

// Resolves with the output between the markers as soon as it is printed, or undefined when the shell
// closes stdout without it; either way the shell's process group is killed, so background jobs an
// rc file started cannot hold the probe open.
const capture = (shell: string, script: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number) =>
  new Promise<string | undefined>((resolve, reject) => {
    const child = spawn(shell, ['-ilc', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${timeoutMs} ms`))), timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const found = out.match(FOUND);
      if (found) finish(() => resolve(found[1]));
    });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => finish(() => resolve(out.match(FOUND)?.[1])));
  });

// Reads the environment once from the user's login shell, so installers and MCP prerequisites see
// what a terminal sees. Never rejects: on any failure it returns the inherited environment with the
// reason as `error`.
export async function probeLoginEnvironment(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly runtime?: string;
}): Promise<LoginEnvironment> {
  const fallback = strings(input.env);
  const shell = input.env.SHELL && isAbsolute(input.env.SHELL) ? input.env.SHELL : '/bin/zsh';
  try {
    const found = parse(await capture(shell, script(input.runtime ?? process.execPath), input.env, input.timeoutMs ?? 5000));
    if (found) return { env: found };
    return { env: fallback, error: `login shell ${shell} reported no environment; using the app's` };
  } catch (err) {
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
