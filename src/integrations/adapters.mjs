import { claudePluginAdapters } from './claude-plugins.mjs';
import { codexPluginAdapters } from './codex-plugins.mjs';
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

export function defaultAdapters(deps = {}) {
  const claude = claudePluginAdapters(deps.claudePlugins);
  const codex = codexPluginAdapters(deps.codexPlugins);

  return {
    hook: claudeHookAdapter(deps.claudeHooks),
    marketplace: byTarget(claude.marketplace, codex.marketplace),
    plugin: byTarget(claude.plugin, codex.plugin),
    mcp: codexMcpAdapter(deps.codexMcp),
  };
}
