import { Schema } from 'effect';
import type { Input, Pins } from './model.ts';
import { decode, parseJson } from './issues.ts';

export const PINS_SOURCE = 'skill-pins.json';

// A pin names one immutable commit: a full SHA-1 in git's lowercase spelling, the only form the
// skills installer fetches by id and the form its lock records, so the two compare as strings.
const COMMIT_SHA = /^[0-9a-f]{40}$/;
export const isCommitSha = (ref: string): boolean => COMMIT_SHA.test(ref);

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const CommitSha = Schema.String.check(Schema.isPattern(COMMIT_SHA));
const PinsDocument = Schema.Struct({
  version: Schema.Literal(1),
  pins: Schema.Record(NonEmpty, CommitSha),
});

// Approved revisions, one commit SHA per skill source. Absent means nothing is pinned; a file with
// any problem pins nothing and reports why.
export function parsePins(text: string | undefined): Input<Pins> {
  const none = { value: {}, source: PINS_SOURCE };
  if (text === undefined) return { ...none, issues: [] };

  const parsed = parseJson(text, 'pin', PINS_SOURCE);
  if (!parsed.ok) return { ...none, issues: [parsed.issue] };

  const decoded = decode(PinsDocument, parsed.value, 'pin', PINS_SOURCE);
  if (!decoded.ok) return { ...none, issues: [decoded.issue] };
  return { value: decoded.value.pins, source: PINS_SOURCE, issues: [] };
}
