import type {
  BaseProfile, DesiredConfig, FileEntry, Input, Issue, MachineOverrides, Origin, Pins, ResolvedFile,
} from './model.ts';
import { issue } from './issues.ts';
import { FILES_SOURCE } from './files.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { INTEGRATIONS_SOURCE } from './integrations.ts';
import { PINS_SOURCE } from './pins.ts';
import { nestedSecretComplaints } from './secrets.ts';

type ResolveInput = {
  readonly base: BaseProfile;
  readonly pins?: Input<Pins>;
  readonly overrides?: Input<MachineOverrides>;
};

// Layers pins and machine overrides over the base profile and records which layer decided every
// value. Pure. An override or pin naming something the base does not declare becomes an issue and
// changes nothing, so the base profile stays the only list of what may be managed.
export function resolveProfile({
  base,
  pins = { value: {}, source: PINS_SOURCE, issues: [] },
  overrides = { value: {}, source: 'overrides', issues: [] },
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
  const files = base.files.map((file) => resolveFile(file, base, chosen, machine, complain));

  const declaredSkills = new Set(base.skills.flatMap((g) => g.skills));
  for (const name of Object.keys(chosen.skills ?? {})) {
    if (!declaredSkills.has(name)) complain(`skills.${name}`, `skill '${name}' is not in the skills manifest`);
  }
  const declaredSources = new Set(base.skills.map((g) => g.source));
  for (const source of Object.keys(pins.value)) {
    if (!declaredSources.has(source)) {
      issues.push(issue('pin', pins.source, `pins.${source}`, `source '${source}' is not in the skills manifest`));
    }
  }
  const pinOrigin: Origin = { layer: 'pin', source: pins.source };
  const skills = base.skills.flatMap((group) =>
    group.skills.map((name) => {
      const choice = own(chosen.skills, name);
      const ref = own(pins.value, group.source);
      return {
        name,
        source: group.source,
        exact: group.exact,
        optional: group.optional,
        install: choice ?? !group.optional,
        from: choice === undefined ? { layer: 'base' as const, source: SKILLS_SOURCE } : machine,
        ...(ref === undefined ? {} : { pin: { ref, from: pinOrigin } }),
      };
    }),
  );

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
      from: choice === undefined ? { layer: 'base' as const, source: INTEGRATIONS_SOURCE } : machine,
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
): ResolvedFile {
  const decided = chosen.manageConfig !== undefined || chosen.configTargets !== undefined;
  const managed = chosen.manageConfig !== false && (chosen.configTargets?.includes(file.target) ?? true);
  const resolved: ResolvedFile = { ...file, managed, from: decided ? machine : { layer: 'base', source: FILES_SOURCE } };
  if (file.mode !== 'merge-keys') return resolved;

  const owned = base.settings[file.id];
  const keys: Record<string, { value: unknown; from: Origin }> = {};
  for (const [key, value] of Object.entries(owned ?? {})) keys[key] = { value, from: { layer: 'base', source: file.src } };

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
