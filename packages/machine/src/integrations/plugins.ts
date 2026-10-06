import { join } from 'node:path';
import { Effect } from 'effect';
import { Fs } from '../fs.ts';
import { Processes } from '../processes.ts';
import { BUILTIN_MARKETPLACES, marketplaceOf } from '../undeclared/probe.ts';
import type { Declaration, Inspected, Installer } from './declaration.ts';

// Each agent owns where its plugins land and how they update; nortuscc only asks it to install them.
export const marketplaceCommand = (d: Declaration): Installer => ({ cmd: 'claude', args: ['plugin', 'marketplace', 'add', d.marketplace!] });
export const pluginCommand = (d: Declaration): Installer => ({ cmd: 'claude', args: ['plugin', 'install', d.plugin!] });
// Codex has no `plugin install`; `add` takes the PLUGIN@MARKETPLACE selector the manifest already spells.
export const codexMarketplaceCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['plugin', 'marketplace', 'add', d.marketplace!] });
export const codexPluginCommand = (d: Declaration): Installer => ({ cmd: 'codex', args: ['plugin', 'add', d.plugin!] });
export const codexPluginListCommand = (): Installer => ({ cmd: 'codex', args: ['plugin', 'list', '--json', '--available'] });
export const codexMarketplaceListCommand = (): Installer => ({ cmd: 'codex', args: ['plugin', 'marketplace', 'list', '--json'] });

// The installer for a plugin or marketplace, chosen by target so a Codex item never reaches claude.
export const installCommand = (d: Declaration): Installer =>
  d.target === 'codex'
    ? (d.type === 'marketplace' ? codexMarketplaceCommand(d) : codexPluginCommand(d))
    : (d.type === 'marketplace' ? marketplaceCommand(d) : pluginCommand(d));

// What an agent reports installed. An error means that list is unknown, not empty.
export type PluginState = {
  readonly plugins: ReadonlySet<string>;
  readonly marketplaces: ReadonlySet<string>;
  // The marketplaces Codex can install from: registered ones plus catalogs it serves itself. Only Codex sets it.
  readonly catalogs?: ReadonlySet<string>;
  readonly pluginError?: string;
  readonly marketplaceError?: string;
};

