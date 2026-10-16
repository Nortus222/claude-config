import { Effect } from 'effect';
import { listProfiles, memoryFiles, parseProfileDocument, profilesUsingPath, resolveNamedProfile, type ProfileDocument } from '@nortuscc/profile-engine';
import { DocumentInvalid, editEntry, IGNORES_FILE, PINS_FILE } from '@nortuscc/source-watch';
import type { Intent } from './intents.ts';

type Documents = Readonly<Record<string, string>>;
type EditableProfile = { -readonly [Key in keyof ProfileDocument]: ProfileDocument[Key] };
const profilePath = (name: string) => `profiles/${name}.json`;
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const names = (documents: Documents) => Effect.runSync(listProfiles('.').pipe(Effect.provide(memoryFiles(documents))));

function profile(documents: Documents, name: string): EditableProfile {
  if (!names(documents).includes(name)) throw new Error(`Missing profile '${name}'`);
  const path = profilePath(name);
  const text = documents[path] ?? '{}';
  const parsed = parseProfileDocument(text, path);
  const issues = [...parsed.issues, ...resolveNamedProfile({ documents, name }).issues.filter(issue => issue.layer === 'profile')];
  if (issues.length) throw new Error(issues.map(issue => issue.message).join('; '));
  // Keep unrelated fields and their insertion order.
  return JSON.parse(text);
}

function editProfile(documents: Documents, name: string, edit: (document: EditableProfile) => void): Record<string, string> {
  const document = profile(documents, name);
  edit(document);
  const path = profilePath(name);
  const text = serialize(document);
  const parsed = parseProfileDocument(text, path);
  if (parsed.issues.length) throw new Error(parsed.issues.map(issue => issue.message).join('; '));
  return { ...documents, [path]: text };
}

// Resolves the selected file and every profile using that path, including conservative invalid chains.
export function captureTargets(documents: Documents, name: string, fileId: string): { path: string; profiles: string[] } {
  profile(documents, name);
  const file = resolveNamedProfile({ documents, name }).files.find(file => file.id === fileId);
  if (!file?.managed) throw new Error(`File '${fileId}' is not included in profile '${name}'`);
  return { path: file.src, profiles: [...profilesUsingPath(documents, file.src)] };
}

function apply(documents: Documents, intent: Intent): Record<string, string> {
  switch (intent.kind) {
    case 'createProfile': {
      const path = profilePath(intent.profile);
      if (Object.hasOwn(documents, path)) throw new Error(`Profile '${intent.profile}' already exists`);
      const hasProfiles = Object.keys(documents).some(path => path === 'profiles' || path.startsWith('profiles/'));
      const next = { ...documents, ...(!hasProfiles ? { 'profiles/default.json': '{}\n' } : {}),
        [path]: serialize(intent.extends === null ? {} : { extends: intent.extends }) };
      profile(next, intent.profile);
      return next;
    }
    case 'pin': case 'unpin': case 'ignore': case 'unignore': {
      const field = intent.kind === 'pin' || intent.kind === 'unpin' ? 'pins' : 'ignored';
      const path = field === 'pins' ? PINS_FILE : IGNORES_FILE;
      const value = intent.kind === 'pin' ? intent.commit : intent.kind === 'ignore' ? intent.revision : undefined;
      if (documents[path] === undefined && value === undefined) return { ...documents };
      return { ...documents, [path]: editEntry(documents[path], field, intent.source, value).text };
    }
    case 'includeSkill': case 'excludeSkill':
      return editProfile(documents, intent.profile, document => {
        const action = intent.kind === 'includeSkill' ? 'add' : 'remove';
        const opposite = action === 'add' ? 'remove' : 'add';
        const skills = { ...document.skills };
        if (skills[opposite]) skills[opposite] = skills[opposite].map(group => group.source === intent.source
          ? { ...group, names: group.names.filter(name => name !== intent.name) } : group).filter(group => group.source !== intent.source || group.names.length > 0);
        const selections = [...skills[action] ?? []];
        const index = selections.findIndex(group => group.source === intent.source);
        if (index < 0) selections.push({ source: intent.source, names: [intent.name] });
        else if (!selections[index]!.names.includes(intent.name)) selections[index] = { ...selections[index]!, names: [...selections[index]!.names, intent.name] };
        skills[action] = selections;
        document.skills = skills;
      });
    case 'setFile':
      return editProfile(documents, intent.profile, document => { document.files = { ...document.files, [intent.fileId]: intent.path }; });
    case 'setIntegration':
      return editProfile(documents, intent.profile, document => {
        const config = resolveNamedProfile({ documents, name: intent.profile });
        if (!config.integrations.some(item => item.id === intent.id)) throw new Error(`Integration '${intent.id}' is not declared in integrations.json`);
        const action = intent.include ? 'add' : 'remove';
        const opposite = intent.include ? 'remove' : 'add';
        const integrations = { ...document.integrations };
        if (integrations[opposite]) integrations[opposite] = integrations[opposite].filter(id => id !== intent.id);
        if (!integrations[action]?.includes(intent.id)) integrations[action] = [...integrations[action] ?? [], intent.id];
        document.integrations = integrations;
      });
    case 'captureFile': {
      const target = captureTargets(documents, intent.profile, intent.fileId);
      if (intent.choice.kind === 'updateShared') return { ...documents, [target.path]: intent.text };
      const path = intent.choice.repoPath;
      if (profilesUsingPath(documents, path).some(name => name !== intent.profile)) throw new Error(`Own copy '${path}' is used by another profile`);
      const next = editProfile(documents, intent.profile, document => { document.files = { ...document.files, [intent.fileId]: path }; });
      return { ...next, [path]: intent.text };
    }
  }
}

// Replays decoded intents in order. An invalid edit changes no documents; later edits still run.
export function replay(documents: Documents, intents: readonly Intent[]): {
  documents: Record<string, string | null>; invalid: { index: number; reason: string }[];
} {
  let next = { ...documents };
  const invalid: { index: number; reason: string }[] = [];
  intents.forEach((intent, index) => {
    try { next = apply(next, intent); }
    catch (error) {
      const reason = error instanceof DocumentInvalid ? error.reason : error instanceof Error ? error.message : String(error);
      invalid.push({ index, reason });
    }
  });
  return { documents: next, invalid };
}
