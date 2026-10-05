import { join } from 'node:path';
import { Effect } from 'effect';
import { TARGETS, type DesiredConfig, type Target } from '@nortuscc/profile-engine';
import { Backups } from '../backups.ts';
import type { Domain, MachineReport, Observed, PlanKind, Selection, Skipped, Step, StepResult } from '../model.ts';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import type { Processes } from '../processes.ts';
import { SKILL_AGENTS, addCommand, removeCommand, runInstaller, updateCommand } from './installer.ts';
import { MANIFEST_FILE, emitManifest, groupsOf, installedGroups, manifestOutcome, sourceOf } from './manifest.ts';
import { installedSkillNames, readExposure, readSkillLock, skillExposure } from './store.ts';

const STORE_UNREADABLE = 'store unreadable';

// What the machine holds for the skills domain: declared skills, installed-but-undeclared ones,
// and a per-agent item for each installed skill an agent cannot load.
export const inspectSkills = (desired: DesiredConfig): Effect.Effect<
  { items: Observed[]; probeErrors: string[] },
  never,
  Fs | MachinePaths
> => Effect.gen(function* () {
  const store = (yield* MachinePaths).agentsSkills;
  const lock = yield* readSkillLock;
  const listed = yield* Effect.result(installedSkillNames);
  const probeErrors: string[] = [];
  let installed: string[] = [];
  if (listed._tag === 'Success') installed = listed.success;
  else probeErrors.push(`could not read ${store}: ${listed.failure.message}`);
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
    } else if (present.has(skill.name)) {
      okSkills.push({ name: skill.name, source: skill.source });
      items.push({ ...base, state: 'ok', disposition: 'in-sync' });
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
        if (!lacking.get(name)?.includes(target)) continue;
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
// Skills step keys; an install step's key is `install` followed by its source.
export const SKILL_STEP = {
  remove: 'skills:remove', update: 'skills:update', install: 'skills:install:', expose: 'skills:expose', manifest: 'skills:manifest',
} as const;

// The skill names a skills step acts on, read back from its `skills/<name>` touches.
export const skillNamesOf = (step: Step): string[] =>
  step.touches.filter((t) => t.startsWith('skills/')).map((t) => t.slice('skills/'.length));

// One install step per source, sources in code-point order.
const installSteps = (items: ReadonlyArray<Observed>, targets: ReadonlyArray<Target>): Step[] => {
  const bySource = new Map<string, string[]>();
  for (const item of items) bySource.set(item.group, [...(bySource.get(item.group) ?? []), item.label]);
  return [...bySource.keys()].sort(byCodePoint).map((source) => {
    const touches = touchesOf(bySource.get(source)!);
    return {
      key: `${SKILL_STEP.install}${source}`, domain: 'skills', action: 'install-skills',
      summary: `installing ${touches.length} skill(s) from ${source}`, touches, interruptible: true, targets,
    };
  });
};

const applySteps = (items: ReadonlyArray<Observed>, selection: Selection) => {
  if (selection.declined.includes('skills')) {
    return { steps: [], skipped: items.filter((i) => i.disposition === 'apply').map((i) => ({ key: i.key, reason: 'skills declined' })) };
  }
  const wanted = items.filter((i) => (i.state === 'missing' && i.disposition === 'apply')
    || (i.state === 'unlinked' && i.target !== undefined && selection.targets.includes(i.target)));
  const skipped: Skipped[] = [
    ...items.filter((i) => i.state === 'missing' && i.disposition === 'excluded').map((i) => ({ key: i.key, reason: 'optional, not chosen' })),
    ...items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: STORE_UNREADABLE })),
  ];
  return { steps: installSteps(wanted, selection.targets), skipped };
};

// Prune, refresh, adopt, then re-expose; the manifest is rewritten only when the skill set changed.
const updateSteps = (items: ReadonlyArray<Observed>, selection: Selection) => {
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
  const installs = installSteps(items.filter((i) => i.state === 'available'), selection.targets);
  steps.push(...installs);
  if (steps.length) {
    steps.push({
      key: SKILL_STEP.expose, domain: 'skills', action: 'install-skills',
      summary: `re-exposing skills to ${selection.targets.map((t) => SKILL_AGENTS[t]).join(', ')}`,
      touches: touchesOf(outdated), interruptible: true, targets: selection.targets,
    });
  }
  if (gone.length || installs.length) {
    steps.push({
      key: SKILL_STEP.manifest, domain: 'skills', action: 'write-manifest', summary: `write ${MANIFEST_FILE}`,
      touches: [MANIFEST_FILE], interruptible: false,
    });
  }
  const skipped = items.filter((i) => i.disposition === 'blocked').map((i) => ({ key: i.key, reason: 'source unreachable' }));
  return { steps, skipped };
};

