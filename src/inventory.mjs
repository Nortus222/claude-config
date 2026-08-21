// Pure derivation for the undeclared inventory. No I/O and no node:fs import:
// src/inventory-probe.mjs does every read and hands the results here, the same
// split state.mjs and copy.mjs already draw.

// Marketplaces the agents register on their own behalf, never the user.
//
// Claude Code adds `claude-plugins-official` "automatically the first time you
// start it interactively". Codex reserves `openai-curated` outright — `codex
// plugin marketplace add` refuses the name, and it is rooted under Codex's
// internal `.tmp/` snapshot directory — so it can only ever be Codex's own.
// Reporting either would report an agent's behaviour as the user's drift.
//
// One shared constant, consulted by both declaredIds and manifestDefects, so
// the two can never disagree about what "built-in" means. The two names cannot
// collide, so this does not need to be split per agent.
export const BUILTIN_MARKETPLACES = new Set(['claude-plugins-official', 'openai-curated']);

// The marketplace half of `plugin@marketplace`. A name with no suffix, or one
// that is all suffix, yields null: neither is a marketplace this can check.
export function marketplaceOf(plugin) {
  const at = plugin.lastIndexOf('@');
  return at > 0 ? plugin.slice(at + 1) : null;
}

// `hookCommands` is computed by the probe, which knows where hooks are
// installed; keeping it a parameter is what keeps this module free of paths.
export function declaredIds(integrations = [], hookCommands = []) {
  const plugins = new Set();
  const marketplaces = new Set(BUILTIN_MARKETPLACES);

  for (const item of integrations) {
    if (item.type === 'plugin' && item.plugin) plugins.add(item.plugin);
    if (item.type === 'marketplace' && item.name) marketplaces.add(item.name);
  }

  return { plugins, marketplaces, hooks: new Set(hookCommands) };
}

// A declared plugin whose marketplace is neither declared nor built-in can
// never be installed by `apply --install`: runIntegrations installs only
// declared marketplaces. That is the repo being wrong rather than the machine,
// which is why it is reported apart from the undeclared rows.
//
// It deliberately does not go through validateIntegrations, which is
// fail-closed — an error there yields no integrations at all, and one missing
// marketplace must not stop every other declaration from installing.
export function manifestDefects(integrations = []) {
  const { marketplaces } = declaredIds(integrations);
  const rows = [];

  for (const item of integrations) {
    if (item.type !== 'plugin' || !item.plugin) continue;
    const source = marketplaceOf(item.plugin);
    if (source && !marketplaces.has(source)) {
      rows.push({
        category: 'manifest',
        key: item.plugin,
        label: item.plugin,
        note: `marketplace '${source}' is not declared`,
      });
    }
  }

  return rows;
}

// The categories the probe walks, in report order. `manifest` is not here: it
// describes the repo rather than the machine and is produced by
// manifestDefects, not by comparing against an observation.
export const OBSERVED_CATEGORIES = ['agents', 'plugins', 'marketplaces', 'hooks', 'skills'];

// Present on the machine, named by neither the manifest nor the allow list.
//
// An item carries `key` and `label` separately because they differ for hooks: a
// hook is matched on its command, which is what uniquely identifies a
// registration, but displays its event, which is what a reader recognises.
export function undeclared({ observed = {}, declared = {}, allow = {} } = {}) {
  const rows = [];

  for (const category of OBSERVED_CATEGORIES) {
    const isDeclared = declared[category] ?? new Set();
    const isAllowed = new Set(allow[category] ?? []);

    for (const found of observed[category] ?? []) {
      if (isDeclared.has(found.key) || isAllowed.has(found.key)) continue;
      rows.push({ category, key: found.key, label: found.label, note: found.note ?? '' });
    }
  }

  return rows;
}
