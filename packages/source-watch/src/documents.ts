import { Data } from 'effect';
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
// rather than touch an invalid document. Key order, unknown fields, indentation, line endings
// and the final newline are kept. An absent document starts as `{ version: 1, <field>: {} }`.
export function editEntry(text: string | undefined, field: Field, source: string, value: string | undefined): Edited {
  const original = text ?? JSON.stringify({ version: 1, [field]: {} }, null, 2) + '\n';
  const document = parse(original, field);
  const entries = { ...((document[field] as Record<string, string> | undefined) ?? {}) };
  const previous = Object.hasOwn(entries, source) ? entries[source] : undefined;
  const edited = (next: string): Edited => (previous === undefined ? { text: next } : { text: next, previous });
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
