import { Schema } from 'effect';
import { AgentKindSchema, DisplayNameSchema, IdSchema, OsSchema, PolicySchema, RevisionNumberSchema } from './primitives.ts';

export const AgentsSchema = Schema.Array(AgentKindSchema).check(Schema.makeFilter((agents) => new Set(agents).size === agents.length));
export type Agents = typeof AgentsSchema.Type;
export const MachineTokenSchema = Schema.String.check(Schema.isPattern(/^nmt_[A-Za-z0-9-]{1,100}_[A-Za-z0-9-]{1,100}_[A-Za-z0-9_-]{43}$/), Schema.makeFilter((token) => {
  const [, accountId, machineId] = token.split('_');
  return accountId !== 'local' && machineId !== 'local';
}));
export type MachineToken = typeof MachineTokenSchema.Type;
export const DeviceStartRequestSchema = Schema.Struct({ name: DisplayNameSchema, os: OsSchema, agents: AgentsSchema });
export type DeviceStartRequest = typeof DeviceStartRequestSchema.Type;
const VerificationUriSchema = Schema.String.check(Schema.makeFilter((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname === '/login/device' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.port === '';
  } catch { return false; }
}));
export const DeviceStartResponseSchema = Schema.Struct({
  pendingId: IdSchema,
  userCode: Schema.String.check(Schema.isPattern(/^[A-Z0-9-]{1,100}$/)),
  verificationUri: VerificationUriSchema,
  interval: RevisionNumberSchema,
  expiresIn: RevisionNumberSchema,
});
export type DeviceStartResponse = typeof DeviceStartResponseSchema.Type;
export const DevicePollRequestSchema = Schema.Struct({ pendingId: IdSchema });
export type DevicePollRequest = typeof DevicePollRequestSchema.Type;
export const DevicePollPendingSchema = Schema.Struct({ interval: RevisionNumberSchema });
export type DevicePollPending = typeof DevicePollPendingSchema.Type;
export const DevicePollSuccessSchema = Schema.Struct({ accountId: IdSchema, login: DisplayNameSchema, machineId: IdSchema, token: MachineTokenSchema, defaultPolicy: PolicySchema }).check(Schema.makeFilter((body) => {
  const [, accountId, machineId] = body.token.split('_');
  return body.accountId === accountId && body.machineId === machineId;
}));
export type DevicePollSuccess = typeof DevicePollSuccessSchema.Type;
