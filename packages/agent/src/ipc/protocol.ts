import { IdSchema as Id, KeySchema as Key, MAX_EXCLUDED, MAX_KEY_LENGTH, MAX_HISTORY, HistoryCursorSchema, WirePausedSchema, ObservedSchema, IssueSchema, ProfileSchema, StepSchema, PlanSchema, PreviewResultSchema, ApplyResultSchema, ProgressSchema, WireStatusSchema, InspectResultSchema } from '../operations/wire.ts';
export { MAX_EXCLUDED, MAX_KEY_LENGTH, MAX_HISTORY, HistoryCursorSchema, WirePausedSchema, ObservedSchema, IssueSchema, ProfileSchema, StepSchema, PlanSchema, PreviewResultSchema, ApplyResultSchema, ProgressSchema, WireStatusSchema, InspectResultSchema } from '../operations/wire.ts';
import { DeviceStartResponseSchema, DisplayNameSchema, IdSchema as HostedId, ItemIdSchema as HostedItemId, RevisionNumberSchema, SyncSetupSchema, SyncMachineSchema, MachinePatchSchema, IsoTimeSchema as HostedTime } from '@nortuscc/hosted-protocol';
import { HOSTED_FAILURE_CODES } from '@nortuscc/hosted-client/transport';
import { operationDefinitions, type OperationName } from '../operations/index.ts';
import { Schema } from 'effect';
import type { HistoryEvent } from '@nortuscc/machine';
import type { AgentStatus } from '../job.ts';
import { POLICIES } from '../policy-values.ts';

// Protocol v3: JSON lines on the agent's socket. It is protocol v2 from the desktop backend,
// unchanged, plus hello, agent commands and status events. Shared operations use an additive
// envelope with operationsProtocol 1; legacy requests and replies retain their v3 shapes.
// Legacy arguments are opaque keys, ids and enums. Skill discovery adds a validated public source
// identity, never a caller-selected filesystem path or command.
export const PROTOCOL_VERSION = 3;
export const MAX_RECORD_BYTES = 1_048_576;
export const MAX_DECISIONS = 1000;

export type ErrorCode =
  | 'INVALID_REQUEST' | 'MALFORMED' | 'OVERSIZED' | 'SHUTDOWN' | 'BUSY' | 'LOCKED' | 'NO_REPORT' | 'UNKNOWN_KEY'
  | 'UNKNOWN_PLAN' | 'PROFILE_INVALID' | 'REPO_NOT_FOUND' | 'INSPECT_FAILED' | 'INTERNAL'
  | 'TARGET_UNAVAILABLE' | 'SKILL_INSTALL_UNAVAILABLE' | 'APP_UNAVAILABLE' | 'UNSUPPORTED_SCOPE' | 'UNKNOWN_RUN' | 'REQUEST_CONFLICT' | 'RUN_FAILED' | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'PAUSED' | 'UNKNOWN_BACKUP' | 'BACKUP_PRUNED' | 'NOT_SIGNED_IN';

const Version = Schema.Literal(PROTOCOL_VERSION);
const ItemId = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
// A full SHA-1 or SHA-256 commit, lower-case hex.
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
const NotificationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Receipt = Schema.String.check(Schema.isBetweenLength(1, 200));
export const NotificationSchema = Schema.Struct({ id: NotificationId, title: Schema.String.check(Schema.isMaxLength(100)), body: Schema.String.check(Schema.isMaxLength(500)) });
export const NotificationEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('notification'), notification: NotificationSchema, receipt: Receipt });
export const NotificationResultSchema = Schema.Struct({ notification: Schema.NullOr(NotificationSchema), receipt: Schema.NullOr(Receipt) });
const Client = Schema.Literals(['app', 'cli']);
export const OPERATIONS_PROTOCOL_VERSION = 1;
export type AppRuntime = { readonly version: string; readonly runtimeId: string; readonly appDirectory: string; readonly platform: string; readonly target: string; readonly metadataPath: string };
const AppIdentitySchema = Schema.Struct({ ownership: Schema.NullOr(Schema.Literals(['app', 'cli'])), version: Schema.NullOr(Id), runtimeId: Schema.NullOr(Id) });
const OperationRequestSchema = Schema.Union(Object.entries(operationDefinitions).map(([operation, definition]) => Schema.Struct({
  version: Version, id: Id, command: Schema.Literal('operation'), operation: Schema.Literal(operation as OperationName), input: definition.input,
})));
const Policy = Schema.Literals(POLICIES);

