import { spawnCommand, captureCommand } from './runner.mjs';

// Codex installs its own plugins; nortuscc never copies Claude's copy across.
//
// Codex's plugin surface is not Claude's. It has no `plugin install` — the
// subcommand is `add`, and passing `install` exits 2 with "unrecognized
// subcommand". It also keeps no `~/.codex/plugins/*.json` for anyone to read:
// its snapshots live under an internal `.tmp/` root, so the supported way to
// ask what is installed is the CLI's own `--json` output.
export function codexMarketplaceCommand(item) {
  return { cmd: 'codex', args: ['plugin', 'marketplace', 'add', item.marketplace] };
}

// `add` takes one selector argument, `PLUGIN@MARKETPLACE`, which the manifest
// already spells that way — so there is nothing to split apart.
export function codexPluginCommand(item) {
  return { cmd: 'codex', args: ['plugin', 'add', item.plugin] };
}

export function codexPluginListCommand() {
  return { cmd: 'codex', args: ['plugin', 'list', '--json'] };
}

export function codexMarketplaceListCommand() {
  return { cmd: 'codex', args: ['plugin', 'marketplace', 'list', '--json'] };
}

// A marketplace's registered name comes from its own manifest, not from the
// source that added it: `mksglu/context-mode` registers as `context-mode` (the
// repo) while `thedotmack/claude-mem` registers as `thedotmack` (the owner).
// No rule derives one from the other, so the manifest declares it and this
// reads what was declared.
export function marketplaceNameOf(item) {
  return item.name;
}

// Read once, up front, rather than per item: inspection would otherwise spawn
// the CLI once for every declaration. A missing CLI or unreadable output
// leaves plugin state unknown rather than crashing the command. The errors
// travel with the empty sets so adapters do not mistake unknown for empty.
export async function readCodexState({ capture = captureCommand } = {}) {
  const state = {
    plugins: new Set(),
    marketplaces: new Set(),
    pluginError: null,
    marketplaceError: null,
    errors: [],
  };

  const plugins = await capture(codexPluginListCommand());
  if (!plugins?.ok) {
    state.pluginError = `could not list Codex plugins${plugins?.note ? `: ${plugins.note}` : ''}`;
    state.errors.push(state.pluginError);
  } else {
    try {
      const parsed = JSON.parse(plugins.stdout);
      for (const entry of parsed.installed ?? []) {
        if (entry?.pluginId) state.plugins.add(entry.pluginId);
      }
    } catch (err) {
      state.pluginError = `could not read the Codex plugin list: ${err.message}`;
      state.errors.push(state.pluginError);
    }
  }

  const marketplaces = await capture(codexMarketplaceListCommand());
  if (!marketplaces?.ok) {
    state.marketplaceError = `could not list Codex marketplaces${marketplaces?.note ? `: ${marketplaces.note}` : ''}`;
    state.errors.push(state.marketplaceError);
  } else {
    try {
      const parsed = JSON.parse(marketplaces.stdout);
      for (const entry of parsed.marketplaces ?? []) {
        if (entry?.name) state.marketplaces.add(entry.name);
      }
    } catch (err) {
      state.marketplaceError = `could not read the Codex marketplace list: ${err.message}`;
      state.errors.push(state.marketplaceError);
    }
  }

  return state;
}

const EMPTY = { plugins: new Set(), marketplaces: new Set(), errors: [] };

export function codexPluginAdapters({ state = EMPTY, spawn = spawnCommand } = {}) {
  const fallbackError = state.errors.length ? state.errors.join('; ') : null;
  const pluginError = Object.hasOwn(state, 'pluginError') ? state.pluginError : fallbackError;
  const marketplaceError = Object.hasOwn(state, 'marketplaceError') ? state.marketplaceError : fallbackError;
  const marketplace = {
    inspect: (item) =>
      marketplaceError
        ? { state: 'unknown', note: marketplaceError }
        : state.marketplaces.has(marketplaceNameOf(item))
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
      pluginError
        ? { state: 'unknown', note: pluginError }
        : state.plugins.has(item.plugin)
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
