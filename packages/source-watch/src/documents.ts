import { basename, join, resolve } from 'node:path';
import { buildBaseProfile, parsePins, resolveProfile } from '@nortuscc/profile-engine';
import { authorDigest, Fs, nodeFs, validateAuthorBinding, type AuthorBinding, type AuthorServices, type PreparedAuthorEdit } from '@nortuscc/machine';
import type { Git } from './git.ts';
import type { WatchedSource } from './model.ts';
import { Data, Effect } from 'effect';
import { redact } from './redact.ts';

// The author's decisions about sources, as repo documents: `pins` in skill-pins.json (source → full commit sha)
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

// The whole document. `pins` is checked by the profile engine's own parser, so an edit never leaves
// a file the engine would ignore; `ignored` (source-ignores.json, not an engine document) is checked here.
function parse(text: string, field: Field): Json {
  if (field === 'pins') {
    const [issue] = parsePins(text).issues;
    if (issue !== undefined) throw invalid(field, issue.message);
  }
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
  parse(next, field); // the edited document must still be valid, e.g. a pin that is not a commit sha
  return edited(next);
}

export type WriteOptions = { readonly backupDir: string }; // where the old file is copied first
export type Written = { readonly previous?: string; readonly backup?: string }; // backup: absolute path

// Reading, backing up or replacing a document failed. `reason` is redacted.
export class WriteFailed extends Data.TaggedError('WriteFailed')<{ readonly reason: string }> {}

// Service-based legacy writer. Callers coordinate concurrent mutations and supply their clock.
export const writeEntryWithServices = (
  repoDir: string, field: Field, source: string, value: string | undefined,
  options: WriteOptions, at: Date,
): Effect.Effect<Written, DocumentInvalid | WriteFailed, Fs> => Effect.gen(function* () {
  if (source === '') return yield* Effect.fail(invalid(field, 'cannot hold an empty source'));
  const fs = yield* Fs;
  if ((yield* fs.stat(repoDir))?.kind !== 'directory') return yield* Effect.fail(new WriteFailed({reason:'Source document directory is unavailable'}));
  const path = join(repoDir, FILES[field]);
  if ((yield* fs.stat(path))?.kind === 'symlink') return yield* Effect.fail(new WriteFailed({reason:'Source document must be a regular file'}));
  const bytes = yield* fs.readBytes(path);
  const old = bytes === undefined ? undefined : yield* Effect.try({try:()=>new TextDecoder('utf-8',{fatal:true}).decode(bytes),catch:()=>new WriteFailed({reason:'Source document is not UTF-8'})});
  const {text,previous} = yield* Effect.try({try:()=>editEntry(old,field,source,value),catch:error=>error instanceof DocumentInvalid?error:invalid(field,'is invalid')});
  const unchanged = previous === undefined ? {} : {previous};
  if (text === old || (old === undefined && value === undefined)) return unchanged;
  let backup: string | undefined;
  if (bytes !== undefined) {
    const dir = resolve(options.backupDir);
    yield* fs.createDirectory(dir,{recursive:true});
    const base = join(dir, `${basename(path)}.${at.toISOString().replace(/[-:.]/g,'')}`);
    for (let n = 0; ; n++) {
      const target = n === 0 ? base : `${base}-${n}`;
      if (yield* fs.stat(target)) continue;
      yield* fs.copy(path,target,{exclusive:true});
      backup = target;
      break;
    }
  }
  if (authorDigest(yield* fs.readBytes(path)) !== authorDigest(bytes)) return yield* Effect.fail(new WriteFailed({reason:'Source document changed; preview again'}));
  yield* fs.writeTextAtomic(path,text);
  return backup === undefined ? unchanged : {...unchanged,backup};
}).pipe(Effect.mapError(error=>error instanceof DocumentInvalid||error instanceof WriteFailed?error:new WriteFailed({reason:'Source document could not be backed up or replaced'})));

