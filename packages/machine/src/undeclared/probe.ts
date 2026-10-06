import { join } from 'node:path';
import { Effect } from 'effect';
import type { Category, DesiredConfig, Integration, Target } from '@nortuscc/profile-engine';
import { Fs } from '../fs.ts';
import type { Observed } from '../model.ts';
import { MachinePaths } from '../paths.ts';

// Marketplaces the agents provide on their own behalf, never the user: Claude Code adds
// `claude-plugins-official` on first start; Codex reserves `openai-curated` and serves
// `openai-curated-remote` as its remote catalog.
export const BUILTIN_MARKETPLACES: ReadonlySet<string> = new Set(['claude-plugins-official', 'openai-curated', 'openai-curated-remote']);

// The marketplace half of `plugin@marketplace`; null when there is none to check.
export const marketplaceOf = (plugin: string): string | null => {
  const at = plugin.lastIndexOf('@');
  return at > 0 ? plugin.slice(at + 1) : null;
};

// `key` is what matches a declaration or allow entry; `label` is what a reader recognises (a hook's event).
export type Found = { key: string; label: string; note: string };
type Observation = { items: Found[]; errors: string[] };

// What the integrations domain observed for one agent; the probe never reads plugin state itself.
export type InstalledIntegrations = {
  readonly target: Target;
  readonly plugins: ReadonlyArray<string>;
  readonly marketplaces: ReadonlyArray<string>;
};
export type ProbeInput = {
  readonly targets: ReadonlyArray<Target>;
  readonly installed: ReadonlyArray<InstalledIntegrations>;
  // The commands the declared hooks register, which depend on where hooks are installed.
  readonly hookCommands: ReadonlyArray<string>;
};

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

export function declaredIds(declarations: ReadonlyArray<Integration>, hookCommands: ReadonlyArray<string>) {
  const plugins = new Set<string>();
  const marketplaces = new Set<string>(BUILTIN_MARKETPLACES);
  for (const item of declarations) {
    const plugin = text(item.plugin);
    const name = text(item.name);
    if (item.type === 'plugin' && plugin) plugins.add(plugin);
    if (item.type === 'marketplace' && name) marketplaces.add(name);
  }
  return { plugins, marketplaces, hooks: new Set(hookCommands) };
}

// A declared plugin whose marketplace is neither declared nor built-in can never be installed:
// the repo is wrong, not the machine. Each defect carries its declaration's target.
export function manifestDefects(declarations: ReadonlyArray<Integration>): Array<Found & { target: Target }> {
  const { marketplaces } = declaredIds(declarations, []);
  const rows: Array<Found & { target: Target }> = [];
  for (const item of declarations) {
    const plugin = text(item.plugin);
    if (item.type !== 'plugin' || !plugin) continue;
    const source = marketplaceOf(plugin);
    if (source && !marketplaces.has(source)) {
      rows.push({ key: plugin, label: plugin, note: `marketplace '${source}' is not declared`, target: item.target as Target });
    }
  }
  return rows;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const none: Observation = { items: [], errors: [] };
// Dot-prefixed entries are an agent's own bookkeeping, not content.
const visible = (names: ReadonlyArray<string>) => names.filter((name) => !name.startsWith('.'));

// Nothing declares an agent, so presence is the only signal: every entry is undeclared unless allowed.
export const observedAgents: Effect.Effect<Observation, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs;
  const dir = join((yield* MachinePaths).claude, 'agents');
  const names = yield* Effect.result(fs.list(dir));
  if (names._tag === 'Failure') return { items: [], errors: [`could not read ${dir}: ${names.failure.reason}`] };
  const items: Found[] = [];
  for (const name of visible(names.success ?? [])) {
    let note = '';
    if ((yield* fs.stat(join(dir, name)).pipe(Effect.orElseSucceed(() => undefined)))?.kind === 'symlink') {
      // The target shows how much a link pulls in; the name alone does not.
      note = `-> ${yield* fs.readLink(join(dir, name)).pipe(Effect.orElseSucceed(() => 'unreadable link'))}`;
    }
    items.push({ key: name, label: name, note });
  }
  return { items, errors: [] };
});

// Entries in ~/.claude/skills that did not come from the shared store. Links are resolved, never
// string-compared: relative and absolute links reach the same store.
export const observedSkillLinks: Effect.Effect<Observation, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const dir = join(paths.claude, 'skills');
  const names = yield* Effect.result(fs.list(dir));
  if (names._tag === 'Failure') return { items: [], errors: [`could not read ${dir}: ${names.failure.reason}`] };
  if (names.success === undefined) return none;

  // An absent store means every entry came from elsewhere; one that exists but cannot be resolved is a
  // failed read, and calling it absent would relabel every store-linked skill as undeclared.
  const resolved = yield* Effect.result(fs.realPath(paths.agentsSkills));
  if (resolved._tag === 'Failure') {
    return { items: [], errors: [`could not resolve ${paths.agentsSkills}: ${resolved.failure.reason}`] };
  }
  const store = resolved.success;

  const items: Found[] = [];
  for (const name of visible(names.success)) {
    const real = yield* fs.realPath(join(dir, name)).pipe(Effect.orElseSucceed(() => undefined));
    if (store !== undefined && real === join(store, name)) continue;
    items.push({ key: name, label: name, note: real ? `not from the shared store (-> ${real})` : 'broken link' });
  }
  return { items, errors: [] };
});

