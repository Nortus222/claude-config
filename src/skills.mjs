import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { agentsSkillsDir, repoRoot } from './resolve.mjs';
import { isPlainObject } from './json.mjs';

const MANIFEST = () => join(repoRoot(), 'skills-manifest.txt');
// .skill-lock.json is a sibling of the skills dir under ~/.agents. Deriving it
// from agentsSkillsDir() (rather than homedir() directly) means the
// NORTUSCC_AGENTS_DIR override that redirects the skills dir also redirects
// the lock, so tests never have to touch the real ~/.agents/.skill-lock.json.
const SKILL_LOCK = () => join(dirname(agentsSkillsDir()), '.skill-lock.json');

// A recorded source has to be a string to mean anything — a lock entry like
// {"source": 5} is malformed, not a source. groupsFromLock and reconcile both
// call this so they can never disagree on what counts as "has a source".
function sourceOf(meta) {
  return isPlainObject(meta) && typeof meta.source === 'string' && meta.source ? meta.source : null;
}

// A header is the source in brackets, optionally followed by one marker.
// `exact` is the only marker there is; see EXACT.
const HEADER = /^\[([^\]]+)\]\s*(\S*)\s*$/;

// A source repo can hold far more skills than a machine wants from it:
// cursor/plugins is a monorepo of 82, of which this manifest names one. An
// exact source is taken at its word — the skills listed under it are the only
// ones nortuscc will ever consider from that repo, so `update` neither offers
// the other 81 nor spends a tree listing discovering them. Sources without the
// marker are still scanned, which is how a new skill upstream gets noticed.
const EXACT = 'exact';

// Source-grouped format. Provenance has to live in the repo to be restorable:
// the skill lock is machine-local and empty on a fresh machine.
export function parseManifest(text) {
  const groups = [];
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(HEADER);
    if (header) {
      // An unrecognised marker leaves the group unpinned rather than failing
      // the read: every command that reports anything has to parse this file
      // first, and a typo here should not take `status` down with it. It stays
      // visible as the pin plainly not taking effect.
      current = { source: header[1].trim(), skills: [], exact: header[2] === EXACT };
      groups.push(current);
      continue;
    }
    // A name before any header has no source, so it could never be installed.
    if (current) current.skills.push(line);
  }
  return groups;
}

export function emitManifest(groups) {
  const head =
    '# Skills expected on every machine, grouped by the repo they install from.\n' +
    '# Regenerate with: nortuscc capture\n' +
    '# Install with:    nortuscc apply --install\n' +
    `# A source marked '${EXACT}' is limited to the skills listed under it.\n\n`;

  return (
    head +
    groups
      .map((g) => `[${g.source}]${g.exact ? ` ${EXACT}` : ''}\n${g.skills.join('\n')}\n`)
      .join('\n')
  );
}

// The sources a manifest pins, by name. Kept here rather than derived at each
// call site so "what does exact mean" has one answer.
export function exactSources(groups) {
  return new Set(groups.filter((g) => g.exact).map((g) => g.source));
}

export function groupsFromLock(lock) {
  const bySource = new Map();
  // A malformed lock (wrong shape, or `skills` not itself a plain object)
  // degrades to "nothing known" rather than throwing.
  const skills = isPlainObject(lock) && isPlainObject(lock.skills) ? lock.skills : {};
  for (const [name, meta] of Object.entries(skills)) {
    const source = sourceOf(meta);
    if (!source) continue; // hand-authored locally; nothing to install it from
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(name);
  }
  // Plain code-point ordering (not localeCompare) so the sort is
  // locale-independent and gives a stable, regeneratable diff.
  return [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([source, skills]) => ({ source, skills: skills.sort() }));
}

export function reconcile({ groups, lock, installedNames }) {
  const installed = new Set(installedNames);
  const wanted = new Map();
  for (const g of groups) for (const name of g.skills) wanted.set(name, g.source);

  const lockSkills = isPlainObject(lock) && isPlainObject(lock.skills) ? lock.skills : {};

  const ok = [];
  const missing = [];
  for (const [name, source] of wanted) {
    if (installed.has(name)) ok.push(name);
    else missing.push({ name, source });
  }

  const extra = [];
  const local = [];
  for (const name of installedNames) {
    if (wanted.has(name)) continue;
    // No recorded source means it was authored directly in ~/.agents/skills and
    // can never be installed from anywhere, so it is never written to the manifest.
    if (sourceOf(lockSkills[name])) extra.push(name);
    else local.push(name);
  }

  return { ok, missing, extra, local };
}

export function installArgs(missing) {
  const bySource = new Map();
  for (const { name, source } of missing) {
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push(name);
  }
  return [...bySource.entries()].map(([source, skills]) => ({ source, skills }));
}

export function readSkillsManifest() {
  const path = MANIFEST();
  if (!existsSync(path)) return [];
  return parseManifest(readFileSync(path, 'utf8'));
}

// A lock that cannot be read, or that isn't shaped the way we expect, degrades
// to "nothing known" rather than failing the whole status run. This file is
// owned and written by the third-party `skills` CLI, not by nortuscc.
export function readSkillLock() {
  const path = SKILL_LOCK();
  if (!existsSync(path)) return { skills: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const skills = isPlainObject(parsed) && isPlainObject(parsed.skills) ? parsed.skills : {};
    return { skills };
  } catch {
    return { skills: {} };
  }
}

export function installedSkillNames() {
  const dir = agentsSkillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .sort();
}

// groupsFromLock answers "what does the lock say was installed"; this answers
// "what is installed". They differ whenever a skill folder is removed without
// its lock entry, which is exactly the state a prune leaves behind — so a
// manifest regenerated from the lock alone would restore what a prune removed.
//
// `declared` is the manifest being regenerated. The lock records where a skill
// came from but not how the manifest chose to treat that source, so a rewrite
// built from the lock alone would drop every `exact` marker — silently
// unpinning a source on the next capture. Taking the previous manifest as an
// argument, rather than leaving each caller to reapply the markers, is what
// makes that impossible to forget.
export function installedGroups(lock, installedNames, declared = []) {
  const present = new Set(installedNames);
  const exact = exactSources(declared);
  return groupsFromLock(lock)
    .map((group) => ({
      source: group.source,
      skills: group.skills.filter((n) => present.has(n)),
      exact: exact.has(group.source),
    }))
    .filter((group) => group.skills.length > 0);
}

export function manifestPath() {
  return MANIFEST();
}

// There is one shared skill store, so "installed" and "usable by this agent"
// are different questions. This classifies the second; src/skill-links.mjs
// answers it, per agent, from the directory that agent loads from.
//
// `list` maps an installer agent id to the names that agent can see. An agent
// with no entry counts as seeing nothing: whether that is a genuinely empty
// agent or a failed read is the caller's to report, and the probe keeps a
// failed read out of `list` entirely rather than passing off an empty one.
export function skillExposure({ names, agents, list = {} }) {
  const exposed = [];
  const partial = [];
  const missing = [];

  for (const name of names) {
    const missingAgents = agents.filter((agent) => !(list[agent] ?? []).includes(name));
    if (missingAgents.length === 0) exposed.push(name);
    else if (missingAgents.length === agents.length) missing.push(name);
    else partial.push({ name, missingAgents });
  }

  return { exposed, partial, missing };
}
