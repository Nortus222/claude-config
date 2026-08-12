import { spawnCommand } from './runner.mjs';

// The supported Codex MCP command interface, not a hand-edited config.toml:
// Codex owns that file's format, and rewriting it behind Codex's back is
// exactly the layout ownership the design hands back to the native tool.
//
// `--` separates nortuscc's own arguments from the server's, so a server flag
// can never be read as a flag to `codex mcp add`.
export function mcpCommand(item) {
  return {
    cmd: 'codex',
    args: ['mcp', 'add', item.id, '--', item.command, ...(item.args ?? [])],
  };
}

// Only the *names* of required variables are ever declared, so only names can
// ever be printed. An empty string counts as absent: an unset credential that
// happens to be exported empty is not a satisfied prerequisite.
function missingEnv(item, env) {
  return (item.requiresEnv ?? []).filter((name) => !env[name]);
}

function blockedNote(item, missing) {
  const guidance = item.prerequisite ? ` ${item.prerequisite}` : '';
  return `set ${missing.join(', ')} before installing ${item.label}.${guidance}`.trimEnd();
}

export function describeMcp(item, { env = process.env } = {}) {
  const { cmd, args } = mcpCommand(item);
  const required = item.requiresEnv ?? [];
  // The command line never carries a credential, and neither does this
  // description: it names the variables the server reads from the environment.
  const suffix = required.length ? `  (reads ${required.join(', ')} from the environment)` : '';
  const missing = missingEnv(item, env);
  const blocked = missing.length ? `  [blocked: ${missing.join(', ')} not set]` : '';
  return `${cmd} ${args.join(' ')}${suffix}${blocked}`;
}

export function inspectMcp(item, { env = process.env, installed = [] } = {}) {
  if (installed.includes(item.id)) return { state: 'installed', note: 'already configured' };

  const missing = missingEnv(item, env);
  // Blocked, not missing: nothing nortuscc can do will install this, and
  // saying "missing" would invite a retry that fails the same way.
  if (missing.length) return { state: 'blocked', note: blockedNote(item, missing) };

  return { state: 'missing', note: '' };
}

// A missing prerequisite stops the run *before* the child process, so nothing
// is half-configured and nothing prompts nortuscc to persist the secret.
export async function installMcp(item, { env = process.env, spawn = spawnCommand } = {}) {
  const missing = missingEnv(item, env);
  if (missing.length) return { ok: false, note: blockedNote(item, missing) };

  return spawn(mcpCommand(item));
}

export function codexMcpAdapter({ env = process.env, spawn = spawnCommand, installed = () => [] } = {}) {
  return {
    inspect: (item) => inspectMcp(item, { env, installed: installed() }),
    describe: (item) => describeMcp(item, { env }),
    install: (item) => installMcp(item, { env, spawn }),
  };
}