const LocalDecisionSchema = Schema.Struct({
  setupId: Schema.Literal('local'),
  id: ItemId,
  revision: Sha,
  decision: Schema.Literals(['accept', 'skip']),
});

const DecisionSchema = Schema.Union([LocalDecisionSchema, Schema.Struct({ setupId: HostedId, id: HostedItemId, revision: RevisionNumberSchema, decision: Schema.Literals(['accept', 'skip']) })]);

export const RequestSchema = Schema.Union([
  OperationRequestSchema,
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('hello'), token: Schema.String.check(Schema.isBetweenLength(1, 200)), client: Schema.Literal('mcp'), runtimeId: Id }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['hostedState', 'signOut', 'syncNow']) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('signIn'), name: Schema.optionalKey(DisplayNameSchema), reportStatus: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('trustSetup'), setupId: HostedId }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('machineSettings'), patch: MachinePatchSchema }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('notification'), notificationId: NotificationId }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('notificationAck'), notificationId: NotificationId, receipt: Receipt, delivered: Schema.Boolean }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('hello'), token: Schema.String.check(Schema.isBetweenLength(1, 200)), client: Client }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['status', 'inspect', 'cancel', 'resume', 'shutdown']) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('subscribe'), operationsProtocol: Schema.optionalKey(Schema.Literal(OPERATIONS_PROTOCOL_VERSION)) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('preview'), exclude: Schema.Array(Key).check(Schema.isMaxLength(MAX_EXCLUDED)) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('apply'), planId: Id }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('decide'), items: Schema.Array(DecisionSchema).check(Schema.isMaxLength(MAX_DECISIONS)) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('setPolicy'), policy: Policy }),
  Schema.Struct({
    version: Version, id: Id, command: Schema.Literal('history'),
    before: Schema.optionalKey(HistoryCursorSchema),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY })),
  }),
]);

export const HelloResultSchema = Schema.Struct({
  operationsProtocol: Schema.optionalKey(Schema.Literal(OPERATIONS_PROTOCOL_VERSION)),
  app: Schema.optionalKey(AppIdentitySchema),
  operations: Schema.optionalKey(Schema.Struct({ available: Schema.Boolean, reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))) })),
  agentVersion: Schema.String,
  protocol: Version,
  policy: Policy,
  paused: WirePausedSchema,
});

export const OperationRunEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('operation-run'), runId: Id });
export type OperationRunEvent = typeof OperationRunEventSchema.Type;

export const RunEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('progress'), runId: Id, progress: ProgressSchema });

export const decodeWireStatus = Schema.decodeUnknownSync(WireStatusSchema, { onExcessProperty: 'error' });
export const StatusEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('status'), status: WireStatusSchema, runId: Schema.optionalKey(Id) });

export const ResponseSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(false), error: Schema.Struct({ code: Id, message: Schema.String.check(Schema.isMaxLength(500)) }) }),
]);

