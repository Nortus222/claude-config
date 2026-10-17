import { join } from 'node:path';
import { Effect } from 'effect';
import { TARGETS, type DesiredConfig, type Target } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import type { Domain, MachineReport, Observed, PlanKind, Selection, Skipped, Step, StepResult } from '../model.ts';
import { Fs } from '../fs.ts';
import { FileIntegrity } from '../file-integrity.ts';
import { checkSkillOwnership, disableOwnedSkill } from './ownership.ts';
import { MachinePaths } from '../paths.ts';
import type { Processes } from '../processes.ts';
import { SKILL_AGENTS, addCommand, missingSkillsNote, removeCommand, runInstaller, updateCommand } from './installer.ts';
import { MANIFEST_FILE, emitManifest, groupsOf, manifestOutcome, sourceOf, updateManifestGroups } from './manifest.ts';
import { lockRef, offPinNote, pinnedSource, pinsBySource, short, splitPinned } from './pins.ts';
import { additionLockEntry, installedSkillNames, readExposure, readSkillLock, readSkillLockEvidence, skillLockPath, skillExposure } from './store.ts';
import { hasVerifiedAdoption } from './upstream.ts';
import { verifyPinned } from './verify.ts';

const STORE_UNREADABLE = 'store unreadable';

// What the machine holds for the skills domain: declared skills, installed-but-undeclared ones,
// and a per-agent item for each installed skill an agent cannot load. A pinned skill whose lock
// records another ref (or none) is `off-pin`; an unpinned skill's recorded ref is ignored.
export const inspectSkills = (desired: DesiredConfig): Effect.Effect<
  { items: Observed[]; probeErrors: string[] },
  never,
  Fs | MachinePaths | FileIntegrity
> => Effect.gen(function* () {
  const store = (yield* MachinePaths).agentsSkills;
  const lock = yield* readSkillLock;
  const listed = yield* Effect.result(installedSkillNames);
  const probeErrors: string[] = [];
  let installed: string[] = [];
  if (listed._tag === 'Success') installed = listed.success;
  else probeErrors.push(`could not read ${store}: check skill store access and permissions`);
  const present = new Set(installed);

  const items: Observed[] = [];
  const declared = new Set<string>();
  const okSkills: { name: string; source: string }[] = [];
  for (const skill of desired.skills) {
    declared.add(skill.name);
    const base = { key: `skill:${skill.name}`, domain: 'skills', label: skill.name, group: skill.source, from: skill.from } as const;
    // An unlistable store says nothing about what is installed; reading it as missing would reinstall everything.
    if (listed._tag === 'Failure') {
      items.push({ ...base, state: 'unknown', disposition: 'blocked', note: STORE_UNREADABLE });
    } else if (!skill.install && skill.from.layer === 'machine') {
      const ownership = yield* checkSkillOwnership(desired, skill.name);
      items.push(ownership.kind === 'blocked'
        ? { ...base, state: 'disabled', disposition: 'blocked', note: ownership.reason }
        : ownership.kind === 'owned'
          ? { ...base, state: 'disabled', disposition: 'apply', note: 'disable pending' }
          : { ...base, state: 'missing', disposition: 'excluded', note: 'disabled on this machine' });
    } else if (present.has(skill.name)) {
      okSkills.push({ name: skill.name, source: skill.source });
      const recorded = lockRef(skill.targets ? additionLockEntry(lock, skill.name)?.meta : lock.skills[skill.name]);
      if (skill.pin && recorded !== skill.pin.ref) {
        items.push({ ...base, state: 'off-pin', disposition: 'apply', note: offPinNote(recorded, skill.pin.ref) });
      } else {
        items.push({ ...base, state: 'ok', disposition: 'in-sync' });
      }
    } else if (skill.install) {
      items.push({ ...base, state: 'missing', disposition: 'apply' });
    } else {
      items.push({ ...base, state: 'missing', disposition: 'excluded', note: skill.optional ? 'optional' : 'not chosen for this machine' });
    }
  }

  for (const name of installed) {
    if (declared.has(name)) continue;
    const source = sourceOf(lock.skills[name]);
    const base = { key: `skill:${name}`, domain: 'skills', label: name } as const;
    items.push(source
      ? { ...base, group: source, state: 'extra', disposition: 'undeclared', note: 'not in the manifest' }
      : { ...base, group: '', state: 'local', disposition: 'excluded', note: 'authored locally' });
  }

  if (okSkills.length > 0) {
    const exposure = yield* readExposure(TARGETS);
    probeErrors.push(...exposure.errors);
    // An agent whose directory could not be read has no list; it is a probe error, never "sees nothing".
    const readable = TARGETS.filter((t) => exposure.list[t] !== undefined);
    const { partial, missing } = skillExposure({ names: okSkills.map((s) => s.name), targets: readable, list: exposure.list });
    const lacking = new Map<string, ReadonlyArray<string>>([
      ...partial.map((p) => [p.name, p.missing] as const),
      ...missing.map((name) => [name, readable] as const),
    ]);
    for (const { name, source } of okSkills) {
      for (const target of TARGETS) {
        if (!lacking.get(name)?.includes(target) || !(desired.skills.find(s => s.name === name)?.targets ?? TARGETS).includes(target)) continue;
        items.push({
          key: `skill-link:${target}:${name}`, domain: 'skills', target, label: name, group: source,
          state: 'unlinked', disposition: 'apply', note: `not loadable by ${SKILL_AGENTS[target]}`,
        });
      }
    }
  }
  return { items, probeErrors };
});

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (names: Iterable<string>) => [...new Set(names)].sort(byCodePoint);
const touchesOf = (names: Iterable<string>) => sortedUnique(names).map((n) => `skills/${n}`);
// Skills step keys; an install step's key is `install` followed by its installer source, `o/r#<sha>` when pinned.
export const SKILL_STEP = {
  disable: 'skills:disable:', remove: 'skills:remove', update: 'skills:update', install: 'skills:install:', expose: 'skills:expose', manifest: 'skills:manifest',
} as const;

