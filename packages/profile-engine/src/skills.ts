import type { SkillGroup } from './model.ts';

export const SKILLS_SOURCE = 'skills-manifest.txt';

const HEADER = /^\[([^\]]+)\]\s*(.*?)\s*$/;

// Reads the source-grouped manifest: `exact` limits a source to the skills listed under it,
// `optional` offers them unchecked, unknown markers are ignored, and a name before any header
// has no source and is dropped.
export function parseSkillsManifest(text: string | undefined): SkillGroup[] {
  if (text === undefined) return [];
  const groups: SkillGroup[] = [];
  let current: SkillGroup | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(HEADER);
    if (header) {
      const markers = header[2]!.split(/\s+/);
      current = {
        source: header[1]!.trim(),
        skills: [],
        exact: markers.includes('exact'),
        optional: markers.includes('optional'),
      };
      groups.push(current);
      continue;
    }
    if (current) current.skills.push(line);
  }
  return groups;
}
