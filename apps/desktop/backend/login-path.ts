import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type LoginPath = { readonly path: string; readonly error?: string };
export const DEFAULT_TOOLS = ['npx', 'claude', 'codex'] as const;

const MARK = '__NORTUSCC_PATH__';
// Fixed: the shell runs only this, so rc-file output around the markers is ignored.
const SCRIPT = `printf '${MARK}%s${MARK}' "$PATH"`;

const FOUND = new RegExp(`${MARK}(.*?)${MARK}`, 's');

// Resolves with the PATH between the markers as soon as it is printed, or undefined when the shell
// closes stdout without it; either way the shell's process group is killed, so background jobs an
// rc file started cannot hold the probe open.
const capture = (shell: string, env: Readonly<Record<string, string | undefined>>, timeoutMs: number) =>
  new Promise<string | undefined>((resolve, reject) => {
    const child = spawn(shell, ['-ilc', SCRIPT], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
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

// Reads PATH once from the user's login shell, so installers resolve as they do in a terminal.
// Never rejects: on any failure it returns the inherited PATH with the reason as `error`.
export async function probeLoginPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}): Promise<LoginPath> {
  const fallback = input.env.PATH ?? '';
  const shell = input.env.SHELL && isAbsolute(input.env.SHELL) ? input.env.SHELL : '/bin/zsh';
  try {
    const found = await capture(shell, input.env, input.timeoutMs ?? 5000);
    if (found) return { path: found };
    return { path: fallback, error: `login shell ${shell} reported no PATH; using the app's PATH` };
  } catch (err) {
    return { path: fallback, error: `could not read PATH from login shell ${shell}: ${err instanceof Error ? err.message : String(err)}` };
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
