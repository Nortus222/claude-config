import type { SkillGroup } from '@nortuscc/profile-engine';
import { parseItemId } from './items.ts';
import type { Holds } from './store.ts';

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The manifest groups to write into the checkout: `machine` (what this machine implies) with every
// held skill listed exactly as `checkout` declares it, so a command that regenerates the manifest
// never publishes a held value as an upstream change. Groups come out sorted by source; a group a
// hold touched has its skills sorted.
export const checkoutGroups = (
  machine: ReadonlyArray<SkillGroup>,
  checkout: ReadonlyArray<SkillGroup>,
  held: Holds,
): SkillGroup[] => {
  const out = new Map(machine.map((group) => [group.source, { ...group, skills: [...group.skills] }]));
  for (const itemId of Object.keys(held)) {
    const ref = parseItemId(itemId);
    if (ref?.kind !== 'skill') continue;
    const mine = out.get(ref.source);
    if (mine) mine.skills = mine.skills.filter((name) => name !== ref.name);
    const declared = checkout.find((group) => group.source === ref.source && group.skills.includes(ref.name));
    if (!declared) continue;
    const group = out.get(ref.source) ?? { ...declared, skills: [] };
    group.skills = [...new Set([...group.skills, ref.name])].sort(byCodePoint);
    out.set(ref.source, group);
  }
  return [...out.values()].filter((group) => group.skills.length > 0).sort((a, b) => byCodePoint(a.source, b.source));
};
