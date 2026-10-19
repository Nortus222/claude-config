import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Context, Effect, Layer } from 'effect';
import type { DesiredConfig, Input, MachineOverrides } from './model.ts';
import { ProfileInvalid, ReadFailed } from './errors.ts';
import { FILES } from './files.ts';
import { SKILLS_SOURCE } from './skills.ts';
import { INTEGRATIONS_SOURCE, referencedFiles } from './integrations.ts';
import { PINS_SOURCE, parsePins } from './pins.ts';
import { buildBaseProfile } from './base.ts';
import { resolveProfile } from './resolve.ts';
import { profileInventoryIssues, resolveNamedProfile } from './profile-chain.ts';

// The filesystem as profile loading needs it: a document's text, or undefined when it is absent.
export class ProfileFiles extends Context.Service<
  ProfileFiles,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, ReadFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
    readonly list: (dir: string) => Effect.Effect<readonly string[] | undefined, ReadFailed>;
  }
>()('profile-engine/ProfileFiles') {}

export const nodeFiles = Layer.succeed(ProfileFiles, {
  readText: (path: string) =>
    Effect.tryPromise({
      try: () =>
        readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return undefined;
          throw err;
        }),
      catch: (err) => new ReadFailed({ path, reason: err instanceof Error ? err.message : String(err) }),
    }),
  // Any failure reads as absent.
  exists: (path: string) => Effect.promise(() => stat(path).then(() => true, () => false)),
  list: (path: string) => Effect.tryPromise({
    try: () => readdir(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    }),
    catch: err => new ReadFailed({ path, reason: err instanceof Error ? err.message : String(err) }),
  }),
});

// Serves documents from a record keyed by absolute path; for tests and previews.
export const memoryFiles = (files: Readonly<Record<string, string>>) =>
  Layer.succeed(ProfileFiles, {
    readText: (path: string) => Effect.succeed(Object.hasOwn(files, path) ? files[path] : undefined),
    exists: (path: string) => Effect.succeed(Object.hasOwn(files, path)),
    list: (dir: string) => {
      const prefix = `${dir.replace(/\/$/, '')}/`;
      const paths = Object.keys(files).filter(path => path.startsWith(prefix));
      const present = Object.hasOwn(files, dir) || paths.length > 0;
      return Effect.succeed(present ? [...new Set(paths.map(path => path.slice(prefix.length).split('/')[0]!).filter(Boolean))] : undefined);
    },
  });

// Reads a repository's profile documents and resolves them with optional machine overrides.
export const loadProfile = (
  repoDir: string,
  options: { readonly overrides?: Input<MachineOverrides> } = {},
): Effect.Effect<DesiredConfig, ReadFailed, ProfileFiles> =>
  Effect.gen(function* () {
    const files = yield* ProfileFiles;
    const read = (relative: string) => files.readText(join(repoDir, relative));

    const integrations = yield* read(INTEGRATIONS_SOURCE);
    const shipped = new Set<string>();
    for (const file of referencedFiles(integrations)) {
      if (yield* files.exists(join(repoDir, file))) shipped.add(file);
    }
    const settings: Record<string, string | undefined> = {};
    for (const file of FILES) {
      if (file.mode === 'merge-keys') settings[file.id] = yield* read(file.src);
    }

    const base = buildBaseProfile(
      { skillsManifest: yield* read(SKILLS_SOURCE), integrations, settings },
      (file) => shipped.has(file),
    );
    return resolveProfile({ base, pins: parsePins(yield* read(PINS_SOURCE)), overrides: options.overrides });
  });

// All-or-nothing: fails with every issue when resolution produced any.
export const requireValid = (config: DesiredConfig): Effect.Effect<DesiredConfig, ProfileInvalid> =>
  config.issues.length ? Effect.fail(new ProfileInvalid({ issues: config.issues })) : Effect.succeed(config);

const inventory = (repo: string) => Effect.gen(function* () {
  const files = yield* ProfileFiles;
  const entries = yield* files.list(join(repo, 'profiles'));
  if (entries === undefined) return undefined;
  const names = entries.filter(entry => entry.endsWith('.json')).map(entry => entry.slice(0, -'.json'.length)).sort();
  const issues = profileInventoryIssues(names);
  if (issues.length) return yield* Effect.fail(new ProfileInvalid({ issues }));
  return names;
});

// Directory absence is the legacy default; an existing directory must declare profiles.
export const listProfiles = (repo: string): Effect.Effect<readonly string[], ReadFailed | ProfileInvalid, ProfileFiles> =>
  inventory(repo).pipe(Effect.map(names => names ?? ['default']));

// Named loading is separate from the root-only loader used by the CLI.
export const loadNamedProfile = (
  repo: string, name: string, options: { readonly overrides?: Input<MachineOverrides> } = {},
): Effect.Effect<DesiredConfig, ReadFailed | ProfileInvalid, ProfileFiles> => Effect.gen(function* () {
  const names = yield* inventory(repo);
  if (names === undefined && name === 'default') return yield* loadProfile(repo, options);
  const files = yield* ProfileFiles;
  const documents: Record<string, string> = {};
  if (names !== undefined) documents['profiles/'] = '';
  const read = (path: string) => Effect.gen(function* () {
    const text = yield* files.readText(join(repo, path));
    if (text !== undefined) documents[path] = text;
    return text;
  });
  for (const profile of names ?? []) yield* read(`profiles/${profile}.json`);
  yield* read(SKILLS_SOURCE);
  yield* read(PINS_SOURCE);
  const integrations = yield* read(INTEGRATIONS_SOURCE);
  for (const path of referencedFiles(integrations)) {
    if (!Object.hasOwn(documents, path) && (yield* files.exists(join(repo, path)))) documents[path] = '';
  }
  const selected = resolveNamedProfile({ documents, name });
  for (const file of selected.files) {
    if (file.mode === 'merge-keys' && file.managed) yield* read(file.src);
  }
  return yield* requireValid(resolveNamedProfile({ documents, name, overrides: options.overrides }));
});