// Standalone convenience boundary preserves existing callers. App operations use PreparedAuthorEdit.
export const writeEntry = (
  repoDir: string, field: Field, source: string, value: string | undefined, options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> => Effect.flatMap(Effect.sync(()=>new Date()), at =>
  writeEntryWithServices(repoDir,field,source,value,options,at).pipe(Effect.provide(nodeFs)));

// JSON.parse accepts duplicate keys; author edits refuse them so serialization cannot erase dirty intent.
const duplicateKeys = (text: string): boolean => {
  JSON.parse(text);
  const objects: (Set<string> | undefined)[] = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(undefined);
    else if (token === '}' || token === ']') objects.pop();
    else {
      let next = match.index! + token.length;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] !== ':') continue;
      const key: string = JSON.parse(token), keys = objects.at(-1);
      if (keys?.has(key)) return true;
      keys?.add(key);
    }
  }
  return false;
};

export type SourceDecisionAction = 'pin' | 'unpin' | 'ignore' | 'unignore';
// Reads only the exact accepted author files. A tolerant reader must never turn an error into absence.
export const prepareSourceEdit = (input: {
  readonly author: AuthorBinding; readonly source: WatchedSource;
  readonly action: SourceDecisionAction; readonly revision?: string;
}): Effect.Effect<PreparedAuthorEdit, unknown, AuthorServices | Git> => Effect.gen(function* () {
  const { author, source, action, revision } = input;
  const setting = action === 'pin' || action === 'ignore';
  const field: Field = action === 'pin' || action === 'unpin' ? 'pins' : 'ignored';
  if (setting ? revision === undefined || !/^[a-f0-9]{40}$(?![\s\S])/.test(revision) : revision !== undefined)
    return yield* Effect.fail(invalid(field, 'requires an exact lowercase SHA for pin/ignore and no revision for reset'));
  yield* validateAuthorBinding(author);
  const fs = yield* Fs;
  const texts = new Map<string, string | undefined>();
  for (const path of ['skills-manifest.txt', PINS_FILE, IGNORES_FILE]) {
    const accepted = author.files.find(file => file.path === path);
    const bytes = yield* fs.readBytes(join(author.realCheckout, path));
    if (!accepted || accepted.sha256 !== authorDigest(bytes)) return yield* Effect.fail(invalid(field, 'changed; preview again'));
    const text = bytes === undefined ? undefined : yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes), catch: () => invalid(field, 'is not UTF-8'),
    });
    texts.set(path, text);
  }
  const base = buildBaseProfile({ skillsManifest: texts.get('skills-manifest.txt') }, () => false);
  if (!base.skills.some(group => group.source === source.source))
    return yield* Effect.fail(new DocumentInvalid({ reason: 'This source has no declaration in the configured author manifest; add its author declaration before editing source policy' }));
  for (const current of ['pins', 'ignored'] as const) {
    const text = texts.get(FILES[current]);
    if (text !== undefined) yield* Effect.try({ try: () => {
      if (duplicateKeys(text)) throw invalid(current, 'contains duplicate keys');
      const entries = readEntries(text, current);
      if (current === 'ignored' && Object.values(entries).some(sha => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha))) throw invalid(current, 'has an invalid revision');
      return entries;
    }, catch: () => invalid(current, 'is invalid; repair it before editing') });
  }
  const before = texts.get(FILES[field]);
  const edited = yield* Effect.try({ try: () => editEntry(before, field, source.source, revision), catch: () => invalid(field, 'is invalid; repair it before editing') });
  // Resolve the proposed author policy with the engine, including unrelated existing source pins.
  const proposed = resolveProfile({ base, pins: parsePins(field === 'pins' ? edited.text : texts.get(PINS_FILE)) });
  if (proposed.issues.length) return yield* Effect.fail(invalid(field, 'does not resolve as a valid author source policy'));
  yield* validateAuthorBinding(author);
  return { author, documents: edited.text === before || (before === undefined && !setting) ? [] : [{
    path: FILES[field], beforeSha256: authorDigest(before), text: edited.text, afterSha256: authorDigest(edited.text)!,
  }] };
});
