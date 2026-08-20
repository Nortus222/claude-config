import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir as realClaudeDir } from '../resolve.mjs';
import { spawnCommand } from './runner.mjs';

// The supported commands, built as argv arrays. Claude owns where plugins land
// and how they update; this only asks it to install them.
export function marketplaceCommand(item) {
  return { cmd: 'claude', args: ['plugin', 'marketplace', 'add', item.marketplace] };
}

export function pluginCommand(item) {
  return { cmd: 'claude', args: ['plugin', 'install', item.plugin] };
}

// A machine that has never run Claude has no plugin files at all, and a file
// written by a tool this repo does not own can be any shape. Both read as
// "nothing installed" rather than throwing and taking a whole status run down.
function readJson(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function installedPlugins(dir) {
  const raw = readJson(join(dir, 'plugins', 'installed_plugins.json'));
  const nested = raw.plugins;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) return nested;
  return 'plugins' in raw ? {} : raw;
}

export function knownMarketplaces(dir) {
  return readJson(join(dir, 'plugins', 'known_marketplaces.json'));
}

// What this machine has installed for the user, with versions.
//
// In the v2 shape each plugin maps to an array of install records carrying
// `scope` and `version`, so a project- or managed-scope install — a
// repository's or an administrator's, not the user's — is dropped here rather
// than reported as machine-wide drift. A value that is not an array is the
// older shape, which records neither field: it counts as a user-scope install
// whose version is unknown, because dropping it would report an out-of-date
// machine as having no plugins at all.
export function userScopeInstalls(dir) {
  const installs = [];

  for (const [name, value] of Object.entries(installedPlugins(dir))) {
    if (!Array.isArray(value)) {
      installs.push({ name, version: null });
      continue;
    }
    const record = value.find((entry) => entry?.scope === 'user');
    if (!record) continue;
    installs.push({ name, version: typeof record.version === 'string' ? record.version : null });
  }

  return installs;
}

// A plugin is named `<plugin>@<marketplace>`, and the marketplace entry Claude
// records is keyed by that same marketplace name — which comes from the
// marketplace's own manifest, not from the `owner/repo` source used to add it.
// `mksglu/context-mode` registers as `context-mode`; `thedotmack/claude-mem`
// registers as `thedotmack`. Deriving it from the source matched neither
// reliably, so the manifest declares it.
function marketplaceKey(item) {
  return item.name;
}

export function claudePluginAdapters({ claudeDir = realClaudeDir, spawn = spawnCommand } = {}) {
  const marketplace = {
    inspect: (item) =>
      marketplaceKey(item) in knownMarketplaces(claudeDir())
        ? { state: 'installed', note: 'already added' }
        : { state: 'missing', note: '' },
    describe: (item) => {
      const { cmd, args } = marketplaceCommand(item);
      return `${cmd} ${args.join(' ')}`;
    },
    install: (item) => spawn(marketplaceCommand(item)),
  };

  const plugin = {
    inspect: (item) =>
      item.plugin in installedPlugins(claudeDir())
        ? { state: 'installed', note: 'already installed' }
        : { state: 'missing', note: '' },
    describe: (item) => {
      const { cmd, args } = pluginCommand(item);
      return `${cmd} ${args.join(' ')}`;
    },
    install: (item) => spawn(pluginCommand(item)),
  };

  return { marketplace, plugin };
}
