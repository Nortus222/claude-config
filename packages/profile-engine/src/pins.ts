import { Schema } from 'effect';
import type { Input, Pins } from './model.ts';
import { decode, parseJson } from './issues.ts';

export const PINS_SOURCE = 'skill-pins.json';

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const PinsDocument = Schema.Struct({
  version: Schema.Literal(1),
  pins: Schema.Record(NonEmpty, NonEmpty),
});

// Approved revisions, one ref per skill source. Absent means nothing is pinned; a file with
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
