import type { ResolvedSkill, SkillGroup } from '@nortuscc/profile-engine';

export const MANIFEST_FILE = 'skills-manifest.txt';

// The installer's `.skill-lock.json`, reduced to its `skills` record; owned by the third-party CLI.
export type SkillLock = { readonly skills: Readonly<Record<string, unknown>> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A lock entry's source when it is a non-empty string; anything else means "authored locally".
export const sourceOf = (meta: unknown): string | null =>
  isRecord(meta) && typeof meta.source === 'string' && meta.source ? meta.source : null;

// The manifest text, byte-identical to the legacy writer so a capture produces no spurious diff.
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
export function installedGroups(
  lock: SkillLock,
  installed: ReadonlyArray<string>,
  declared: ReadonlyArray<SkillGroup> = [],
): SkillGroup[] {
  const present = new Set(installed);
  const exact = new Set(declared.filter((g) => g.exact).map((g) => g.source));
  const groups = groupsFromLock(lock)
    .map((group) => ({ ...group, skills: group.skills.filter((n) => present.has(n)), exact: exact.has(group.source) }))
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
export function manifestOutcome(input: {
  readonly before: ReadonlyArray<SkillGroup>;
  readonly groups: ReadonlyArray<SkillGroup>;
  readonly prunedNames?: ReadonlyArray<string>;
}): { write: boolean; reason: string } {
  const afterCount = input.groups.reduce((n, g) => n + g.skills.length, 0);
  if (afterCount === 0) return { write: false, reason: 'would leave the manifest empty; nothing was written' };
  const after = new Set(input.groups.flatMap((g) => g.skills));
  const pruned = new Set(input.prunedNames ?? []);
  const missing = input.before.flatMap((g) => g.skills).filter((n) => !after.has(n) && !pruned.has(n));
  if (missing.length) {
    return {
      write: false,
      reason: `would drop ${missing.length} entr(ies) (${missing.join(', ')}) not accounted for by the`
        + " prune; run 'nortuscc capture --allow-shrink' if that is intended",
    };
  }
  return { write: true, reason: `${afterCount} skill(s)` };
}