// The skill names a skills step acts on, read back from its `skills/<name>` touches.
export const skillNamesOf = (step: Step): string[] =>
  step.touches.filter((t) => t.startsWith('skills/')).map((t) => t.slice('skills/'.length));

// One install step per source, sources in code-point order; a pinned source installs at its pin.
const installSteps = (items: ReadonlyArray<Observed>, targets: ReadonlyArray<Target>, pins: ReadonlyMap<string, string>): Step[] => {
  const bySource = new Map<string, string[]>();
  for (const item of items) bySource.set(item.group, [...(bySource.get(item.group) ?? []), item.label]);
  return [...bySource.keys()].sort(byCodePoint).map((source) => {
    const touches = touchesOf(bySource.get(source)!);
    return {
      key: `${SKILL_STEP.install}${pinnedSource(source, pins.get(source))}`, domain: 'skills', action: 'install-skills',
      summary: `installing ${touches.length} skill(s) from ${source}`, touches, interruptible: true, targets,
    };
  });
};

const applySteps = (items: ReadonlyArray<Observed>, selection: Selection, pins: ReadonlyMap<string, string>) => {
  if (selection.declined.includes('skills')) {
    return { steps: [], skipped: items.filter((i) => i.disposition === 'apply').map((i) => ({ key: i.key, reason: 'skills declined' })) };
  }
  const wanted = items.filter((i) => ((i.state === 'missing' || i.state === 'off-pin') && i.disposition === 'apply')
    || (i.state === 'unlinked' && i.target !== undefined && selection.targets.includes(i.target)));
  const skipped: Skipped[] = [
    ...items.filter((i) => i.state === 'missing' && i.disposition === 'excluded').map((i) => ({ key: i.key, reason: 'optional, not chosen' })),
    ...items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: i.note ?? STORE_UNREADABLE })),
  ];
  const disables: Step[] = items.filter(i => i.state === 'disabled' && i.disposition === 'apply')
    .sort((a, b) => byCodePoint(a.label, b.label)).map(i => ({
      key: `${SKILL_STEP.disable}${i.label}`, domain: 'skills', action: 'remove',
      summary: `disabling ${i.label} on this machine`, touches: touchesOf([i.label]), interruptible: false,
    }));
  return { steps: [...disables, ...installSteps(wanted, selection.targets, pins)], skipped };
};

