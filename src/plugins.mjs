import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir, repoRoot } from './resolve.mjs';

function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function loadPluginState() {
  return {
    settings: readJson(join(repoRoot(), 'claude', 'settings.json')),
    installed: readJson(join(claudeDir(), 'plugins', 'installed_plugins.json')),
    marketplaces: readJson(join(claudeDir(), 'plugins', 'known_marketplaces.json')),
  };
}

// Pure over parsed JSON so the comparison can be tested without a filesystem.
export function pluginReport(settings, installed, marketplaces) {
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  const wantedMarkets = settings.extraKnownMarketplaces ?? {};

  const missingPlugins = enabled.filter((name) => !(name in (installed ?? {})));
  const missingMarketplaces = Object.keys(wantedMarkets).filter((m) => !(m in (marketplaces ?? {})));

  const commands = [
    ...missingMarketplaces.map((m) => {
      const source = wantedMarkets[m]?.source ?? m;
      return `claude plugin marketplace add ${source}`;
    }),
    ...missingPlugins.map((p) => `claude plugin install ${p}`),
  ];

  return { missingPlugins, missingMarketplaces, commands };
}
