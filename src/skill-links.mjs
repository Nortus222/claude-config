import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir, agentsSkillsDir } from './resolve.mjs';
import { SKILL_AGENTS } from './skills-cli.mjs';

// "Installed" and "loadable by this agent" are different questions, but not by
// the same margin for both agents. The installer reports what it did per skill:
//
//   ~/.agents/skills/tdd
//     universal: Codex
//     symlink → Claude Code
//
// Codex reads the shared store itself, so putting a skill in the store is all
// there is to expose it. Claude reads ~/.claude/skills and nothing else, so a
// skill only reaches it through the link the installer makes there. That
// asymmetry is the whole subject of this file: Claude is the agent a skill can
// be installed for and still be unloadable by, and the original bug — 27 skills
// in the store, 9 loadable — was Claude's alone.
//
// The installer's own answer cannot be used for either. `npx skills list
// --agent <id>` reports from its lockfile: it returns every globally installed
// skill whichever agent is named, so it can never see a placement that did not
// happen.

// Derived from SKILL_AGENTS rather than written out again, so the two
// directions of the mapping cannot drift apart.
const TARGET_FOR_AGENT = Object.fromEntries(
  Object.entries(SKILL_AGENTS).map(([target, agent]) => [agent, target]),
);

// Every directory a target loads skills from. Codex gets the shared store
// ahead of its own directory: the store is where the installer puts its
// skills, and ~/.codex/skills holds only Codex's built-in `.system` set on a
// machine installed this way. Both are listed because reading one and calling
// it Codex's answer is the mistake this replaces.
export function agentSkillsDirs(target) {
  const own = join(agentDir(target), 'skills');
  return target === 'codex' ? [agentsSkillsDir(), own] : [own];
}

// Dot-prefixed entries are the agent's own bookkeeping rather than a shared
// skill — Codex keeps its built-in skills in `.system` beside the rest.
// existsSync follows symlinks, so a link whose store entry was removed reads as
// absent, which is exactly what it is to an agent trying to load it.
export function exposedSkillNames(target) {
  const names = new Set();
  for (const dir of agentSkillsDirs(target)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (existsSync(join(dir, entry.name))) names.add(entry.name);
    }
  }
  return [...names].sort();
}

// Same shape and the same installer-agent-id keys as the probe it replaces, so
// every caller and every injected test double is unchanged.
//
// A directory that cannot be read is an error, never an empty list: reading a
// failed read as "this agent has no skills" would report every shared skill as
// unexposed and drive a reinstall of all of them. A missing directory is not a
// failed read — an agent that has never had a skill placed has none.
export function readLinkExposure(agents) {
  const list = {};
  const errors = [];

  for (const agent of agents) {
    const target = TARGET_FOR_AGENT[agent];
    if (!target) {
      errors.push(`no skill directory is known for ${agent}`);
      continue;
    }
    try {
      list[agent] = exposedSkillNames(target);
    } catch (err) {
      errors.push(`could not read the skill directory for ${agent}: ${err.message}`);
    }
  }

  return { list, errors };
}