// Prune, refresh, adopt or move to a pin, then re-expose; the manifest is rewritten only when the skill set changed.
// An off-pin skill is reinstalled with `add`: `update` reinstalls at the lock's recorded ref, never at a new pin,
// and an unpinned off-pin skill's ref-less `add` installs upstream latest and drops the recorded ref.
const updateSteps = (items: ReadonlyArray<Observed>, selection: Selection, pins: ReadonlyMap<string, string>) => {
  if (selection.declined.includes('skills')) return { steps: [], skipped: items.map(i => ({ key: i.key, reason: 'skills declined' })) };
  const named = (state: string) => items.filter((i) => i.state === state).map((i) => i.label);
  const gone = named('gone');
  const outdated = named('outdated');
  const steps: Step[] = [];
  if (gone.length) {
    const touches = touchesOf(gone);
    steps.push({ key: SKILL_STEP.remove, domain: 'skills', action: 'remove', summary: `removing ${touches.length} skill(s)`, touches, interruptible: true });
  }
  if (outdated.length) {
    const touches = touchesOf(outdated);
    steps.push({ key: SKILL_STEP.update, domain: 'skills', action: 'update-skills', summary: `updating ${touches.length} skill(s)`, touches, interruptible: true });
  }
  const adopted = items.filter((i) => i.state === 'available');
  steps.push(...installSteps([...adopted, ...items.filter((i) => i.state === 'off-pin')], selection.targets, pins));
  if (steps.length) {
    steps.push({
      key: SKILL_STEP.expose, domain: 'skills', action: 'install-skills',
      summary: `re-exposing skills to ${selection.targets.map((t) => SKILL_AGENTS[t]).join(', ')}`,
      touches: touchesOf(outdated), interruptible: true, targets: selection.targets,
    });
  }
  if (gone.length || adopted.length) {
    steps.push({
      key: SKILL_STEP.manifest, domain: 'skills', action: 'write-manifest', summary: `write ${MANIFEST_FILE}`,
      touches: [MANIFEST_FILE], interruptible: false,
    });
  }
  const skipped = items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: 'source unreachable' }));
  return { steps, skipped };
};

const skillSteps = (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind, desired: DesiredConfig) => {
  const additions = new Set(desired.skills.filter(s => s.targets !== undefined).map(s => s.name));
  const disabled = new Set(desired.skills.filter(s => !s.install && s.from.layer === 'machine').map(s => s.name));
  const active = items.filter(i => !disabled.has(i.label) || kind === 'apply' && i.state === 'disabled');
  const blocked = active.filter(i => !disabled.has(i.label) && additions.has(i.label) && (kind === 'update' || i.disposition === 'apply'));
  const legacy = active.filter(i => disabled.has(i.label) || !additions.has(i.label));
  const result = kind === 'apply' ? applySteps(legacy, selection, pinsBySource(desired))
    : kind === 'update' ? updateSteps(legacy, selection, pinsBySource(desired)) : { steps: [], skipped: [] };
  return { ...result, skipped: [...result.skipped, ...items.filter(i => !active.includes(i)).map(i => ({ key: i.key, reason: 'disabled on this machine' })), ...blocked.map(i => ({ key: i.key,
    reason: 'Resolve and preview this skill addition to repair or update it with native verification' }))] };
};

