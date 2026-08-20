// Every read the inventory pass performs. src/inventory.mjs derives findings
// from what this returns and imports no node:fs, the same split state.mjs and
// copy.mjs already draw.
//
// A failed read becomes an errors[] entry and never an exception — the contract
// readLinkExposure already keeps — so one unreadable directory cannot take a
// whole status run down. A directory that is merely absent is not a failure: a
// machine that never placed an agent has none.
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir as realClaudeDir, agentsSkillsDir as realAgentsSkillsDir } from './resolve.mjs';

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
  } catch {
    // No store at all: every entry here came from somewhere else by definition.
    store = null;
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
