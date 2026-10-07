import { Schema } from 'effect';

export const POLICIES = ['auto-apply', 'notify', 'manual'] as const;
export type Policy = typeof POLICIES[number];
export const PolicySchema = Schema.Literals(POLICIES);
export const AgentKindSchema = Schema.Literals(['claude', 'codex']);
export const OsSchema = Schema.Literals(['macos', 'linux', 'windows']);

export const IdSchema = Schema.String.check(Schema.makeFilter((id) => /^[A-Za-z0-9-]{1,100}$/.test(id) && id !== 'local'));
export const RevisionNumberSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
export const RevisionCursorSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const SequenceSchema = RevisionCursorSchema;
export const CountSchema = RevisionCursorSchema;
export const CommitShaSchema = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
export const EnvNameSchema = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const DisplayNameSchema = Schema.String.check(Schema.makeFilter((name) =>
  name === name.trim() && [...name].length >= 1 && [...name].length <= 100 && !/\p{C}/u.test(name)));

const validIsoTime = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(hourText) <= 23 && Number(minuteText) <= 59 && Number(secondText) <= 59
    && (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
};
export const IsoTimeSchema = Schema.String.check(Schema.makeFilter(validIsoTime));

// Accepts a tag name, never a full refs/ name or an option passed to Git.
export const TagSchema = Schema.String.check(Schema.makeFilter((tag) =>
  tag !== '' && tag !== '@' && !tag.startsWith('-') && !tag.startsWith('refs/')
  && !tag.endsWith('.') && !tag.includes('..') && !tag.includes('@{')
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(tag)
  && tag.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))));
