import { Schema } from 'effect';
import type { Input } from './model.ts';
import { decode, issue, parseJson } from './issues.ts';
import { FILES } from './files.ts';
import { isSkillAdditionName, normalizeSkillSource } from './overrides.ts';

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const isProfileName = (name: string): boolean => PROFILE_NAME.test(name);
const Name = Schema.String.check(Schema.isPattern(PROFILE_NAME));
const Text = Schema.String.check(Schema.isNonEmpty());
const SkillSelection = Schema.Struct({ source: Text, names: Schema.Array(Text) });
const Selection = Schema.Struct({
  add: Schema.optional(Schema.Array(SkillSelection)),
  remove: Schema.optional(Schema.Array(SkillSelection)),
});
const Document = Schema.Struct({
  extends: Schema.optional(Name),
  skills: Schema.optional(Selection),
  files: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Text))),
  integrations: Schema.optional(Schema.Struct({
    add: Schema.optional(Schema.Array(Text)),
    remove: Schema.optional(Schema.Array(Text)),
  })),
});
export type ProfileDocument = typeof Document.Type;

// Only relative repository paths may be used as a profile's file sources.
function isRepoPath(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') && !/^[a-z]:/i.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

// Invalid documents contribute no declarations; callers retain every validation issue.
export function parseProfileDocument(text: string, path: string): Input<ProfileDocument> {
  const none = { value: {}, source: path };
  const parsed = parseJson(text, 'profile', path);
  if (!parsed.ok) return { ...none, issues: [parsed.issue] };
  const decoded = decode(Document, parsed.value, 'profile', path);
  if (!decoded.ok) return { ...none, issues: [decoded.issue] };
  const problems: string[] = [];
  for (const [id, src] of Object.entries(decoded.value.files ?? {})) {
    if (!FILES.some(file => file.id === id)) problems.push(`unknown file '${id}'`);
    if (src !== null && !isRepoPath(src)) problems.push(`file '${id}' needs a relative repository path`);
  }
  for (const selection of [...decoded.value.skills?.add ?? [], ...decoded.value.skills?.remove ?? []]) {
    if (normalizeSkillSource(selection.source) === undefined) problems.push('invalid skill source');
    if (selection.names.some(name => !isSkillAdditionName(name))) problems.push('invalid skill name');
  }
  return problems.length
    ? { ...none, issues: problems.map(message => issue('profile', path, '', message)) }
    : { value: decoded.value, source: path, issues: [] };
}
