import { readFile, stat } from 'node:fs/promises';
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

// The filesystem as profile loading needs it: a document's text, or undefined when it is absent.
export class ProfileFiles extends Context.Service<
  ProfileFiles,
  {
    readonly readText: (path: string) => Effect.Effect<string | undefined, ReadFailed>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
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
  // Any failure reads as absent, matching the CLI's existsSync.
  exists: (path: string) => Effect.promise(() => stat(path).then(() => true, () => false)),
});

// Serves documents from a record keyed by absolute path; for tests and previews.
export const memoryFiles = (files: Readonly<Record<string, string>>) =>
  Layer.succeed(ProfileFiles, {
    readText: (path: string) => Effect.succeed(Object.hasOwn(files, path) ? files[path] : undefined),
    exists: (path: string) => Effect.succeed(Object.hasOwn(files, path)),
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
