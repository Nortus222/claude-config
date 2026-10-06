import { Effect } from 'effect';
import type { Processes } from '../processes.ts';
import type { Declaration, Inspected, Installer } from './declaration.ts';
import { listJson } from './plugins.ts';

export type Env = Readonly<Record<string, string | undefined>>;

// Codex's supported command, not a hand-edited config.toml, whose format Codex owns.
// `--` keeps a server flag from being read as a flag to `codex mcp add`.
export const mcpCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['mcp', 'add', d.id, '--', d.command!, ...(d.args ?? [])] });

// Only names are ever declared, so only names can be printed. An empty value counts as unset.
export const missingEnv = (d: Declaration, env: Env): string[] => (d.requiresEnv ?? []).filter((name) => !env[name]);

export const blockedNote = (d: Declaration, missing: ReadonlyArray<string>): string =>
  `set ${missing.join(', ')} before installing ${d.label}.${d.prerequisite ? ` ${d.prerequisite}` : ''}`.trimEnd();

// The command line never carries a credential; this names the variables the server reads instead.
export const describeMcp = (d: Declaration, env: Env): string => {
  const { cmd, args } = mcpCommand(d);
  const required = d.requiresEnv ?? [];
  const missing = missingEnv(d, env);
  const reads = required.length ? `  (reads ${required.join(', ')} from the environment)` : '';
  const blocked = missing.length ? `  [blocked: ${missing.join(', ')} not set]` : '';
  return `${[cmd, ...args].join(' ')}${reads}${blocked}`;
};

// Blocked, not missing: nothing nortuscc can run will install it until the variables are set.
export const inspectMcp = (d: Declaration, env: Env, installed: ReadonlyArray<string> = []): Inspected => {
  if (installed.includes(d.id)) return { state: 'installed', note: 'already configured' };
  const missing = missingEnv(d, env);
  return missing.length ? { state: 'blocked', note: blockedNote(d, missing) } : { state: 'missing', note: '' };
};

export const codexMcpListCommand = (): Installer => ({ cmd: 'codex', args: ['mcp', 'list', '--json'] });

// The servers Codex has configured. An error means the list could not be read; it then reads as empty.
export type McpState = { readonly servers: ReadonlySet<string>; readonly error?: string };

// Only each server's name is read: the listing also carries its environment, values included.
export const readCodexMcp: Effect.Effect<McpState, never, Processes> = listJson(codexMcpListCommand(), 'MCP server', (parsed) => {
  if (!Array.isArray(parsed)) throw new Error('not a list');
  return new Set(parsed.flatMap((e) => (e !== null && typeof e === 'object' && typeof e.name === 'string' ? [e.name as string] : [])));
}).pipe(
  Effect.map((listed) => ('value' in listed ? { servers: listed.value } : { servers: new Set<string>(), error: listed.error })),
);