const skillSteps = (items: ReadonlyArray<Observed>, selection: Selection, kind: PlanKind) =>
  kind === 'apply' ? applySteps(items, selection)
  : kind === 'update' ? updateSteps(items, selection)
  : { steps: [], skipped: [] };

// Copies each named store folder to the run's backups before the installer touches it.
const preserveAll = (names: ReadonlyArray<string>) => Effect.gen(function* () {
  const store = (yield* MachinePaths).agentsSkills;
  const backups = yield* Backups;
  for (const name of names) yield* backups.preserve(join(store, name), join('skills', name));
});

// Re-adds every scoped skill a readable target cannot load. An unreadable target is reported, never repaired.
const reExpose = (step: Step, report: MachineReport) => Effect.gen(function* () {
  const installed = new Set(yield* installedSkillNames);
  const scope = sortedUnique([...report.desired.skills.map((s) => s.name), ...skillNamesOf(step)]).filter((n) => installed.has(n));
  const lock = yield* readSkillLock;
  const exposure = yield* readExposure(step.targets ?? TARGETS);
  const readable = (step.targets ?? TARGETS).filter((t) => exposure.list[t] !== undefined);
  const bySource = new Map<string, string[]>();
  for (const name of scope) {
    const source = sourceOf(lock.skills[name]);
    if (!source || readable.every((t) => exposure.list[t]!.includes(name))) continue;
    bySource.set(source, [...(bySource.get(source) ?? []), name]);
  }
  let ok = true;
  let count = 0;
  const failures: string[] = [];
  for (const source of [...bySource.keys()].sort(byCodePoint)) {
    const skills = bySource.get(source)!;
    const result = yield* runInstaller(addCommand({ source, skills, targets: readable }));
    if (result.ok) count += skills.length;
    else {
      ok = false;
      failures.push(`${source}: ${result.note}`);
    }
  }
  const parts = [
    ...(count > 0 ? [`re-exposed ${count} skill(s) to ${readable.map((t) => SKILL_AGENTS[t]).join(', ')}`] : []),
    ...failures,
    ...exposure.errors,
  ];
  return { ok, note: parts.join('; ') };
});

// Regenerates the manifest from what is installed, behind the shrink guard. Writes only into `paths.repo`.
const writeManifest = (report: MachineReport) => Effect.gen(function* () {
  const fs = yield* Fs;
  const paths = yield* MachinePaths;
  const lock = yield* readSkillLock;
  const installed = yield* installedSkillNames;
  const present = new Set(installed);
  const before = groupsOf(report.desired.skills);
  const pruned = report.items.filter((i) => i.domain === 'skills' && i.state === 'gone' && !present.has(i.label)).map((i) => i.label);
  const declared = before
    .map((g) => (g.optional ? { ...g, skills: g.skills.filter((n) => !pruned.includes(n)) } : g))
    .filter((g) => g.skills.length > 0);
  const groups = installedGroups(lock, installed, declared);
  const outcome = manifestOutcome({ before, groups, prunedNames: pruned });
  if (!outcome.write) return { ok: true, note: `left alone — ${outcome.reason}` };
  yield* fs.writeTextAtomic(join(paths.repo, MANIFEST_FILE), emitManifest(groups));
  return { ok: true, note: `written — ${outcome.reason}` };
});

const runSkillStep = (step: Step, report: MachineReport): Effect.Effect<StepResult, unknown, Fs | MachinePaths | Processes | Backups> =>
  Effect.gen(function* () {
    const names = skillNamesOf(step);
    switch (step.action) {
      case 'remove':
        yield* preserveAll(names);
        return yield* runInstaller(removeCommand(names));
      case 'update-skills':
        yield* preserveAll(names);
        return yield* runInstaller(updateCommand(names));
      case 'install-skills':
        if (step.key === SKILL_STEP.expose) return yield* reExpose(step, report);
        if (step.key.startsWith(SKILL_STEP.install)) {
          return yield* runInstaller(addCommand({ source: step.key.slice(SKILL_STEP.install.length), skills: names, targets: step.targets ?? TARGETS }));
        }
        break;
      case 'write-manifest':
        return yield* writeManifest(report);
    }
    return { ok: false, note: `skills cannot run ${step.action}` };
  });

export const skillsDomain: Domain<Fs | MachinePaths | Processes | Backups> = {
  name: 'skills',
  inspect: inspectSkills,
  steps: skillSteps,
  run: runSkillStep,
};
