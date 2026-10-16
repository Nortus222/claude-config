import { Schema } from 'effect';
import { IntentSchema } from './intents.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/u;
export const DraftSchema = Schema.Struct({
  version: Schema.Literal(1), id: Schema.String.check(Schema.isPattern(UUID)),
  repoUrl: Schema.String.check(Schema.isNonEmpty()),
  createdAt: Schema.String.check(Schema.makeFilter(value => Number.isFinite(Date.parse(value)))),
  intents: Schema.Array(IntentSchema),
});
