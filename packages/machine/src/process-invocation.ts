import { statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Command } from './processes.ts';

export type Env = Readonly<Record<string, string | undefined>>;

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

// Resolves a command against an explicitly supplied environment, including Windows npm shims.
export const processInvocation = (command: Pick<Command, 'cmd' | 'args' | 'cwd' | 'env' | 'envAllow'>, base: Env, path?: string) => {
  const configured = path === undefined ? base
    : { ...Object.fromEntries(Object.entries(base).filter(([key]) => key.toUpperCase() !== 'PATH')), PATH: path };
  const allowed = command.envAllow === undefined ? configured : Object.fromEntries(Object.entries(configured)
    .filter(([key]) => command.envAllow!.some(name => process.platform === 'win32' ? name.toUpperCase() === key.toUpperCase() : name === key)));
  const env = withVariables(allowed, command.env);
  const batch = process.platform === 'win32' ? batchFile(command.cmd, command.cwd, env) : undefined;
  if (batch !== undefined && command.args.some(arg => /[\r\n]/.test(arg))) return undefined;
  const [file, args] = batch === undefined ? [command.cmd, [...command.args]]
    : [lookup(env, 'COMSPEC') ?? 'cmd.exe', ['/d', '/s', '/c', `"${[batch.replace(cmdMeta, '^$1'), ...command.args.map(batchArgument)].join(' ')}"`]];
  return { file, args, env, windowsVerbatimArguments: batch !== undefined };
};
