const MARKER = '/SKILL.md';

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const depth = (path: string) => path.split('/').length;

// Skill folders among a repository's file paths, by the CLI's rule (`upstreamSkills` in
// src/skill-updates.mjs): a folder holding SKILL.md, never the repository root, with a folder
// nested inside another skill treated as part of it. A skill is named by its folder's basename;
// when two folders share a name, the first in path order wins. Returns name → folder.
export function skillFolders(paths: Iterable<string>): Map<string, string> {
  const folders = [...paths]
    .filter((path) => path.endsWith(MARKER))
    .map((path) => path.slice(0, -MARKER.length))
    .sort((a, b) => depth(a) - depth(b) || byCodePoint(a, b));

  const kept: string[] = [];
  for (const folder of folders) {
    if (!kept.some((parent) => folder.startsWith(`${parent}/`))) kept.push(folder);
  }

  const byName = new Map<string, string>();
  for (const folder of kept.sort(byCodePoint)) {
    const name = folder.slice(folder.lastIndexOf('/') + 1);
    if (!byName.has(name)) byName.set(name, folder);
  }
  return byName;
}