// Copies each named store folder to the run's backups before the installer touches it.
const preserveAll = (names: ReadonlyArray<string>) => Effect.gen(function* () {
  const paths = yield* MachinePaths;
  const backups = yield* Backups;
  yield* backups.preserve(skillLockPath(paths), 'skill-lock.json');
  for (const name of names) {
    yield* backups.preserve(join(paths.agentsSkills, name), join('skills', name));
    for (const target of TARGETS) yield* backups.preserve(join(paths[target], 'skills', name), join(target, 'skills', name));
  }
});

// Adds `names` from `installSource` and says which the add wrote (`landed`) and which `source` lacks (`missing`).
// The installer exits 1 naming every requested skill only when none match; when some match it exits 0 and skips
// the rest. So after a successful add, a requested skill whose lock entry the add did not write is one the source
// lacks. A successful add that wrote no requested entry leaves the lock without evidence: then all count as landed.
const addSkills = (source: string, installSource: string, names: ReadonlyArray<string>, targets: ReadonlyArray<Target>, pin?: string) =>
  Effect.gen(function* () {
    const before = (yield* readSkillLock).skills;
    const ran = yield* runInstaller(addCommand({ source: installSource, skills: names, targets }), source, pin);
    if (!ran.ok) return { ok: false, note: ran.note ?? '', landed: [] as string[], missing: names.filter((n) => ran.missing?.includes(n)) };
    const after = (yield* readSkillLock).skills;
    const landed = names.filter((n) => after[n] !== undefined && JSON.stringify(after[n]) !== JSON.stringify(before[n]));
    if (!landed.length) return { ok: true, note: ran.note ?? '', landed: [...names], missing: [] as string[] };
    return { ok: true, note: ran.note ?? '', landed, missing: names.filter((n) => !landed.includes(n)) };
  });

// Installs at a pin, then verifies the install against the commit: the installer may resolve the sha as a
// branch or tag of that name. A mismatch is removed again; the backup taken first keeps the previous version.
// `review` names the bundled scripts of a verified install. When the installer fails, the skills whose lock now
// records the sha are still verified (it may have written them) and a mismatch removed; the rest are left alone.
// A skill the pinned commit lacks fails the step by name and is never verified; the others still install.
const installPinned = (source: string, sha: string, names: ReadonlyArray<string>, targets: ReadonlyArray<Target>, scopedRemoval = false) =>
  Effect.gen(function* () {
    yield* preserveAll(names);
    const added = yield* addSkills(source, pinnedSource(source, sha), names, targets, sha);
    const lock = yield* readSkillLock;
    const written = added.ok ? added.landed : names.filter((n) => !added.missing.includes(n) && lockRef(lock.skills[n]) === sha);
    const { failed, scripts } = yield* verifyPinned({ source, sha, names: written });
    let removal = '';
    if (failed.size > 0) {
      const bad = sortedUnique(failed.keys());
      const removed = yield* runInstaller(removeCommand(bad, scopedRemoval ? targets : undefined));
      const problems = bad.map((n) => failed.get(n)![0]).join('; ');
      removal = `${removed.ok ? 'removed' : 'could not remove'} ${bad.join(', ')}: does not match ${short(sha)} (${problems})`;
    }
    if (!added.ok) return { ok: false, note: removal ? `${added.note}; ${removal}` : added.note };
    const gone = added.missing.length ? missingSkillsNote(source, added.missing, sha) : '';
    if (removal) return { ok: false, note: gone ? `${gone} ${removal}` : removal };
    const review = scripts.size > 0
      ? `bundles scripts, review: ${sortedUnique(scripts.keys()).map((n) => `${n} (${scripts.get(n)!.join(', ')})`).join('; ')}`
      : '';
    if (gone) return { ok: false, note: `${gone} Verified ${written.length} other skill(s) at ${short(sha)}.${review ? ` Review: ${review}` : ''}`, review };
    const verified = `verified ${names.length} skill(s) at ${short(sha)}`;
    return { ok: true, note: review ? `${verified}; ${review}` : verified, review };
  });

