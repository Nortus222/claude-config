import type { FileEntry } from './model.ts';
import table from './files.json' with { type: 'json' };

export const FILES_SOURCE = 'built-in';

// The base profile's managed files: the only table of them. `id` is the state-file key
// (`<target>:<dest>`); the table is untyped JSON, so checks/files.spec.ts checks its shape.
export const FILES = table as ReadonlyArray<FileEntry>;
