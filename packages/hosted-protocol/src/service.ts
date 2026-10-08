import { Schema } from 'effect';
import { DisplayNameSchema, IdSchema, IsoTimeSchema, RevisionNumberSchema, SequenceSchema } from './primitives.ts';
import { MachinesResponseSchema } from './machines.ts';
import { SetupsResponseSchema, RevisionRecordSchema } from './revisions.ts';
import { SyncedDecisionSchema } from './sync.ts';

export const HealthResponseSchema = Schema.Struct({ status: Schema.Literal('ok') });
export type HealthResponse = typeof HealthResponseSchema.Type;

export const AccountExportSchema = Schema.Struct({
  account: Schema.Struct({ accountId:IdSchema,githubId:RevisionNumberSchema,login:DisplayNameSchema,seq:SequenceSchema,defaultPolicy:Schema.Literal('notify'),createdAt:IsoTimeSchema }),
  machines: MachinesResponseSchema.fields.machines,
  setups: SetupsResponseSchema.fields.setups,
  revisions: Schema.Array(RevisionRecordSchema),
  decisions: Schema.Array(SyncedDecisionSchema),
});
export type AccountExport = typeof AccountExportSchema.Type;
