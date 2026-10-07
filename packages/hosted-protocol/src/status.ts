import { Schema } from 'effect';
import { CountSchema, IdSchema, IsoTimeSchema, PolicySchema, RevisionCursorSchema } from './primitives.ts';
import { ItemIdSchema } from './items.ts';
import { AgentsSchema } from './auth.ts';
import { MAX_SETUPS } from './decode.ts';

export const SetupStatusSchema = Schema.Struct({
  setupId: IdSchema,
  revisionApplied: RevisionCursorSchema,
  adopted: Schema.Array(ItemIdSchema),
  skipped: Schema.Array(ItemIdSchema),
  pending: Schema.Array(ItemIdSchema),
  waitingForPerson: Schema.Array(ItemIdSchema),
}).check(Schema.makeFilter((setup) => {
  const ids = [...setup.adopted, ...setup.skipped, ...setup.pending, ...setup.waitingForPerson];
  return new Set(ids).size === ids.length;
}));
export type SetupStatus = typeof SetupStatusSchema.Type;
export const DriftCountsSchema = Schema.Struct({ setting: CountSchema, skill: CountSchema, integration: CountSchema, file: CountSchema });
export type DriftCounts = typeof DriftCountsSchema.Type;
export const StatusSummarySchema = Schema.Struct({
  reportedAt: IsoTimeSchema,
  policy: PolicySchema,
  agents: AgentsSchema,
  setups: Schema.Array(SetupStatusSchema).check(Schema.isMaxLength(MAX_SETUPS), Schema.makeFilter((setups) => new Set(setups.map((setup) => setup.setupId)).size === setups.length)),
  drift: DriftCountsSchema,
}).check(Schema.makeFilter((summary) => summary.policy === 'auto-apply' || summary.setups.every((setup) => setup.pending.length === 0)));
export type StatusSummary = typeof StatusSummarySchema.Type;
