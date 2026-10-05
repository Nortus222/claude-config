import type { FileEntry } from './model.ts';
import table from './files.json' with { type: 'json' };

export const FILES_SOURCE = 'built-in';

// The base profile's managed files: the only table of them. It is JSON so the legacy CLI
// (src/manifest.mjs) reads the same table from an npx copy, where TypeScript cannot load. `id` is
// the state-file key (`<target>:<dest>`); checks/files.spec.ts checks the shape.
export const FILES = table as ReadonlyArray<FileEntry>;
