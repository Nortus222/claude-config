import { Schema } from 'effect';
import { DisplayNameSchema, IdSchema, IsoTimeSchema, OsSchema, PolicySchema } from './primitives.ts';
import { AgentsSchema } from './auth.ts';
import { StatusSummarySchema } from './status.ts';
import { MAX_MACHINES } from './decode.ts';

export const MachinePatchSchema = Schema.Struct({
  name: Schema.optionalKey(DisplayNameSchema),
  policy: Schema.optionalKey(PolicySchema),
  reportStatus: Schema.optionalKey(Schema.Boolean),
}).check(Schema.makeFilter((patch) => Object.keys(patch).length > 0));
export type MachinePatch = typeof MachinePatchSchema.Type;
export const MachineRecordSchema = Schema.Struct({
  machineId: IdSchema,
  name: DisplayNameSchema,
  os: OsSchema,
  agents: AgentsSchema,
  policy: PolicySchema,
  reportStatus: Schema.Boolean,
  createdAt: IsoTimeSchema,
  lastSeenAt: IsoTimeSchema,
  status: Schema.NullOr(StatusSummarySchema),
}).check(Schema.makeFilter((machine) => machine.reportStatus || machine.status === null));
export type MachineRecord = typeof MachineRecordSchema.Type;
export const MachinesResponseSchema = Schema.Struct({ machines: Schema.Array(MachineRecordSchema).check(Schema.isMaxLength(MAX_MACHINES), Schema.makeFilter((machines) => new Set(machines.map((machine) => machine.machineId)).size === machines.length)) });
export type MachinesResponse = typeof MachinesResponseSchema.Type;
