import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { agentsSkillsDir, repoRoot, claudeDir } from './resolve.mjs';
import { isPlainObject } from './plugins.mjs';

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

const HEADER = /^\[(.+)\]$/;

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
      current = { source: header[1], skills: [] };
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
    '# Install with:    nortuscc apply --skills\n\n';

  return (
    head +
    groups
      .map((g) => `[${g.source}]\n${g.skills.join('\n')}\n`)
      .join('\n')
  );
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

export function manifestPath() {
  return MANIFEST();
}

export function claudeSkillsDir() {
  return join(claudeDir(), 'skills');
}

// skills-check.sh's one behaviour that is not about the manifest: entries
// under ~/.claude/skills are symlinks into ~/.agents/skills, and a skill
// removed from ~/.agents/skills without also removing its Claude-side link
// leaves a broken link behind. Use lstat, not stat, to see the link itself
// rather than follow it into ENOENT — the same distinction link.mjs's
// inspectLink relies on.
export function brokenSkillLinks() {
  const dir = claudeSkillsDir();
  if (!existsSync(dir)) return [];

  const broken = [];
  for (const name of readdirSync(dir)) {
    const linkPath = join(dir, name);
    let stat;
    try {
      stat = lstatSync(linkPath);
    } catch {
      continue; // vanished between readdir and lstat; nothing to report
    }
    if (!stat.isSymbolicLink()) continue;
    // existsSync follows the link and swallows ENOENT, so false here means
    // the link's target is gone.
    if (!existsSync(linkPath)) broken.push(name);
  }
  return broken.sort();
}