// Adds skills at their source's upstream latest. The add replaces any installed folder, so each is backed up
// first, as installPinned does for a pinned add. A skill the source no longer has fails the step by name.
const addUnpinned = (source: string, skills: ReadonlyArray<string>, targets: ReadonlyArray<Target>) =>
  Effect.gen(function* () {
    yield* preserveAll(skills);
    const added = yield* addSkills(source, source, skills, targets);
    if (!added.ok || !added.missing.length) return { ok: added.ok, note: added.note };
    return { ok: false, note: `${missingSkillsNote(source, added.missing)} Installed ${added.landed.length} other skill(s).` };
  });

// Re-adds every scoped skill a readable target cannot load, at its source's pin when it has one.
// An unreadable target is reported, never repaired.
const reExpose = (step: Step, report: MachineReport, scopedRemoval = false) => Effect.gen(function* () {
  const installed = new Set(yield* installedSkillNames);
  const additions = new Set(report.desired.skills.filter(s => s.targets !== undefined).map(s => s.name));
  const disabled = new Set(report.desired.skills.filter(s => !s.install && s.from.layer === 'machine').map(s => s.name));
  const scope = sortedUnique(scopedRemoval ? skillNamesOf(step) : [...report.desired.skills.map(s => s.name),...skillNamesOf(step)])
    .filter(n => installed.has(n) && !additions.has(n) && !disabled.has(n));
  const lock = yield* readSkillLock;
  const pins = pinsBySource(report.desired);
  const exposure = yield* readExposure(step.targets ?? TARGETS);
  const readable = (step.targets ?? TARGETS).filter((t) => exposure.list[t] !== undefined);
  const bySource = new Map<string, string[]>();
  for (const name of scope) {
    const source = sourceOf(lock.skills[name]);
    if (!source || readable.every(t => exposure.list[t]!.includes(name))) continue;
    bySource.set(source, [...(bySource.get(source) ?? []), name]);
  }
  let ok = true;
  let count = 0;
  const failures: string[] = [];
  const reviews: string[] = [];
  for (const source of [...bySource.keys()].sort(byCodePoint)) {
    const skills = bySource.get(source)!;
    const sha = pins.get(source);
    const result: { ok: boolean; note?: string; review?: string } = sha
      ? yield* installPinned(source, sha, skills, readable, scopedRemoval)
      : yield* addUnpinned(source, skills, readable);
    if (result.ok) {
      count += skills.length;
      if (result.review) reviews.push(`${source}: ${result.review}`);
    } else {
      ok = false;
      failures.push(`${source}: ${result.note}`);
    }
  }
  const parts = [
    ...(count > 0 ? [`re-exposed ${count} skill(s) to ${readable.map((t) => SKILL_AGENTS[t]).join(', ')}`] : []),
    ...reviews,
    ...failures,
    ...exposure.errors,
  ];
  return { ok, note: parts.join('; ') };
});

// Legacy direct-domain regeneration retains the shrink guard; explicit author updates use the bound owner.
const writeManifest = (report: MachineReport) => Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const { lock } = yield* readSkillLockEvidence;
  const installed = yield* installedSkillNames;
  const present = new Set(installed);
  const personal = new Set(report.desired.skills.filter(s => s.declaredFrom?.layer === 'machine').map(s => s.name));
  const before = groupsOf(report.desired.skills.filter(s => !personal.has(s.name)));
  const pruned = report.items.filter((i) => i.domain === 'skills' && i.state === 'gone' && !present.has(i.label)).map((i) => i.label);
  const groups = updateManifestGroups({ desired: report.desired.skills, lock, installed, prunedNames: pruned });
  const outcome = manifestOutcome({ before, groups, prunedNames: pruned });
  if (!outcome.write) return { ok: true, note: `left alone — ${outcome.reason}` };
  const target = join(paths.repo, MANIFEST_FILE);
  yield* (yield* Backups).preserve(target, join('author', MANIFEST_FILE));
  yield* fs.writeTextAtomic(target, emitManifest(groups));
  return { ok: true, note: `written — ${outcome.reason}` };
});