const strict = { onExcessProperty: 'error' } as const;
const { pendingId: _pendingId, ...signInFields } = DeviceStartResponseSchema.fields;
export const SignInResultSchema = Schema.Struct(signInFields);
export const HostedStateSchema = Schema.Struct({
  enabled: Schema.Boolean, recovered: Schema.Boolean, signingIn: Schema.Boolean,
  accountId: Schema.NullOr(HostedId), login: Schema.NullOr(DisplayNameSchema), machineId: Schema.NullOr(HostedId),
  auth: Schema.Literals(['signed-in', 'signed-out', 'unauthenticated']), setups: Schema.Array(SyncSetupSchema),
  machine: Schema.NullOr(SyncMachineSchema), lastSyncAt: Schema.NullOr(HostedTime), retryAt: Schema.NullOr(HostedTime),
  pollAfter: RevisionNumberSchema, error: Schema.NullOr(Schema.Literals(HOSTED_FAILURE_CODES)),
});
export const decodeSignInResult = Schema.decodeUnknownSync(SignInResultSchema, strict);
// Internal owner metadata must not change the existing app/CLI response contract.
export const toWireHostedState = Schema.decodeUnknownSync(HostedStateSchema, { onExcessProperty: 'ignore' });
export const decodeHostedState = Schema.decodeUnknownSync(HostedStateSchema, strict);
export type WireHostedState = typeof HostedStateSchema.Type;
const decodeRequestSchema = Schema.decodeUnknownSync(RequestSchema, strict);
export const decodeRequest = (input: unknown): Request => decodeRequestSchema(input) as Request;
export const decodeMessage = Schema.decodeUnknownSync(Schema.Union([OperationRunEventSchema, RunEventSchema, StatusEventSchema, NotificationEventSchema, ResponseSchema]), strict);
export const decodeHelloResult = Schema.decodeUnknownSync(HelloResultSchema, strict);
export const decodeInspectResult = Schema.decodeUnknownSync(InspectResultSchema, strict);
export const decodePreviewResult = Schema.decodeUnknownSync(PreviewResultSchema, strict);
export const decodeApplyResult = Schema.decodeUnknownSync(ApplyResultSchema, strict);

export type HistoryCursor = typeof HistoryCursorSchema.Type;
export type HistoryResult = {
  readonly events: ReadonlyArray<HistoryEvent>;
  readonly nextBefore: HistoryCursor | null;
};
export type OperationRequest = { [N in OperationName]: { readonly version: typeof PROTOCOL_VERSION; readonly id: string; readonly command: 'operation'; readonly operation: N; readonly input: import('../operations/index.ts').OperationInput<N> } }[OperationName];
export type Request = Exclude<typeof RequestSchema.Type, { readonly command: 'operation' }> | OperationRequest;
export type WireDecision = typeof DecisionSchema.Type;
export type HelloResult = typeof HelloResultSchema.Type;
export type WireObserved = typeof ObservedSchema.Type;
export type WireStep = typeof StepSchema.Type;
export type WirePlan = typeof PlanSchema.Type;
export type WireIssue = typeof IssueSchema.Type;
export type Profile = typeof ProfileSchema.Type;
export type InspectResult = typeof InspectResultSchema.Type;
export type PreviewResult = typeof PreviewResultSchema.Type;
export type ApplyResult = typeof ApplyResultSchema.Type;
export type RunProgress = typeof ProgressSchema.Type;
export type RunEvent = typeof RunEventSchema.Type;
export type WireStatus = typeof WireStatusSchema.Type;
export type StatusErrorCode = NonNullable<WireStatus['error']>;
export type StatusEvent = typeof StatusEventSchema.Type;
export type Response = typeof ResponseSchema.Type;
export type NotificationEvent = typeof NotificationEventSchema.Type;
export type Message = OperationRunEvent | RunEvent | StatusEvent | NotificationEvent | Response;

// A job's status for clients: verdicts flattened, the pause without its run id, no auto-apply
// outcome, and counts. `ready` counts inert pending items this machine leaves to a person: on
// notify or manual, or on a paused auto-apply.
export const toWireStatus = (status: AgentStatus): WireStatus => {
  const pending = status.pending.map((p) =>
    p.verdict.kind === 'held'
      ? { key: p.key, itemId: p.itemId, verdict: 'held' as const, reason: p.verdict.reason }
      : { key: p.key, itemId: p.itemId, verdict: 'inert' as const });
  const held = pending.filter((p) => p.verdict === 'held').length;
  const autoApplies = status.policy === 'auto-apply' && status.paused === null;
  return {
    at: status.at,
    policy: status.policy,
    paused: status.paused === null ? null : { reason: status.paused.reason, at: status.paused.at },
    trusted: status.trusted,
    pending,
    drift: [...status.drift],
    conflicts: [...status.conflicts],
    probeErrors: [...status.probeErrors],
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...(status.detail !== undefined ? { detail: status.detail } : {}),
    counts: { pending: pending.length, held, ready: autoApplies ? 0 : pending.length - held, drift: status.drift.length },
  };
};
