import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { codexDir as realCodexDir } from '../resolve.mjs';
import { spawnCommand } from './runner.mjs';

// Codex installs its own plugins; nortuscc never copies Claude's copy across.
// The two agents keep separate plugin state, which is why inspection below
// reads the Codex directory and nothing else — sharing Claude's state would
// report context-mode as installed for Codex the moment Claude had it, and
// skip the Codex installation entirely.
export function codexMarketplaceCommand(item) {
  return { cmd: 'codex', args: ['plugin', 'marketplace', 'add', item.marketplace] };
}

export function codexPluginCommand(item) {
  return { cmd: 'codex', args: ['plugin', 'install', item.plugin] };
}

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

function marketplaceKey(item) {
  const source = item.marketplace ?? '';
  return source.split('/').pop() ?? source;
}

export function codexPluginAdapters({ codexDir = realCodexDir, spawn = spawnCommand } = {}) {
  const marketplace = {
    inspect: (item) =>
      marketplaceKey(item) in knownMarketplaces(codexDir())
        ? { state: 'installed', note: 'already added' }
        : { state: 'missing', note: '' },
    describe: (item) => {
      const { cmd, args } = codexMarketplaceCommand(item);
      return `${cmd} ${args.join(' ')}`;
    },
    install: (item) => spawn(codexMarketplaceCommand(item)),
  };

  const plugin = {
    inspect: (item) =>
      item.plugin in installedPlugins(codexDir())
        ? { state: 'installed', note: 'already installed' }
        : { state: 'missing', note: '' },
    describe: (item) => {
      const { cmd, args } = codexPluginCommand(item);
      return `${cmd} ${args.join(' ')}`;
    },
    install: (item) => spawn(codexPluginCommand(item)),
  };

  return { marketplace, plugin };
}
