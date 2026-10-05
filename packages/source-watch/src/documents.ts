import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Data, Effect } from 'effect';
import { redact } from './redact.ts';

// The author's decisions about sources, as repo documents: `pins` in skill-pins.json (source → ref)
// and `ignored` in source-ignores.json (source → sha).
export type Field = 'pins' | 'ignored';
export type Edited = { readonly text: string; readonly previous?: string }; // previous: the entry's old value

// A document that cannot be edited safely, or input that must not be written. `reason` is redacted.
export class DocumentInvalid extends Data.TaggedError('DocumentInvalid')<{ readonly reason: string }> {}

export const PINS_FILE = 'skill-pins.json';
export const IGNORES_FILE = 'source-ignores.json';
export const FILES: Readonly<Record<Field, string>> = { pins: PINS_FILE, ignored: IGNORES_FILE };

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (field: Field, problem: string) =>
  new DocumentInvalid({ reason: redact(`${FILES[field]} ${problem}`) });

// The whole document, checked the way the profile engine reads skill-pins.json.
function parse(text: string, field: Field): Json {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw invalid(field, `is not JSON: ${(error as Error).message}`);
  }
  if (!isObject(document)) throw invalid(field, 'is not a JSON object');
  if (document.version !== 1) throw invalid(field, 'has a version other than 1');
  const entries = document[field];
  if (entries === undefined) return document;
  if (!isObject(entries)) throw invalid(field, `${field} is not an object`);
  for (const [key, value] of Object.entries(entries)) {
    if (key === '' || typeof value !== 'string' || value === '') {
      throw invalid(field, `${field} needs non-empty string keys and values`);
    }
  }
  return document;
}

// A document's entries; throws DocumentInvalid when the document is not valid.
export function readEntries(text: string, field: Field): Record<string, string> {
  return { ...((parse(text, field)[field] as Record<string, string> | undefined) ?? {}) };
}

// Sets (or, with `value` undefined, removes) one source's entry. Pure; throws DocumentInvalid
// rather than touch an invalid document or write an empty source or value. Key order, unknown fields, indentation, line endings
// and the final newline are kept. An absent document starts as `{ version: 1, <field>: {} }`.
export function editEntry(text: string | undefined, field: Field, source: string, value: string | undefined): Edited {
  const original = text ?? JSON.stringify({ version: 1, [field]: {} }, null, 2) + '\n';
  const document = parse(original, field);
  const entries = { ...((document[field] as Record<string, string> | undefined) ?? {}) };
  const previous = Object.hasOwn(entries, source) ? entries[source] : undefined;
  const edited = (next: string): Edited => (previous === undefined ? { text: next } : { text: next, previous });
  if (source === '' || value === '') throw invalid(field, `${field} needs non-empty string keys and values`);
  if (value === previous) return edited(original);

  if (value === undefined) delete entries[source];
  else entries[source] = value;

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(original)?.[1] ?? '  ';
  let next = JSON.stringify({ ...document, [field]: entries }, null, indent);
  if (eol === '\r\n') next = next.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(original)) next += eol;
  return edited(next);
}

export type WriteOptions = { readonly backupDir: string }; // where the old file is copied first
export type Written = { readonly previous?: string; readonly backup?: string }; // backup: absolute path

// Reading, backing up or replacing a document failed. `reason` is redacted.
export class WriteFailed extends Data.TaggedError('WriteFailed')<{ readonly reason: string }> {}

const io = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) => new WriteFailed({ reason: redact(error instanceof Error ? error.message : String(error)) }),
  });

const readText = (path: string) =>
  readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? undefined : Promise.reject(error),
  );

// Copies the file to `<dir>/<name>.<UTC timestamp>`, adding `-<n>` when that name is taken.
async function backUp(path: string, dir: string): Promise<string> {
  const absolute = resolve(dir);
  await mkdir(absolute, { recursive: true });
  const base = join(absolute, `${basename(path)}.${new Date().toISOString().replace(/[-:.]/g, '')}`);
  for (let n = 0; ; n++) {
    const target = n === 0 ? base : `${base}-${n}`;
    try {
      await copyFile(path, target, constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

// Writes beside the file, then renames over it, so no reader sees a half-written document.
async function replace(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, text, { flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

// Sets or removes one source's entry in the repo's document for `field`. The existing file is
// backed up before it changes; an invalid document is never rewritten; an edit that changes
// nothing writes nothing. Undo by calling again with the returned `previous`.
export const writeEntry = (
  repoDir: string,
  field: Field,
  source: string,
  value: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  Effect.gen(function* () {
    if (source === '') return yield* Effect.fail(invalid(field, 'cannot hold an empty source'));
    const path = join(repoDir, FILES[field]);
    const old = yield* io(() => readText(path));
    const { text, previous } = yield* Effect.try({
      try: () => editEntry(old, field, source, value),
      catch: (error) =>
        error instanceof DocumentInvalid ? error : new DocumentInvalid({ reason: redact(String(error)) }),
    });
    const unchanged = previous === undefined ? {} : { previous };
    if (text === old || (old === undefined && value === undefined)) return unchanged;
    const backup = old === undefined ? undefined : yield* io(() => backUp(path, options.backupDir));
    yield* io(() => replace(path, text));
    return backup === undefined ? unchanged : { ...unchanged, backup };
  });
