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

// Codex's marketplace name is the tail of whatever source added it:
// `mksglu/context-mode` and `https://github.com/mksglu/context-mode.git` both
// register as `context-mode`.
export function marketplaceNameOf(source) {
  const tail = String(source ?? '').split('/').pop() ?? '';
  return tail.replace(/\.git$/, '');
}

// Read once, up front, rather than per item: inspection would otherwise spawn
// the CLI once for every declaration. A machine with no `codex` on PATH, or a
// CLI whose output cannot be parsed, is a machine with no Codex plugins — not
// a crashed status run — so failures degrade to empty sets while still being
// recorded for the caller to report.
export async function readCodexState({ capture = captureCommand } = {}) {
  const state = { plugins: new Set(), marketplaces: new Set(), errors: [] };

  const plugins = await capture(codexPluginListCommand());
  if (!plugins?.ok) {
    state.errors.push(`could not list Codex plugins${plugins?.note ? `: ${plugins.note}` : ''}`);
  } else {
    try {
      const parsed = JSON.parse(plugins.stdout);
      for (const entry of parsed.installed ?? []) {
        if (entry?.pluginId) state.plugins.add(entry.pluginId);
      }
    } catch (err) {
      state.errors.push(`could not read the Codex plugin list: ${err.message}`);
    }
  }

  const marketplaces = await capture(codexMarketplaceListCommand());
  if (!marketplaces?.ok) {
    state.errors.push(`could not list Codex marketplaces${marketplaces?.note ? `: ${marketplaces.note}` : ''}`);
  } else {
    try {
      const parsed = JSON.parse(marketplaces.stdout);
      for (const entry of parsed.marketplaces ?? []) {
        if (entry?.name) state.marketplaces.add(entry.name);
      }
    } catch (err) {
      state.errors.push(`could not read the Codex marketplace list: ${err.message}`);
    }
  }

  return state;
}

const EMPTY = { plugins: new Set(), marketplaces: new Set(), errors: [] };

export function codexPluginAdapters({ state = EMPTY, spawn = spawnCommand } = {}) {
  const marketplace = {
    inspect: (item) =>
      state.marketplaces.has(marketplaceNameOf(item.marketplace))
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
      state.plugins.has(item.plugin)
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
