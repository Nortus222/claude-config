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

function knownMarketplaces(dir) {
  return readJson(join(dir, 'plugins', 'known_marketplaces.json'));
}

// A plugin is named `<plugin>@<marketplace>`; the marketplace entry Claude
// records is keyed by the marketplace's own name, which is the part after the
// `@` of the plugins that come from it — not the `owner/repo` source used to
// add it.
function marketplaceKey(item) {
  const source = item.marketplace ?? '';
  const tail = source.split('/').pop() ?? source;
  return tail;
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
