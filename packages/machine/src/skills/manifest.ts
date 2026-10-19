import type { ResolvedSkill, SkillGroup } from '@nortuscc/profile-engine';
import { matchSkillName, sameSkillName } from './store.ts';

export const MANIFEST_FILE = 'skills-manifest.txt';

// The installer's `.skill-lock.json`, reduced to its `skills` record; owned by the third-party CLI.
export type SkillLock = { readonly skills: Readonly<Record<string, unknown>> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A lock entry's source when it is a non-empty string; anything else means "authored locally".
export const sourceOf = (meta: unknown): string | null =>
  isRecord(meta) && typeof meta.source === 'string' && meta.source ? meta.source : null;

// The manifest text, in the committed manifest's exact format so a capture produces no spurious diff.
export function emitManifest(groups: ReadonlyArray<SkillGroup>): string {
  const head = '# Shared and optional skills, grouped by the repo they install from.\n'
    + '# Regenerate with: nortuscc capture\n'
    + '# Install with:    nortuscc apply --install\n'
    + "# A source marked 'exact' is limited to the skills listed under it.\n"
    + '# A source marked optional is offered unchecked and only installed when selected.\n\n';
  return head + groups
    .map((g) => `[${g.source}]${g.exact ? ' exact' : ''}${g.optional ? ' optional' : ''}\n${g.skills.join('\n')}\n`)
    .join('\n');
}

// The manifest's groups as the engine resolved them, in first-seen source order.
export function groupsOf(skills: ReadonlyArray<ResolvedSkill>): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const s of skills) {
    const group = groups.get(s.source) ?? { source: s.source, skills: [], exact: s.exact, optional: s.optional };
    group.skills.push(s.name);
    groups.set(s.source, group);
  }
  return [...groups.values()];
}

// What the lock says was installed, by source. Entries without a source are local and never listed.
export function groupsFromLock(lock: SkillLock): SkillGroup[] {
  const bySource = new Map<string, string[]>();
  for (const [name, meta] of Object.entries(lock.skills)) {
    const source = sourceOf(meta);
    if (!source) continue;
    bySource.set(source, [...(bySource.get(source) ?? []), name]);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([source, skills]) => ({ source, skills: skills.sort(byCodePoint), exact: false, optional: false }));
}

// The manifest a machine implies: lock sources filtered to what is present, keeping the declared
// manifest's `exact` markers and its optional declarations (an optional skill may never be installed here).
// Names match as the installer matches them, ignoring case, and a declared skill keeps its declared spelling.
export function installedGroups(
  lock: SkillLock,
  installed: ReadonlyArray<string>,
  declared: ReadonlyArray<SkillGroup> = [],
): SkillGroup[] {
  const declaredNames = declared.flatMap((g) => g.skills);
  const spelled = (name: string) => matchSkillName(declaredNames, name) ?? name;
  const exact = new Set(declared.filter((g) => g.exact).map((g) => g.source));
  const groups = groupsFromLock(lock)
    .map((group) => ({
      ...group,
      skills: [...new Set(group.skills.filter((n) => matchSkillName(installed, n) !== undefined).map(spelled))].sort(byCodePoint),
      exact: exact.has(group.source),
    }))
    .filter((group) => group.skills.length > 0);
  for (const declaration of declared.filter((g) => g.optional)) {
    const group = groups.find((g) => g.source === declaration.source);
    if (group) {
      group.optional = true;
      group.skills = [...new Set([...group.skills, ...declaration.skills])].sort(byCodePoint);
    } else {
      groups.push({ ...declaration, skills: [...declaration.skills] });
    }
  }
  return groups.sort((a, b) => byCodePoint(a.source, b.source));
}

// The shrink guard: compares sets, so an adopt cannot mask a miss. Every name the current manifest lists
// that neither survives nor was pruned is one this machine merely lacks, and must not be dropped for everyone.
// A name that differs only in case is the same skill to the installer, so it counts as surviving or pruned.
export function manifestOutcome(input: {
  readonly before: ReadonlyArray<SkillGroup>;
  readonly groups: ReadonlyArray<SkillGroup>;
  readonly prunedNames?: ReadonlyArray<string>;
}): { write: boolean; reason: string } {
  const afterCount = input.groups.reduce((n, g) => n + g.skills.length, 0);
  if (afterCount === 0) return { write: false, reason: 'would leave the manifest empty; nothing was written' };
  const kept = [...input.groups.flatMap((g) => g.skills), ...(input.prunedNames ?? [])];
  const missing = input.before.flatMap((g) => g.skills).filter((n) => !kept.some((k) => sameSkillName(k, n)));
  if (missing.length) {
    return {
      write: false,
      reason: `would drop ${missing.length} entr(ies) (${missing.join(', ')}) not accounted for by the`
        + " prune; run 'nortuscc capture --allow-shrink' if that is intended",
    };
  }
  return { write: true, reason: `${afterCount} skill(s)` };
}

// Routine regeneration never publishes machine additions, including additions overlaid on base intent.
// Installed, pruned and held names match declared ones ignoring case; the declared spelling is kept.
export function updateManifestGroups(input: {
  desired: readonly ResolvedSkill[]; lock: SkillLock; installed: readonly string[];
  prunedNames?: readonly string[]; heldManifestGroups?: readonly SkillGroup[]; heldItemIds?: readonly string[];
}): SkillGroup[] {
  const among = (names: readonly string[]) => (name: string) => names.some(n => sameSkillName(n, name));
  const pruned = among(input.prunedNames ?? []);
  const personal = among(input.desired.filter(s => s.declaredFrom?.layer === 'machine').map(s => s.name));
  const additions = among(input.desired.filter(s => s.targets !== undefined).map(s => s.name));
  const declared = groupsOf(input.desired.filter(s => !personal(s.name))).map(g => ({ ...g, skills: g.skills.filter(n => !pruned(n)) })).filter(g => g.skills.length);
  const groups = installedGroups(input.lock, input.installed.filter(n => !personal(n) && !additions(n)), declared);
  const retain = (declarations: readonly SkillGroup[]) => { for (const group of declarations) {
    for (const name of group.skills) for (const existing of groups) existing.skills = existing.skills.filter(n => !sameSkillName(n, name));
    let target = groups.find(g => g.source === group.source);
    if (!target) { target = { ...group, skills: [] }; groups.push(target); }
    target.skills = [...new Set([...target.skills, ...group.skills])].sort(byCodePoint);
    target.exact = group.exact; target.optional = group.optional;
  } };
  retain(groupsOf(input.desired.filter(s => additions(s.name) && !personal(s.name))));
  for (const id of input.heldItemIds ?? []) {
    const identity = /^skill:([^/]+\/[^/]+)\/([^/]+)$/.exec(id);
    if (identity) for (const group of groups) if (group.source === identity[1]) group.skills = group.skills.filter(name => !sameSkillName(name, identity[2]!));
  }
  retain(input.heldManifestGroups ?? []);
  return groups.filter(g => g.skills.length).sort((a,b) => byCodePoint(a.source,b.source));
}
