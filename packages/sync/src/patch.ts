import {
  FILES, INTEGRATIONS_SOURCE, parsePins, parseSkillsManifest, PINS_SOURCE, SKILLS_SOURCE, type SkillGroup,
} from '@nortuscc/profile-engine';
import { desiredOfDocuments, documentOf, inside, type Documents } from './documents.ts';
import { parseItemId, type ItemRef } from './items.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseObject = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const withDocument = (documents: Documents, path: string, text: string | undefined): Documents => {
  const { [path]: _replaced, ...rest } = documents;
  return text === undefined ? rest : { ...rest, [path]: text };
};

// A settings key set to its held value, or deleted when the held commit did not own it (a refused
// held document owns nothing). An empty
// document owns nothing and is removed. An unparseable head document is left for the engine to report.
const patchSetting = (head: Documents, ref: Extract<ItemRef, { kind: 'setting' }>, held: Documents): Documents => {
  const file = FILES.find((f) => f.id === ref.fileId && f.mode === 'merge-keys');
  if (file === undefined) return head;
  const text = documentOf(head, file.src);
  const current = text === undefined ? {} : parseObject(text);
  if (current === undefined) return head;
  const keys = desiredOfDocuments(held).files.find((f) => f.id === ref.fileId)?.keys;
  const next: Record<string, unknown> = { ...current };
  if (keys !== undefined && Object.hasOwn(keys, ref.key)) next[ref.key] = keys[ref.key]!.value;
  else delete next[ref.key];
  return withDocument(head, file.src, Object.keys(next).length > 0 ? json(next) : undefined);
};

const patchFile = (head: Documents, ref: Extract<ItemRef, { kind: 'file' }>, held: Documents): Documents => {
  const file = FILES.find((f) => f.id === ref.fileId && f.mode === 'copy');
  return file === undefined ? head : withDocument(head, file.src, documentOf(held, file.src));
};

const HEADER = /^\[([^\]]+)\]\s*(.*?)\s*$/;
type Header = { readonly source: string; readonly exact: boolean; readonly optional: boolean };

// The engine's header grammar (parseSkillsManifest), read line by line.
const headerOf = (line: string): Header | undefined => {
  const match = HEADER.exec(line.trim());
  if (!match) return undefined;
  const markers = match[2]!.split(/\s+/);
  return { source: match[1]!.trim(), exact: markers.includes('exact'), optional: markers.includes('optional') };
};

// The manifest's lines without `name` in any group of `source`.
const withoutSkill = (text: string, ref: { readonly source: string; readonly name: string }): string[] => {
  let source: string | undefined;
  return text.split(/\r?\n/).filter((line) => {
    const header = headerOf(line);
    if (header) {
      source = header.source;
      return true;
    }
    return !(source === ref.source && line.trim() === ref.name);
  });
};

// `name` after the last skill of the last group like `group` (same source and markers), or under a
// new header at the end.
const withSkill = (lines: string[], name: string, group: SkillGroup | undefined): string[] => {
  if (group === undefined) return lines;
  const same = (h: Header | undefined) => h !== undefined && h.source === group.source && h.exact === group.exact && h.optional === group.optional;
  let current: Header | undefined;
  let at = -1;
  lines.forEach((line, i) => {
    const header = headerOf(line);
    if (header) current = header;
    const entry = header === undefined && line.trim() !== '' && !line.trim().startsWith('#');
    if (same(current) && (header !== undefined || entry)) at = i + 1;
  });
  if (at !== -1) return [...lines.slice(0, at), name, ...lines.slice(at)];
  const body = [...lines];
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
  const markers = [group.exact ? 'exact' : '', group.optional ? 'optional' : ''].filter(Boolean).join(' ');
  return [...body, ...(body.length > 0 ? [''] : []), markers ? `[${group.source}] ${markers}` : `[${group.source}]`, name, ''];
};

// A source's pin set, or deleted when `ref` is undefined. An unparseable head document is left as it is.
const withPin = (text: string | undefined, source: string, ref: string | undefined): string | undefined => {
  const document = text === undefined ? { version: 1, pins: {} } : parseObject(text);
  if (document === undefined) return text;
  if (text === undefined && ref === undefined) return undefined;
  const pins: Record<string, unknown> = isRecord(document.pins) ? { ...document.pins } : {};
  if (ref === undefined) delete pins[source];
  else pins[source] = ref;
  return json({ ...document, pins });
};

// The skill's line as at the held commit (its group's markers included) and its source's pin as
// at the held commit, which moves every skill of that source (ruling 3).
const patchSkill = (head: Documents, ref: Extract<ItemRef, { kind: 'skill' }>, held: Documents): Documents => {
  const group = parseSkillsManifest(documentOf(held, SKILLS_SOURCE)).find((g) => g.source === ref.source && g.skills.includes(ref.name));
  const before = documentOf(head, SKILLS_SOURCE);
  const manifest = before === undefined && group === undefined
    ? undefined
    : withSkill(withoutSkill(before ?? '', ref), ref.name, group).join('\n');
  const heldPins = parsePins(documentOf(held, PINS_SOURCE)).value;
  const pin = Object.hasOwn(heldPins, ref.source) ? heldPins[ref.source] : undefined;
  const pins = withPin(documentOf(head, PINS_SOURCE), ref.source, pin);
  return withDocument(withDocument(head, SKILLS_SOURCE, manifest), PINS_SOURCE, pins);
};

// The declaration as the engine resolved it at the held commit (a refused held document declares
// nothing): replaced in place, appended, or removed. A held hook keeps
// the file it ships when head no longer has one, and only from inside the repository (ruling 30).
const patchIntegration = (head: Documents, ref: Extract<ItemRef, { kind: 'integration' }>, held: Documents): Documents => {
  const entry: unknown = desiredOfDocuments(held).integrations.find((i) => i.id === ref.id)?.declaration;
  const text = documentOf(head, INTEGRATIONS_SOURCE);
  if (text === undefined && entry === undefined) return head;
  const document = text === undefined ? { version: 1, integrations: [] } : parseObject(text);
  if (document === undefined || !Array.isArray(document.integrations)) return head;
  const list: unknown[] = document.integrations;
  const at = list.findIndex((i) => isRecord(i) && i.id === ref.id);
  const next = entry === undefined
    ? list.filter((_, n) => n !== at)
    : at === -1 ? [...list, entry] : list.map((i, n) => (n === at ? entry : i));
  let out = withDocument(head, INTEGRATIONS_SOURCE, json({ ...document, integrations: next }));
  const file = isRecord(entry) && entry.type === 'hook' && typeof entry.file === 'string' && inside(entry.file) ? entry.file : undefined;
  const body = file === undefined ? undefined : documentOf(held, file);
  if (file !== undefined && body !== undefined && documentOf(out, file) === undefined) out = withDocument(out, file, body);
  return out;
};

// `head` with one held item's value taken from `held`, the documents at the commit it is held at.
export const patchItem = (head: Documents, itemId: string, held: Documents): Documents => {
  const ref = parseItemId(itemId);
  switch (ref?.kind) {
    case 'setting': return patchSetting(head, ref, held);
    case 'file': return patchFile(head, ref, held);
    case 'skill': return patchSkill(head, ref, held);
    case 'integration': return patchIntegration(head, ref, held);
    default: return head;
  }
};
