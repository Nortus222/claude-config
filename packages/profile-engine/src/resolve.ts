import type {
  BaseProfile, DesiredConfig, FileEntry, Input, Issue, MachineOverrides, Origin, Pins, ResolvedFile,
} from './model.ts';
import { issue } from './issues.ts';
import { FILES_SOURCE } from './files.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { INTEGRATIONS_SOURCE } from './integrations.ts';
import { PINS_SOURCE } from './pins.ts';
import { nestedSecretComplaints } from './secrets.ts';
import { normalizeSkillSource } from './overrides.ts';
import { resolveSkillAdditions } from './skill-additions.ts';

// Per-item decisions made by the profile chain, before pins and machine choices.
export type ProfileLayers = {
  readonly files: ReadonlyMap<string, { readonly managed: boolean; readonly from: Origin }>;
  readonly skills: ReadonlyMap<string, { readonly install: boolean; readonly from: Origin }>;
  readonly integrations: ReadonlyMap<string, Origin>;
};

type ResolveInput = {
  readonly base: BaseProfile;
  readonly pins?: Input<Pins>;
  readonly overrides?: Input<MachineOverrides>;
  readonly layers?: ProfileLayers;
  readonly declaredSources?: readonly string[];
};

// Layers pins and machine overrides over the base profile and records which layer decided every
// value. Explicit machine skill declarations extend the skill list; other overrides still only
// select declarations and owned settings from the base profile.
export function resolveProfile({
  base,
  pins = { value: {}, source: PINS_SOURCE, issues: [] },
  overrides = { value: {}, source: 'overrides', issues: [] },
  layers,
  declaredSources = [],
}: ResolveInput): DesiredConfig {
  const issues: Issue[] = [...base.issues, ...pins.issues, ...overrides.issues];
  const chosen = overrides.value;
  const machine: Origin = { layer: 'machine', source: overrides.source };
  const complain = (path: string, message: string) => issues.push(issue('machine', overrides.source, path, message));

  for (const fileId of Object.keys(chosen.settings ?? {})) {
    if (!base.files.some((f) => f.id === fileId && f.mode === 'merge-keys')) {
      complain(`settings.${fileId}`, `'${fileId}' is not a settings document the profile declares`);
    }
  }
  const files = base.files.map((file) => resolveFile(file, base, chosen, machine, complain, layers?.files.get(file.id)));

  const additions = chosen.skillAdditions ?? [];
  const declaredSkills = new Set([...base.skills.flatMap((g) => g.skills), ...additions.map(a => a.name)]);
  for (const name of Object.keys(chosen.skills ?? {})) {
    if (!declaredSkills.has(name)) complain(`skills.${name}`, `skill '${name}' is not in the skills manifest`);
  }
  const sourceKey = (source: string) => additions.length ? normalizeSkillSource(source) ?? source : source;
  const sources = new Set([...base.skills.map((g) => sourceKey(g.source)), ...additions.map(a => sourceKey(a.source)), ...declaredSources.map(sourceKey)]);
  for (const source of Object.keys(pins.value)) {
    if (!sources.has(sourceKey(source))) {
      issues.push(issue('pin', pins.source, `pins.${source}`, `source '${source}' is not in the skills manifest`));
    }
  }
  const pinOrigin: Origin = { layer: 'pin', source: pins.source };
  const inheritedSkills = base.skills.flatMap((group) =>
    group.skills.map((name) => {
      const choice = own(chosen.skills, name);
      const ref = own(pins.value, group.source);
      const layer = layers?.skills.get(`${group.source}/${name}`);
      return {
        name,
        source: group.source,
        exact: group.exact,
        optional: group.optional,
        install: choice ?? layer?.install ?? !group.optional,
        from: choice === undefined ? layer?.from ?? { layer: 'base' as const, source: SKILLS_SOURCE } : machine,
        ...(layer === undefined ? {} : { declaredFrom: layer.from }),
        ...(ref === undefined ? {} : { pin: { ref, from: pinOrigin } }),
      };
    }),
  );

  const skills = additions.length
    ? resolveSkillAdditions(inheritedSkills, additions, chosen.skills, pins, machine, issues) : inheritedSkills;

  const declaredIntegrations = new Set(base.integrations.map((i) => i.id));
  for (const id of Object.keys(chosen.integrations ?? {})) {
    if (!declaredIntegrations.has(id)) complain(`integrations.${id}`, `integration '${id}' is not declared`);
  }
  const integrations = base.integrations.map((declaration) => {
    const choice = own(chosen.integrations, declaration.id);
    return {
      id: declaration.id,
      declaration,
      enabled: choice ?? declaration.default,
      from: choice === undefined ? layers?.integrations.get(declaration.id) ?? { layer: 'base' as const, source: INTEGRATIONS_SOURCE } : machine,
    };
  });

  return { files, skills, integrations, allow: base.allow, issues };
}

// Reads an own property only, so names like 'constructor' never resolve to inherited members.
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function resolveFile(
  file: FileEntry,
  base: BaseProfile,
  chosen: MachineOverrides,
  machine: Origin,
  complain: (path: string, message: string) => void,
  layer?: { readonly managed: boolean; readonly from: Origin },
): ResolvedFile {
  const decided = chosen.manageConfig !== undefined || chosen.configTargets !== undefined;
  const managed = layer?.managed !== false && chosen.manageConfig !== false && (chosen.configTargets?.includes(file.target) ?? true);
  const resolved: ResolvedFile = { ...file, managed, from: decided ? machine : layer?.from ?? { layer: 'base', source: FILES_SOURCE } };
  if (file.mode !== 'merge-keys') return resolved;

  const owned = base.settings[file.id];
  const keys: Record<string, { value: unknown; from: Origin }> = {};
  for (const [key, value] of Object.entries(owned ?? {})) keys[key] = { value, from: layer?.from ?? { layer: 'base', source: file.src } };

  for (const [key, value] of Object.entries(chosen.settings?.[file.id] ?? {})) {
    const path = `settings.${file.id}.${key}`;
    if (!owned || !Object.hasOwn(owned, key)) {
      complain(path, `key '${key}' is not owned by ${file.src}; an override can only replace an owned key's value`);
      continue;
    }
    const secrets = nestedSecretComplaints({ [key]: value }, '');
    if (secrets.length) {
      for (const message of secrets) complain(path, message);
      continue;
    }
    keys[key] = { value, from: machine };
  }
  return { ...resolved, keys };
}