// Every hook registered in the user's settings.json, keyed by command and labelled by event.
// Plugin-provided hooks live in the plugin's own configuration and never appear here.
export const observedHooks: Effect.Effect<Observation, never, Fs | MachinePaths> = Effect.gen(function* () {
  const fs = yield* Fs;
  const path = join((yield* MachinePaths).claude, 'settings.json');
  const read = yield* Effect.result(fs.readText(path));
  if (read._tag === 'Failure') return { items: [], errors: [`could not read ${path}: ${read.failure.reason}`] };
  if (read.success === undefined) return none;

  let settings: unknown;
  try {
    settings = JSON.parse(read.success);
  } catch {
    // A file mid-edit must not read as a category that was checked and found clean.
    return { items: [], errors: [`could not parse ${path}`] };
  }
  if (!isRecord(settings) || !isRecord(settings.hooks)) return none;

  const items: Found[] = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks: unknown = isRecord(group) ? group.hooks : undefined;
      for (const hook of Array.isArray(hooks) ? hooks : []) {
        const command = isRecord(hook) ? text(hook.command) : undefined;
        if (command) items.push({ key: command, label: event, note: command });
      }
    }
  }
  return { items, errors: [] };
});

const named = (key: string): Found => ({ key, label: key, note: '' });

// Present on the machine, named by neither a declaration nor the allow list, as `undeclared` items
// keyed `undeclared:<target>:<category>:<key>`. Claude-side categories are walked only when `claude`
// is a target; plugins and marketplaces come from `input.installed`. Items are ordered by category,
// then by observation.
export const probeUndeclared = (desired: DesiredConfig, input: ProbeInput): Effect.Effect<
  { items: Observed[]; probeErrors: string[] },
  never,
  Fs | MachinePaths
> => Effect.gen(function* () {
  const declarations = desired.integrations.map((i) => i.declaration)
    .filter((d) => (input.targets as ReadonlyArray<unknown>).includes(d.target));
  const declared = declaredIds(declarations, input.hookCommands);
  const probeErrors: string[] = [];

  type Seen = { found: Found; target: Target };
  const observed: Record<Category, Seen[]> = { agents: [], plugins: [], marketplaces: [], hooks: [], skills: [] };

  if (input.targets.includes('claude')) {
    const claudeSide: ReadonlyArray<[Category, Effect.Effect<Observation, never, Fs | MachinePaths>]> = [
      ['agents', observedAgents], ['skills', observedSkillLinks], ['hooks', observedHooks],
    ];
    for (const [category, observe] of claudeSide) {
      const { items, errors } = yield* observe;
      observed[category].push(...items.map((found) => ({ found, target: 'claude' as const })));
      probeErrors.push(...errors.map((message) => `${category}: ${message}`));
    }
  }
  for (const entry of input.installed) {
    if (!input.targets.includes(entry.target)) continue;
    observed.plugins.push(...entry.plugins.map((name) => ({ found: named(name), target: entry.target })));
    observed.marketplaces.push(...entry.marketplaces.map((name) => ({ found: named(name), target: entry.target })));
  }

  const isDeclared: Record<Category, ReadonlySet<string>> = {
    agents: new Set(), skills: new Set(), plugins: declared.plugins, marketplaces: declared.marketplaces, hooks: declared.hooks,
  };
  const domains = { agents: 'config', skills: 'skills', plugins: 'integrations', marketplaces: 'integrations', hooks: 'integrations' } as const;
  const items: Observed[] = [];
  for (const category of ['agents', 'plugins', 'marketplaces', 'hooks', 'skills'] as const) {
    const allowed = new Set(desired.allow[category] ?? []);
    for (const { found, target } of observed[category]) {
      if (isDeclared[category].has(found.key) || allowed.has(found.key)) continue;
      items.push({
        key: `undeclared:${target}:${category}:${found.key}`, domain: domains[category], target, label: found.label, group: category,
        state: 'undeclared', disposition: 'undeclared', note: found.note,
      });
    }
  }
  for (const found of manifestDefects(declarations)) {
    items.push({
      key: `undeclared:${found.target}:manifest:${found.key}`, domain: 'integrations', target: found.target,
      label: found.label, group: 'manifest', state: 'defect', disposition: 'undeclared', note: found.note,
    });
  }
  return { items, probeErrors };
});
