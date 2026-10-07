import { Schema } from 'effect';
import { IdSchema, RevisionNumberSchema, SequenceSchema } from './primitives.ts';
import { ItemIdSchema } from './items.ts';
import { MAX_DECISIONS, decodeHosted } from './decode.ts';

export const DecisionSchema = Schema.Struct({ setupId: IdSchema, itemId: ItemIdSchema, revision: RevisionNumberSchema, decision: Schema.Literals(['accept', 'skip']) });
export type Decision = typeof DecisionSchema.Type;
// Repeated keys are consecutive offline decisions; their order must survive decoding.
export const DecisionsRequestSchema = Schema.Struct({ decisions: Schema.Array(DecisionSchema).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DECISIONS)) });
export type DecisionsRequest = typeof DecisionsRequestSchema.Type;
export const DecisionResultSchema = Schema.Struct({ setupId: IdSchema, itemId: ItemIdSchema, outcome: Schema.Literals(['stored', 'stale', 'unprocessed']) });
export type DecisionResult = typeof DecisionResultSchema.Type;
export const DecisionsResponseSchema = Schema.Struct({ seq: SequenceSchema, results: Schema.Array(DecisionResultSchema).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_DECISIONS)) }).check(Schema.makeFilter((body) => {
  const first = body.results.findIndex((result) => result.outcome === 'unprocessed');
  return first === -1 || body.results.slice(first).every((result) => result.outcome === 'unprocessed');
}));
export type DecisionsResponse = typeof DecisionsResponseSchema.Type;

// Correlates outcomes before a client can remove the corresponding sent entries.
export const decodeDecisionsResponse = (request: DecisionsRequest, value: unknown): DecisionsResponse => {
  const sent = decodeHosted(DecisionsRequestSchema, request);
  const response = decodeHosted(DecisionsResponseSchema, value);
  if (response.results.length !== sent.decisions.length || response.results.some((result, index) =>
    result.setupId !== sent.decisions[index].setupId || result.itemId !== sent.decisions[index].itemId)) {
    throw new Error('Invalid hosted payload');
  }
  return response;
};
