import { TARGETS, type Input, type Issue, type Origin, type Pins, type ResolvedSkill, type SkillAddition } from './model.ts';
import { normalizeSkillSource } from './overrides.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { issue } from './issues.ts';

const identity = (source: string) => normalizeSkillSource(source) ?? source;

// Adds explicit machine declarations, retaining base provenance and source-wide revision policy.
export function resolveSkillAdditions(
  inherited: ReadonlyArray<ResolvedSkill>, additions: ReadonlyArray<SkillAddition>,
  choices: Readonly<Record<string, boolean>> | undefined, pins: Input<Pins>, machine: Origin, issues: Issue[],
): ResolvedSkill[] {
  const complain = (path: string, message: string) => issues.push(issue('machine', machine.source, path, message));
  const refs = new Map<string, { ref: string; from: Origin }>();
  for (const [source, ref] of Object.entries(pins.value)) {
    const key = identity(source);
    if (refs.has(key) && refs.get(key)!.ref !== ref) complain('skillAdditions', 'conflicting source revisions in profile pins');
    else refs.set(key, { ref, from: { layer: 'pin', source: pins.source } });
  }
  const baseSources = new Set(inherited.map(skill => identity(skill.source)));
  const declarations = new Map<string, SkillAddition>();
  const names = new Map<string, string>();
  for (const skill of inherited) names.set(skill.name, identity(skill.source));
  for (const addition of additions) {
    const source = identity(addition.source);
    const path = `skillAdditions.${addition.name}`;
    const existingSource = names.get(addition.name);
    if ((existingSource !== undefined && existingSource !== source)
      || inherited.some(skill => skill.name === addition.name && identity(skill.source) !== source)) {
      complain(path, `skill '${addition.name}' has conflicting sources`);
      continue;
    }
    names.set(addition.name, source);
    const key = `${source}/${addition.name}`;
    const previous = declarations.get(key);
    if (addition.revision !== undefined) {
      const pin = refs.get(source);
      if ((pin && pin.ref !== addition.revision) || (!pin && baseSources.has(source))) {
        complain(path, 'revision conflicts with the inherited source revision policy');
      } else if (!pin) refs.set(source, { ref: addition.revision, from: machine });
    }
    declarations.set(key, { ...addition, source,
      targets: TARGETS.filter(target => addition.targets.includes(target) || previous?.targets.includes(target)) });
  }
  const skills: ResolvedSkill[] = [];
  const seen = new Set<string>();
  for (const skill of inherited) {
    const source = identity(skill.source);
    const key = `${source}/${skill.name}`;
    const addition = declarations.get(key);
    // Duplicate inherited entries retain legacy behavior unless this declaration touches them.
    if (addition && seen.has(key)) continue;
    seen.add(key);
    const pin = refs.get(source);
    skills.push({ ...skill, ...(pin ? { pin } : {}), ...(addition ? {
      targets: addition.targets, declaredFrom: skill.declaredFrom ?? { layer: 'base', source: SKILLS_SOURCE } as const,
      install: choices && Object.hasOwn(choices, skill.name) ? choices[skill.name]! : true, from: machine,
    } : {}) });
  }
  for (const [key, addition] of declarations) {
    if (seen.has(key)) continue;
    const choice = choices && Object.hasOwn(choices, addition.name) ? choices[addition.name] : undefined;
    const pin = refs.get(addition.source);
    skills.push({ name: addition.name, source: addition.source, exact: true, optional: false,
      install: choice ?? true, from: machine, declaredFrom: machine, targets: addition.targets,
      ...(pin ? { pin } : {}) });
  }
  return skills;
}
