import { Effect } from 'effect';
import { TARGETS, type DesiredConfig } from '@nortuscc/profile-engine';
import type { Observed } from '../model.ts';
import { Fs } from '../fs.ts';
import { MachinePaths } from '../paths.ts';
import { SKILL_AGENTS } from './installer.ts';
import { sourceOf } from './manifest.ts';
import { installedSkillNames, readExposure, readSkillLock, skillExposure } from './store.ts';

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
    if (present.has(skill.name)) {
      okSkills.push({ name: skill.name, source: skill.source });
      items.push({ ...base, state: 'ok', disposition: 'in-sync' });
    } else if (skill.install) {
      items.push({ ...base, state: 'missing', disposition: 'apply' });
    } else {
      items.push({ ...base, state: 'missing', disposition: 'excluded', note: 'optional' });
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