export const EMPTY_PLUGIN_STATE: PluginState = { plugins: new Set(), marketplaces: new Set() };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// A file another tool owns can be absent, unreadable or any shape; all of them read as "nothing".
const readJsonObject = (path: string): Effect.Effect<Record<string, unknown>, never, Fs> =>
  Fs.use((fs) => fs.readText(path)).pipe(
    Effect.map((text) => {
      if (text === undefined) return {};
      try {
        const parsed: unknown = JSON.parse(text);
        return isPlainObject(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }),
    Effect.orElseSucceed(() => ({})),
  );

const installedPlugins = (claudeDir: string) =>
  readJsonObject(join(claudeDir, 'plugins', 'installed_plugins.json')).pipe(
    Effect.map((raw) => (isPlainObject(raw.plugins) ? raw.plugins : 'plugins' in raw ? {} : raw)),
  );

export const knownMarketplaces = (claudeDir: string) => readJsonObject(join(claudeDir, 'plugins', 'known_marketplaces.json'));

// User-scope installs with versions. A v2 record carries scope and version; a project or managed
// install is someone else's. The older non-array shape counts as user scope, version unknown.
export const userScopeInstalls = (claudeDir: string) =>
  installedPlugins(claudeDir).pipe(
    Effect.map((plugins) => {
      const installs: { name: string; version: string | null }[] = [];
      for (const [name, value] of Object.entries(plugins)) {
        if (!Array.isArray(value)) {
          installs.push({ name, version: null });
          continue;
        }
        const record = value.find((entry) => isPlainObject(entry) && entry.scope === 'user') as Record<string, unknown> | undefined;
        if (record) installs.push({ name, version: typeof record.version === 'string' ? record.version : null });
      }
      return installs;
    }),
  );

// Claude records its state in files under its own directory.
export const claudePluginState = (claudeDir: string): Effect.Effect<PluginState, never, Fs> =>
  Effect.all([installedPlugins(claudeDir), knownMarketplaces(claudeDir)]).pipe(
    Effect.map(([plugins, marketplaces]) => ({ plugins: new Set(Object.keys(plugins)), marketplaces: new Set(Object.keys(marketplaces)) })),
  );

type Listed<A> = { readonly value: A } | { readonly error: string };

// One `--json` list, parsed by `read`, which throws on a bad shape. A launch failure, a non-zero exit or
// output of another shape becomes an error, never a failure.
export const listJson = <A>(installer: Installer, noun: string, read: (parsed: unknown) => A): Effect.Effect<Listed<A>, never, Processes> =>
  Processes.use((p) => p.run({ cmd: installer.cmd, args: installer.args, output: 'capture' })).pipe(
    Effect.map(({ code, stdout }): Listed<A> => {
      if (code !== 0) return { error: `could not list Codex ${noun}s: exited ${code}` };
      try {
        return { value: read(JSON.parse(stdout)) };
      } catch (err) {
        return { error: `could not read the Codex ${noun} list: ${err instanceof Error ? err.message : String(err)}` };
      }
    }),
    Effect.catchTag('LaunchFailed', (err) => Effect.succeed<Listed<A>>({ error: `could not list Codex ${noun}s: ${err.message}` })),
  );

// The entries of `parsed[list]`; an absent list reads as empty.
const entriesOf = (parsed: unknown, list: string): Record<string, unknown>[] => {
  if (!isPlainObject(parsed)) throw new Error('unexpected output');
  const entries = parsed[list] ?? [];
  if (!Array.isArray(entries)) throw new Error(`'${list}' is not a list`);
  return entries.filter(isPlainObject);
};

const stringsOf = (entries: Record<string, unknown>[], field: string): string[] =>
  entries.flatMap((e) => (typeof e[field] === 'string' ? [e[field]] : []));

// Installed plugin ids, and every marketplace the plugin list mentions (`--available` adds Codex's remote catalog).
const readPlugins = (parsed: unknown) => {
  const installed = entriesOf(parsed, 'installed');
  const available = entriesOf(parsed, 'available');
  return { plugins: new Set(stringsOf(installed, 'pluginId')), offered: new Set(stringsOf([...installed, ...available], 'marketplaceName')) };
};

const readMarketplaces = (parsed: unknown) => new Set(stringsOf(entriesOf(parsed, 'marketplaces'), 'name'));

// Codex keeps no readable state files; its CLI's --json output is the supported answer. Read once per inspect.
export const readCodexState: Effect.Effect<PluginState, never, Processes> = Effect.gen(function* () {
  const plugins = yield* listJson(codexPluginListCommand(), 'plugin', readPlugins);
  const marketplaces = yield* listJson(codexMarketplaceListCommand(), 'marketplace', readMarketplaces);
  const registered = 'value' in marketplaces ? marketplaces.value : new Set<string>();
  const offered = 'value' in plugins ? plugins.value.offered : new Set<string>();
  return {
    plugins: 'value' in plugins ? plugins.value.plugins : new Set<string>(),
    marketplaces: registered,
    catalogs: new Set([...offered, ...registered]),
    ...('error' in plugins ? { pluginError: plugins.error } : {}),
    ...('error' in marketplaces ? { marketplaceError: marketplaces.error } : {}),
  };
});

// A marketplace matches by the name it registers as, which the manifest declares. A Codex plugin whose
// marketplace Codex neither offers nor will get from a declaration is blocked: `codex plugin add` would fail.
export const inspectPlugin = (d: Declaration, state: PluginState, declaredMarketplaces: ReadonlySet<string> = new Set()): Inspected => {
  if (d.type === 'marketplace') {
    if (state.marketplaceError) return { state: 'unknown', note: state.marketplaceError };
    return state.marketplaces.has(d.name!) ? { state: 'installed', note: 'already added' } : { state: 'missing', note: '' };
  }
  if (state.pluginError) return { state: 'unknown', note: state.pluginError };
  if (state.plugins.has(d.plugin!)) return { state: 'installed', note: 'already installed' };
  const marketplace = marketplaceOf(d.plugin!);
  if (state.catalogs && marketplace && !state.catalogs.has(marketplace) && !declaredMarketplaces.has(marketplace)) {
    // Codex reserves its built-in names: they are never added or declared, only offered once signed in and online.
    const note = BUILTIN_MARKETPLACES.has(marketplace)
      ? `Codex is not offering its built-in '${marketplace}' catalog: sign in to Codex and check its network access`
      : `Codex marketplace '${marketplace}' is not configured: add it with codex plugin marketplace add <source>, or declare it in integrations.json`;
    return { state: 'blocked', note };
  }
  return { state: 'missing', note: '' };
};
