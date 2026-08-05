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

// Check if a value is a plain object (not null, not array, not other type).
// Shared with skills.mjs, which has the same `.skill-lock.json` hole: JSON
// from a source this tool doesn't own can hand back null/arrays/scalars
// anywhere an object is expected, and `typeof x === 'object'` alone doesn't
// rule those out.
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Resolve a marketplace source URL/path, or return null if unresolvable
function resolveMarketplaceSource(sourceValue) {
  if (typeof sourceValue === 'string') {
    return sourceValue;
  }
  if (!isPlainObject(sourceValue)) {
    return null;
  }
  // Handle github source type
  if (sourceValue.source === 'github' && sourceValue.repo) {
    return sourceValue.repo;
  }
  // Handle git and url source types
  if ((sourceValue.source === 'git' || sourceValue.source === 'url') && sourceValue.url) {
    return sourceValue.url;
  }
  // Unknown or incomplete source specification
  return null;
}

// Pure over parsed JSON so the comparison can be tested without a filesystem.
export function pluginReport(settings, installed, marketplaces) {
  const enabled = Object.entries(settings.enabledPlugins ?? {})
    .filter(([, on]) => on)
    .map(([name]) => name);
  const wantedMarkets = settings.extraKnownMarketplaces ?? {};

  // Defensive: extract plugins dict, handling both flat and nested formats
  let installedPluginsDict = {};
  if (isPlainObject(installed)) {
    if (isPlainObject(installed.plugins)) {
      installedPluginsDict = installed.plugins;
    } else if (!('plugins' in installed)) {
      // Flat format without plugins property
      installedPluginsDict = installed;
    }
    // If installed.plugins is not a plain object (e.g., null, string, array), skip it
  }

  const missingPlugins = enabled.filter((name) => !(name in installedPluginsDict));

  // Defensive: ensure marketplaces is a plain object
  let marketplacesDict = {};
  if (isPlainObject(marketplaces)) {
    marketplacesDict = marketplaces;
  }

  const missingMarketplaces = Object.keys(wantedMarkets).filter((m) => !(m in marketplacesDict));

  const commands = [
    ...missingMarketplaces.map((m) => {
      const sourceValue = wantedMarkets[m]?.source;
      const resolved = resolveMarketplaceSource(sourceValue);
      if (resolved) {
        return `claude plugin marketplace add ${resolved}`;
      } else {
        // Source not resolvable: emit a comment instead of a command
        return `# ${m}: source not described in settings`;
      }
    }),
    ...missingPlugins.map((p) => `claude plugin install ${p}`),
  ];

  return { missingPlugins, missingMarketplaces, commands };
}
