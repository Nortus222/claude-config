import { isAbsolute, join } from 'node:path';
import { Effect } from 'effect';
import {
  buildBaseProfile, FILES, INTEGRATIONS_SOURCE, parsePins, PINS_SOURCE, referencedFiles, resolveProfile, SKILLS_SOURCE,
  type DesiredConfig, type Input, type MachineOverrides,
} from '@nortuscc/profile-engine';
import { Fs, type FsFailed } from '@nortuscc/machine';

// A setup's documents by repo-relative path; an absent document has no entry.
export type Documents = Readonly<Record<string, string>>;

// Every document the profile engine and the config domain read, except hook files, which
// integrations.json names.
export const PROFILE_DOCUMENTS: ReadonlyArray<string> = [
  ...new Set([...FILES.map((f) => f.src), SKILLS_SOURCE, PINS_SOURCE, INTEGRATIONS_SOURCE]),
];

export const documentOf = (documents: Documents, path: string): string | undefined =>
  Object.hasOwn(documents, path) ? documents[path] : undefined;

// A repo-relative path that stays inside the repository.
const inside = (path: string): boolean =>
  path !== '' && !isAbsolute(path) && !/^[a-z]:/i.test(path) && !path.split(/[\\/]/).includes('..');

// The profile documents, then the hook files the integrations document names inside the repository.
export const readDocuments = <E, R>(
  read: (relative: string) => Effect.Effect<string | undefined, E, R>,
): Effect.Effect<Documents, E, R> =>
  Effect.gen(function* () {
    const out: Record<string, string> = {};
    for (const path of PROFILE_DOCUMENTS) {
      const text = yield* read(path);
      if (text !== undefined) out[path] = text;
    }
    for (const path of referencedFiles(documentOf(out, INTEGRATIONS_SOURCE))) {
      if (!inside(path) || Object.hasOwn(out, path)) continue;
      const text = yield* read(path);
      if (text !== undefined) out[path] = text;
    }
    return out;
  });

export const worktreeDocuments = (repo: string): Effect.Effect<Documents, FsFailed, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    return yield* readDocuments((path) => fs.readText(join(repo, path)));
  });

// Replaces `dir` with exactly `documents`.
export const writeDocuments = (dir: string, documents: Documents): Effect.Effect<void, FsFailed, Fs> =>
  Effect.gen(function* () {
    const fs = yield* Fs;
    yield* fs.remove(dir);
    for (const [path, text] of Object.entries(documents)) yield* fs.writeTextAtomic(join(dir, path), text);
  });

// What loadProfile resolves for a directory holding exactly these documents, without touching disk.
export const desiredOfDocuments = (documents: Documents, overrides?: Input<MachineOverrides>): DesiredConfig => {
  const settings: Record<string, string | undefined> = {};
  for (const file of FILES) if (file.mode === 'merge-keys') settings[file.id] = documentOf(documents, file.src);
  const base = buildBaseProfile(
    { skillsManifest: documentOf(documents, SKILLS_SOURCE), integrations: documentOf(documents, INTEGRATIONS_SOURCE), settings },
    (file) => Object.hasOwn(documents, file),
  );
  return resolveProfile({ base, pins: parsePins(documentOf(documents, PINS_SOURCE)), ...(overrides ? { overrides } : {}) });
};
