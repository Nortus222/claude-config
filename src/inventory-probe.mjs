// Every read the inventory pass performs. src/inventory.mjs derives findings
// from what this returns and imports no node:fs, the same split state.mjs and
// copy.mjs already draw.
//
// A failed read becomes an errors[] entry and never an exception — the contract
// readLinkExposure already keeps — so one unreadable directory cannot take a
// whole status run down. A directory that is merely absent is not a failure: a
// machine that never placed an agent has none.
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir as realClaudeDir, agentsSkillsDir as realAgentsSkillsDir } from './resolve.mjs';
import { isPlainObject } from './json.mjs';
import { userScopeInstalls, knownMarketplaces } from './integrations/claude-plugins.mjs';
import { hookCommand } from './integrations/claude-hooks.mjs';

// Dot-prefixed entries are an agent's own bookkeeping rather than content,
// exactly as exposedSkillNames already treats them.
function entriesOf(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
}

// Nothing in this repo declares an agent — no code reads ~/.claude/agents at
// all — so presence is the only signal there is, and every entry is undeclared
// until an allow entry says otherwise. That silence is what let a symlink
// exposing 24 third-party agents survive 13 months.
export function observedAgents({ claudeDir = realClaudeDir } = {}) {
  const dir = join(claudeDir(), 'agents');
  if (!existsSync(dir)) return { items: [], errors: [] };

  try {
    const items = entriesOf(dir).map((entry) => {
      let note = '';
      if (entry.isSymbolicLink()) {
        // The target is what made the 24-agent case legible: the name alone
        // says nothing about how much it pulls in.
        try {
          note = `-> ${readlinkSync(join(dir, entry.name))}`;
        } catch {
          note = '-> unreadable link';
        }
      }
      return { key: entry.name, label: entry.name, note };
    });
    return { items, errors: [] };
  } catch (err) {
    return { items: [], errors: [{ category: 'agents', message: `could not read ${dir}: ${err.message}` }] };
  }
}

// Entries in ~/.claude/skills that did not come from the shared store.
//
// Deliberately narrow: reconcile() already reports store-level extras and
// status already prints them. This covers only the hole reconcile cannot see —
// a hand-placed directory, or a link pointing somewhere else. Claude loads it
// either way.
//
// Links are RESOLVED, never string-compared. The same store is reached by
// relative links (../../.agents/skills/<name>) and absolute ones
// (/Users/<user>/.agents/skills/<name>), and a machine holds both forms at
// once; comparing link text reported every absolute link as undeclared.
export function observedSkillLinks({ claudeDir = realClaudeDir, agentsSkills = realAgentsSkillsDir } = {}) {
  const dir = join(claudeDir(), 'skills');
  if (!existsSync(dir)) return { items: [], errors: [] };

  let store = null;
  try {
    store = realpathSync(agentsSkills());
  } catch (err) {
    // Absent is not a failure: with no store at all, every entry here came from
    // somewhere else by definition. A store that exists but cannot be resolved
    // is a failed read, and reporting it as absent would relabel every
    // store-linked skill as undeclared with nothing to say why.
    if (err.code !== 'ENOENT') {
      return {
        items: [],
        errors: [{ category: 'skills', message: `could not resolve ${agentsSkills()}: ${err.message}` }],
      };
    }
  }

  try {
    const items = [];
    for (const entry of entriesOf(dir)) {
      const path = join(dir, entry.name);
      let real = null;
      try {
        real = realpathSync(path);
      } catch {
        real = null;
      }

      if (store && real === join(store, entry.name)) continue;

      items.push({
        key: entry.name,
        label: entry.name,
        note: real ? `not from the shared store (-> ${real})` : 'broken link',
      });
    }
    return { items, errors: [] };
  } catch (err) {
    return { items: [], errors: [{ category: 'skills', message: `could not read ${dir}: ${err.message}` }] };
  }
}

// Every hook registered in the user's settings.json, keyed by the command that
// identifies the registration and labelled by the event a reader recognises.
//
// Plugin-provided hooks do not appear here: they live in the plugin's own
// configuration, not in this file, so a plugin's hooks are never reported as
// the user's undeclared ones.
export function observedHooks({ claudeDir = realClaudeDir } = {}) {
  const path = join(claudeDir(), 'settings.json');
  if (!existsSync(path)) return { items: [], errors: [] };

  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Distinguished from "no hooks" on purpose: the user's file, mid-edit or
    // hand-broken, must not read as a category that was checked and found clean.
    return { items: [], errors: [{ category: 'hooks', message: `could not parse ${path}` }] };
  }
  if (!isPlainObject(settings) || !isPlainObject(settings.hooks)) return { items: [], errors: [] };

  const items = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks ?? []) {
        if (typeof hook?.command !== 'string' || !hook.command) continue;
        items.push({ key: hook.command, label: event, note: hook.command });
      }
    }
  }
  return { items, errors: [] };
}

// What each declared hook would register. Computed here rather than in
// inventory.mjs because it depends on where hooks are installed, and that is a
// path — the one thing the pure module has none of.
export function declaredHookCommands(integrations = [], { claudeDir = realClaudeDir } = {}) {
  return integrations
    .filter((item) => item.type === 'hook' && item.file)
    .map((item) => hookCommand(item, { claudeDir }));
}

const named = (key) => ({ key, label: key, note: '' });

// One observation of the whole machine, narrowed by --target exactly as every
// other section is. Agents, skill links and hooks are Claude-side categories
// and are not walked for a Codex-only report.
//
// Claude and Codex plugin ids share one `plugins` list, and their declarations
// share one set. Under --target all that unions them, so a plugin declared for
// one agent and installed on the other reads as declared — a narrow blind spot,
// accepted because the alternative is a doubled shape through every function,
// and because a report covering both agents was asked about both.
export function probe({
  target = 'all',
  integrations = [],
  codexState = null,
  claudeDir = realClaudeDir,
  agentsSkills = realAgentsSkillsDir,
} = {}) {
  const observed = { agents: [], plugins: [], marketplaces: [], hooks: [], skills: [] };
  const errors = [];
  const pluginVersions = [];

  if (target === 'all' || target === 'claude') {
    const agents = observedAgents({ claudeDir });
    const skills = observedSkillLinks({ claudeDir, agentsSkills });
    const hooks = observedHooks({ claudeDir });
    observed.agents.push(...agents.items);
    observed.skills.push(...skills.items);
    observed.hooks.push(...hooks.items);
    errors.push(...agents.errors, ...skills.errors, ...hooks.errors);

    for (const { name, version } of userScopeInstalls(claudeDir())) {
      observed.plugins.push(named(name));
      pluginVersions.push([name, version]);
    }
    for (const name of Object.keys(knownMarketplaces(claudeDir()))) {
      observed.marketplaces.push(named(name));
    }
  }

  if ((target === 'all' || target === 'codex') && codexState) {
    // A Codex CLI that could not be launched, or whose output could not be
    // parsed, reports empty sets. Surfacing its errors is what stops that from
    // reading as "Codex has nothing installed" — the failure this whole report
    // exists to make visible.
    for (const message of codexState.errors ?? []) errors.push({ category: 'codex', message });

    // Codex reports no version through its CLI, so its plugins are recorded
    // with an unknown one rather than left out of the version report entirely.
    for (const name of codexState.plugins ?? []) {
      observed.plugins.push(named(name));
      pluginVersions.push([name, null]);
    }
    for (const name of codexState.marketplaces ?? []) observed.marketplaces.push(named(name));
  }

  return {
    observed,
    hookCommands: declaredHookCommands(integrations, { claudeDir }),
    pluginVersions,
    errors,
  };
}
