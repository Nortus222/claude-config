import { basename, dirname } from 'node:path';
import { isPlainObject } from './json.mjs';

// The lock records the path of a skill's SKILL.md, but the tree SHA that
// identifies a version belongs to the directory containing it. A SKILL.md at
// the repo root has no containing directory, so it maps to '.' — git's own
// name for the root tree, which `rev-parse HEAD:.` resolves.
export function skillFolder(skillPath) {
  const dir = dirname(skillPath);
  return dir === '' || dir === '/' ? '.' : dir;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

// An entry is updatable only if it names both where it came from and where it
// lives in that repo. A source with no skillPath cannot be located upstream,
// so there is no SHA to compare and nothing this command could do with it.
export function updatableSkills(lock, installedNames) {
  const skills = isPlainObject(lock) && isPlainObject(lock.skills) ? lock.skills : {};
  const entries = [];
  for (const name of installedNames) {
    const meta = skills[name];
    if (!isPlainObject(meta)) continue;
    const source = str(meta.source);
    const skillPath = str(meta.skillPath);
    if (!source || !skillPath) continue;
    entries.push({
      name,
      source,
      // Older lock entries predate sourceUrl; the "owner/repo" shorthand is
      // what `git clone` accepts from GitHub anyway, so it is a safe fallback.
      sourceUrl: str(meta.sourceUrl) || `https://github.com/${source}.git`,
      path: skillFolder(skillPath),
      hash: str(meta.skillFolderHash),
    });
  }
  return entries;
}

// Grouped by sourceUrl, because that is what gets cloned — two sources that
// differ only in shorthand would otherwise be fetched twice. Plain code-point
// ordering, not localeCompare, so the order is locale-independent.
export function sourcesOf(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    if (!byUrl.has(entry.sourceUrl)) {
      byUrl.set(entry.sourceUrl, { source: entry.source, sourceUrl: entry.sourceUrl, paths: [] });
    }
    byUrl.get(entry.sourceUrl).paths.push(entry.path);
  }
  return [...byUrl.values()].sort((a, b) =>
    a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0,
  );
}

export function planUpdates({ lock, installedNames, remoteTrees }) {
  const names = [...installedNames].sort();
  const entries = updatableSkills(lock, names);
  const updatable = new Set(entries.map((e) => e.name));

  const plan = { current: [], outdated: [], gone: [], unknown: [], local: [] };

  // Nothing could ever update a skill with no recorded source, so it is
  // reported and skipped — the same treatment groupsFromLock gives it when
  // deciding what may be written to the manifest.
  for (const name of names) if (!updatable.has(name)) plan.local.push(name);

  for (const entry of entries) {
    const trees = remoteTrees.get(entry.sourceUrl);
    if (!trees) {
      // The source could not be reached at all. Saying "current" here would be
      // a claim we did not verify, so it gets its own state.
      plan.unknown.push({ name: entry.name, source: entry.source });
      continue;
    }
    const remote = trees.get(entry.path) ?? null;
    if (remote === null) {
      plan.gone.push({ name: entry.name, source: entry.source, path: entry.path });
      continue;
    }
    if (remote === entry.hash) {
      plan.current.push(entry.name);
      continue;
    }
    // A missing hash lands here too, as `from: null`. We cannot verify what is
    // installed, and re-fetching is exactly what repairs that.
    plan.outdated.push({ name: entry.name, source: entry.source, from: entry.hash, to: remote });
  }
  return plan;
}

// Every SKILL.md in a source repo, reduced to the skills it would install as.
// A skill's installed name is its folder name, so the mapping is structural —
// but two shapes have to be rejected first.
export function upstreamSkills(skillPaths) {
  const folders = skillPaths
    .map((p) => skillFolder(p))
    // A repo-root SKILL.md makes the repo itself one skill, taking its name
    // from the repo rather than the path. Nothing here can derive that, so it
    // is skipped rather than guessed at.
    .filter((dir) => dir !== '.')
    // Shallowest first, so the nesting check below always sees a parent before
    // any of its children.
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));

  const kept = [];
  for (const dir of folders) {
    // A SKILL.md beneath a folder that already holds one is a sub-resource.
    // The trailing slash matters: `s/tdd-extra` must not read as nested under
    // `s/tdd`.
    if (kept.some((k) => dir.startsWith(`${k}/`))) continue;
    kept.push(dir);
  }

  return kept
    .map((path) => ({ path, name: basename(path) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// Upstream skills that are not installed here. Not a state of an installed
// skill — which is why it is computed separately from planUpdates rather than
// being a sixth bucket in it.
export function availableSkills({ upstreamBySource, installedNames }) {
  const installed = new Set(installedNames);
  const seen = new Set();
  const out = [];
  for (const [source, skills] of upstreamBySource) {
    for (const { name } of skills) {
      // Two sources can offer the same name, but only one folder can ever
      // exist under ~/.agents/skills, so the first source wins and the
      // duplicate is not offered twice.
      if (installed.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
