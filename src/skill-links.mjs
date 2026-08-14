import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './resolve.mjs';
import { SKILL_AGENTS } from './skills-cli.mjs';

// "Installed" and "loadable by this agent" are different questions. One shared
// store under ~/.agents/skills holds every skill; the installer then places a
// copy or a link under each agent's own directory, and that placement — not
// any record of it — is what the agent reads at startup.
//
// This answers the second question from the agent's directory, because the
// installer's own answer cannot. `npx skills list --agent <id>` reports from
// its lockfile: it returns every globally installed skill whichever agent is
// named, including for an agent whose directory holds none of them. A skill
// recorded as installed that never reached an agent is therefore invisible to
// it, and that is the one failure this check exists to catch.

// Derived from SKILL_AGENTS rather than written out again, so the two
// directions of the mapping cannot drift apart.
const TARGET_FOR_AGENT = Object.fromEntries(
  Object.entries(SKILL_AGENTS).map(([target, agent]) => [agent, target]),
);

export function agentSkillsDir(target) {
  return join(agentDir(target), 'skills');
}

// Dot-prefixed entries are the agent's own bookkeeping rather than a shared
// skill — Codex keeps its built-in skills in `.system` beside the installed
// ones. existsSync follows symlinks, so a link whose store entry was removed
// reads as absent, which is exactly what it is to an agent trying to load it.
export function exposedSkillNames(target) {
  const dir = agentSkillsDir(target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .filter((name) => existsSync(join(dir, name)))
    .sort();
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
