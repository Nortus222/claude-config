import { Schema } from 'effect';
const Target = Schema.Literals(['codex', 'claude']);
export type ConnectionTarget = typeof Target.Type;
const Routing = Schema.Struct({ status: Schema.Literals(['installed', 'missing', 'released', 'absent', 'unmanaged', 'conflict', 'unavailable']),
  intent: Schema.Literals(['active', 'released', 'unowned', 'invalid', 'unknown']),
  blockStatus: Schema.Literals(['present', 'absent', 'conflict', 'unknown']), offeredText: Schema.String.check(Schema.isMaxLength(8192)) });
export const Connection = Schema.Struct({ target: Target,
  registration: Schema.Literals(['configured', 'absent', 'repair-needed', 'conflict', 'unavailable']),
  routing: Routing, session: Schema.Literal('unobserved'), reload: Schema.Literals(['recommended', 'unknown']),
  observation: Schema.Literal('local-registration'), note: Schema.String.check(Schema.isMaxLength(500)) });
export type ConnectionResult = typeof Connection.Type;
export type ConnectionsState = { connections: readonly ConnectionResult[] };
const State = Schema.Struct({ connections: Schema.Array(Connection).check(Schema.isMaxLength(2)) });
export const decodeConnections = Schema.decodeUnknownSync(State, { onExcessProperty: 'error' });
export const decodeConnectionAction = Schema.decodeUnknownSync(Schema.Union([
  Schema.Struct({ action: Schema.Literal('inspect') }),
  Schema.Struct({ action: Schema.Literals(['connect', 'disconnect']), target: Target }),
]), { onExcessProperty: 'error' });