const runSkillStep = (step: Step, report: MachineReport, scopedTargets?: readonly Target[]): Effect.Effect<StepResult, unknown, Fs | MachinePaths | Processes | Backups | FileIntegrity> =>
  Effect.gen(function* () {
    const names = skillNamesOf(step);
    switch (step.action) {
      case 'remove':
        if (step.key.startsWith(SKILL_STEP.disable) && names.length === 1) return yield* disableOwnedSkill(report.desired, names[0]!);
        yield* preserveAll(names);
        {
          const removed = yield* runInstaller(removeCommand(names, scopedTargets));
          if (scopedTargets && removed.ok) {
            const installed = yield* installedSkillNames;
            if (names.some(name => installed.includes(name))) return { ok: false, note: 'Selected exposure removal ran; another native agent may retain shared content and lock metadata. Global pruning is incomplete' };
          }
          return removed;
        }
      case 'update-skills':
        if (scopedTargets) {
          const { lock } = yield* readSkillLockEvidence;
          const bySource = new Map<string,string[]>();
          for (const name of names) {
            const entry = additionLockEntry(lock,name); const source = sourceOf(lock.skills[name]);
            if (!entry || entry.selectorName !== name || !source || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(source)) return { ok: false, note: 'Exact legacy source and native selector evidence is required; resolve and preview this skill addition' };
            bySource.set(source,[...(bySource.get(source) ?? []),name]);
          }
          let ok = true;
          for (const [source,skills] of bySource) { const result = yield* addUnpinned(source,skills,scopedTargets); ok = ok && result.ok; }
          return { ok };
        }
        yield* preserveAll(names);
        return yield* runInstaller(updateCommand(names));
      case 'install-skills':
        if (step.key === SKILL_STEP.expose) return yield* reExpose(step, report, scopedTargets !== undefined);
        if (step.key.startsWith(SKILL_STEP.install)) {
          const source = step.key.slice(SKILL_STEP.install.length);
          const targets = step.targets ?? TARGETS;
          const pinned = splitPinned(source);
          if (pinned.sha) {
            const { ok, note } = yield* installPinned(pinned.source, pinned.sha, names, targets, scopedTargets !== undefined);
            return { ok, note };
          }
          // A ref-less `add` also reinstalls an off-pin skill, replacing its folder.
          return yield* addUnpinned(source, names, targets);
        }
        break;
      case 'write-manifest':
        return yield* writeManifest(report);
    }
    return { ok: false, note: `skills cannot run ${step.action}` };
  });

export const skillsDomain: Domain<Fs | MachinePaths | Processes | Backups | FileIntegrity> = {
  name: 'skills',
  inspect: inspectSkills,
  steps: skillSteps,
  run: runSkillStep,
};

// A selected shared update uses the same owners with explicit native exposure targets and no snapshot write.
export const skillsUpdateDomain = (targets: readonly Target[]): typeof skillsDomain => ({
  ...skillsDomain,
  steps: (items, selection, kind, desired) => { const result = skillSteps(items,selection,kind,desired); return { ...result, steps: result.steps.filter(step => step.key !== SKILL_STEP.manifest) }; },
  run: (step,report) => {
    if (step.key.startsWith(SKILL_STEP.install) && skillNamesOf(step).some(name => report.items.some(item => item.label === name && item.state === 'available' && !hasVerifiedAdoption(item))))
      return Effect.succeed({ ok:false,note:'Exact native metadata is unavailable; resolveSkillCandidate, previewChange(addSkill), then applyChange' });
    return runSkillStep(step,report,targets);
  },
});
