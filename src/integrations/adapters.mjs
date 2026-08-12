import { claudePluginAdapters } from './claude-plugins.mjs';
import { codexPluginAdapters, readCodexState } from './codex-plugins.mjs';
import { claudeHookAdapter } from './claude-hooks.mjs';
import { codexMcpAdapter } from './codex-mcp.mjs';

// One adapter per declaration type, dispatched by the declaration's target so
// a Codex plugin is never handed to the Claude installer. Every filesystem and
// child-process dependency stays injectable underneath, which is what lets the
// contract tests run against fixture executables and isolated homes.
function byTarget(claude, codex) {
  return {
    inspect: (item) => (item.target === 'codex' ? codex : claude).inspect(item),
    describe: (item) => (item.target === 'codex' ? codex : claude).describe(item),
    install: (item) => (item.target === 'codex' ? codex : claude).install(item),
  };
}

// Async because Codex answers "what is installed?" through its CLI rather than
// a file anyone else may read. The state is read once here, up front, so
// inspection stays synchronous and does not spawn a process per declaration.
export async function defaultAdapters(deps = {}) {
  const claude = claudePluginAdapters(deps.claudePlugins);
  const codexState = deps.codexState ?? (await readCodexState(deps.codexProbe));
  const codex = codexPluginAdapters({ ...deps.codexPlugins, state: codexState });

  return {
    hook: claudeHookAdapter(deps.claudeHooks),
    marketplace: byTarget(claude.marketplace, codex.marketplace),
    plugin: byTarget(claude.plugin, codex.plugin),
    mcp: codexMcpAdapter(deps.codexMcp),
    // Surfaced so a caller can report "Codex state could not be read" rather
    // than quietly presenting everything as missing.
    errors: codexState.errors,
  };
}
