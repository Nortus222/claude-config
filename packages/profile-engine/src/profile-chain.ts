import type { BaseProfile, DesiredConfig, Input, Issue, MachineOverrides, Origin } from './model.ts';
import { buildBaseProfile } from './base.ts';
import { FILES } from './files.ts';
import { issue } from './issues.ts';
import { parsePins } from './pins.ts';
import { parseSettingsKeys } from './settings.ts';
import { resolveProfile, type ProfileLayers } from './resolve.ts';
import { isProfileName, parseProfileDocument, type ProfileDocument } from './profile-document.ts';

export const PROFILE_MAX_DEPTH = 8;
const profilePath = (name: string) => `profiles/${name}.json`;

// An explicit directory marker lets in-memory snapshots represent an empty profiles directory.
export function profileNames(documents: Readonly<Record<string, string>>): readonly string[] | undefined {
  const paths = Object.keys(documents);
  if (!paths.some(path => path === 'profiles' || path.startsWith('profiles/'))) return undefined;
  return paths.filter(path => /^profiles\/[^/]+\.json$/.test(path)).map(path => path.slice('profiles/'.length, -'.json'.length)).sort();
}

export function profileInventoryIssues(names: readonly string[]): Issue[] {
  if (!names.length) return [issue('profile', 'profiles/', '', 'profiles/ has no profiles')];
  return names.filter(name => !isProfileName(name)).map(name => issue('profile', profilePath(name), '', `invalid profile name '${name}'`));
}

function chainFor(
  profiles: ReadonlyMap<string, Input<ProfileDocument>>, name: string, issues: Issue[],
): readonly Input<ProfileDocument>[] {
  const chain: string[] = [];
  const layers: Input<ProfileDocument>[] = [];
  let current: string | undefined = name;
  while (current !== undefined) {
    const next = [...chain, current].join(' -> ');
    const problem = chain.includes(current) ? 'profile inheritance cycle'
      : chain.length >= PROFILE_MAX_DEPTH ? `profile inheritance exceeds ${PROFILE_MAX_DEPTH} profiles`
      : !profiles.has(current) ? 'missing profile' : undefined;
    if (problem) {
      issues.push(issue('profile', profilePath(name), 'extends', `${problem}: ${next}`));
      return [];
    }
    chain.push(current);
    const document: Input<ProfileDocument> = profiles.get(current)!;
    issues.push(...document.issues);
    layers.unshift(document);
    current = document.value.extends;
  }
  return layers;
}

function rootProfile(documents: Readonly<Record<string, string>>): BaseProfile {
  return buildBaseProfile({
    skillsManifest: documents['skills-manifest.txt'],
    integrations: documents['integrations.json'],
    settings: Object.fromEntries(FILES.filter(file => file.mode === 'merge-keys').map(file => [file.id, documents[file.src]])),
  }, path => Object.hasOwn(documents, path));
}

// Resolves a single-parent chain, then shared source pins and machine choices. Errors are issues.
export function resolveNamedProfile(input: {
  readonly documents: Readonly<Record<string, string>>;
  readonly name: string;
  readonly overrides?: Input<MachineOverrides>;
}): DesiredConfig {
  const { documents, name, overrides } = input;
  const root = rootProfile(documents);
  const pins = parsePins(documents['skill-pins.json']);
  const names = profileNames(documents);
  if (names === undefined && name === 'default') return resolveProfile({ base: root, pins, overrides });

  const issues = names === undefined ? [] : profileInventoryIssues(names);
  if (!isProfileName(name)) issues.push(issue('profile', profilePath(name), '', `invalid profile name '${name}'`));
  const profiles = new Map((names ?? []).map(profile => [profile, parseProfileDocument(documents[profilePath(profile)]!, profilePath(profile))]));
  const chain = chainFor(profiles, name, issues);
  const files = [...root.files];
  const skills = root.skills.map(group => ({ ...group, skills: [...group.skills] }));
  const integrations = [...root.integrations];
  const layers = {
    files: new Map<string, { managed: boolean; from: Origin }>(),
    skills: new Map<string, { install: boolean; from: Origin }>(),
    integrations: new Map<string, Origin>(),
  } satisfies ProfileLayers;
  for (const document of chain) {
    const from: Origin = { layer: 'profile', source: document.source };
    const { value } = document;
    for (const [id, src] of Object.entries(value.files ?? {})) {
      const index = files.findIndex(file => file.id === id);
      if (src !== null) files[index] = { ...files[index]!, src };
      layers.files.set(id, { managed: src !== null, from });
    }
    for (const [action, selections] of [['remove', value.skills?.remove], ['add', value.skills?.add]] as const) {
      for (const selection of selections ?? []) {
        for (const skill of selection.names) {
          let group = skills.find(group => group.source === selection.source && group.skills.includes(skill));
          if (group === undefined && action === 'add') {
            group = { source: selection.source, skills: [skill], exact: true, optional: false };
            skills.push(group);
          }
          if (group !== undefined) layers.skills.set(`${selection.source}/${skill}`, { install: action === 'add', from });
        }
      }
    }
    for (const [action, ids] of [['remove', value.integrations?.remove], ['add', value.integrations?.add]] as const) {
      for (const id of ids ?? []) {
        const index = integrations.findIndex(item => item.id === id);
        if (index === -1) issues.push(issue('profile', document.source, `integrations.${action}`, `integration '${id}' is not declared in integrations.json`));
        else {
          integrations[index] = { ...integrations[index]!, default: action === 'add' };
          layers.integrations.set(id, from);
        }
      }
    }
  }
  // Parse the selected settings paths only. A replaced or excluded root document owns no keys.
  const settings: Record<string, BaseProfile['settings'][string]> = {};
  const settingsIssues: Issue[] = [];
  for (const file of files) {
    if (file.mode !== 'merge-keys' || layers.files.get(file.id)?.managed === false) continue;
    const parsed = parseSettingsKeys(documents[file.src], file.src);
    settings[file.id] = parsed.value;
    const from = layers.files.get(file.id)?.from;
    settingsIssues.push(...parsed.issues.map(problem => from ? { ...problem, ...from } : problem));
  }
  const base = { ...root, files, skills, integrations, settings,
    issues: [...root.issues.filter(problem => !FILES.some(file => file.mode === 'merge-keys' && file.src === problem.source)), ...settingsIssues, ...issues],
  };
  const declaredSources = [...profiles.values()].flatMap(document => [
    ...document.value.skills?.add ?? [], ...document.value.skills?.remove ?? [],
  ]).map(selection => selection.source);
  return resolveProfile({ base, layers, declaredSources, pins, overrides });
}

// Lists users of a shared path, including inherited references and excluding disabled files.
export function profilesUsingPath(documents: Readonly<Record<string, string>>, path: string): readonly string[] {
  return (profileNames(documents) ?? ['default']).filter(name => {
    const config = resolveNamedProfile({ documents, name });
    return !config.issues.length && config.files.some(file => file.managed && file.src === path);
  });
}
