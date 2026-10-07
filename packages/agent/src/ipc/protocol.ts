import { DeviceStartResponseSchema, DisplayNameSchema, IdSchema as HostedId, ItemIdSchema as HostedItemId, RevisionNumberSchema, SyncSetupSchema, SyncMachineSchema, MachinePatchSchema, IsoTimeSchema as HostedTime } from '@nortuscc/hosted-protocol';
import { HOSTED_FAILURE_CODES } from '@nortuscc/hosted-client/transport';
import { Schema } from 'effect';
import type { HistoryEvent } from '@nortuscc/machine';
import type { AgentStatus, StatusError } from '../job.ts';
import { POLICIES } from '../policy-values.ts';

// Protocol v3: JSON lines on the agent's socket. It is protocol v2 from the desktop backend,
// unchanged, plus the `hello` handshake, the agent's own commands and status events. Every
// argument is an opaque key, id or enum, never a path, command line or URL.
export const PROTOCOL_VERSION = 3;
export const MAX_RECORD_BYTES = 1_048_576;
export const MAX_EXCLUDED = 10_000;
export const MAX_KEY_LENGTH = 500;
export const MAX_DECISIONS = 1000;
export const MAX_HISTORY = 500;

export type ErrorCode =
  | 'INVALID_REQUEST' | 'MALFORMED' | 'OVERSIZED' | 'SHUTDOWN' | 'BUSY' | 'LOCKED' | 'NO_REPORT' | 'UNKNOWN_KEY'
  | 'UNKNOWN_PLAN' | 'PROFILE_INVALID' | 'REPO_NOT_FOUND' | 'INSPECT_FAILED' | 'INTERNAL'
  | 'UNAUTHORIZED' | 'PAUSED' | 'UNKNOWN_BACKUP' | 'BACKUP_PRUNED' | 'NOT_SIGNED_IN';

const Version = Schema.Literal(PROTOCOL_VERSION);
const Id = Schema.String.check(Schema.isBetweenLength(1, 100));
const Key = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
const ItemId = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
// A full SHA-1 or SHA-256 commit, lower-case hex.
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));
const IsoTime = Schema.String.check(Schema.makeFilter((s: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))));
export const HistoryCursorSchema = Schema.Struct({
  at: IsoTime,
  seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
const NotificationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Receipt = Schema.String.check(Schema.isBetweenLength(1, 200));
export const NotificationSchema = Schema.Struct({ id: NotificationId, title: Schema.String.check(Schema.isMaxLength(100)), body: Schema.String.check(Schema.isMaxLength(500)) });
export const NotificationEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('notification'), notification: NotificationSchema, receipt: Receipt });
export const NotificationResultSchema = Schema.Struct({ notification: Schema.NullOr(NotificationSchema), receipt: Schema.NullOr(Receipt) });
const Client = Schema.Literals(['app', 'cli']);
const Policy = Schema.Literals(POLICIES);
const STATUS_ERRORS = ['PROFILE_INVALID', 'DECISIONS_INVALID', 'REVISION_UNAVAILABLE', 'JOB_FAILED'] as const satisfies ReadonlyArray<StatusError>;

const LocalDecisionSchema = Schema.Struct({
  setupId: Schema.Literal('local'),
  id: ItemId,
  revision: Sha,
  decision: Schema.Literals(['accept', 'skip']),
});

const DecisionSchema = Schema.Union([LocalDecisionSchema, Schema.Struct({ setupId: HostedId, id: HostedItemId, revision: RevisionNumberSchema, decision: Schema.Literals(['accept', 'skip']) })]);

export const RequestSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['hostedState', 'signOut', 'syncNow']) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('signIn'), name: Schema.optionalKey(DisplayNameSchema) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('trustSetup'), setupId: HostedId }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('machineSettings'), patch: MachinePatchSchema }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('notification'), notificationId: NotificationId }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('notificationAck'), notificationId: NotificationId, receipt: Receipt, delivered: Schema.Boolean }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('hello'), token: Schema.String.check(Schema.isBetweenLength(1, 200)), client: Client }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['status', 'inspect', 'cancel', 'resume', 'shutdown', 'subscribe']) }),
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

const WirePausedSchema = Schema.NullOr(Schema.Struct({ reason: Schema.String, at: Schema.String }));

export const HelloResultSchema = Schema.Struct({
  agentVersion: Schema.String,
  protocol: Version,
  policy: Policy,
  paused: WirePausedSchema,
});

const Domain = Schema.Literals(['config', 'integrations', 'skills']);
const Origin = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String });

export const ObservedSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  // Absent for an agent-neutral item (a shared skill).
  target: Schema.optional(Schema.Literals(['claude', 'codex'])),
  label: Schema.String,
  group: Schema.String,
  state: Schema.String,
  disposition: Schema.Literals(['in-sync', 'apply', 'capture', 'blocked', 'excluded', 'undeclared']),
  note: Schema.optional(Schema.String),
  from: Schema.optional(Origin),
});
const IssueSchema = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String, path: Schema.String, message: Schema.String });
const ProfileSchema = Schema.Struct({ repo: Schema.String, revision: Schema.NullOr(Schema.String), overrides: Schema.String, issues: Schema.Array(IssueSchema) });

const StepSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  action: Schema.Literals(['write-file', 'merge-keys', 'restore', 'remove', 'capture-file', 'write-manifest', 'install-integration', 'install-skills', 'update-skills']),
  summary: Schema.String,
  touches: Schema.Array(Schema.String),
  interruptible: Schema.Boolean,
  targets: Schema.optional(Schema.Array(Schema.Literals(['claude', 'codex']))),
});
const PlanSchema = Schema.Struct({
  kind: Schema.Literals(['apply', 'uninstall', 'capture', 'update']),
  steps: Schema.Array(StepSchema),
  skipped: Schema.Array(Schema.Struct({ key: Schema.String, reason: Schema.String })),
});
export const PreviewResultSchema = Schema.Struct({ planId: Id, plan: PlanSchema });
export const ApplyResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('started'), runId: Id }),
  // The machine changed since the preview: nothing ran, and this is the new preview.
  Schema.Struct({ status: Schema.Literal('stale'), planId: Id, plan: PlanSchema }),
]);

// @nortuscc/machine's Progress, plus `failed`: the run could not start or stopped on a defect.
const ProgressSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('started'), index: Count, total: Count, step: StepSchema }),
  Schema.Struct({ type: Schema.Literal('finished'), index: Count, total: Count, key: Schema.String, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Schema.String }),
  Schema.Struct({ type: Schema.Literal('done'), ok: Count, failed: Count, backups: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('cancelled'), remaining: Schema.Array(Schema.String), backups: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('failed'), message: Schema.String }),
]);
export const RunEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('progress'), runId: Id, progress: ProgressSchema });

// The agent's last job status, as clients see it.
export const WireStatusSchema = Schema.Struct({
  at: Schema.String,
  policy: Policy,
  paused: WirePausedSchema,
  trusted: Schema.Boolean,
  applying: Schema.optionalKey(Schema.Boolean),
  pending: Schema.Array(Schema.Struct({
    key: Schema.String,
    itemId: Schema.String,
    verdict: Schema.Literals(['inert', 'held']),
    reason: Schema.optionalKey(Schema.String),
  })),
  drift: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.String),
  probeErrors: Schema.Array(Schema.String),
  error: Schema.optionalKey(Schema.Literals(STATUS_ERRORS)),
  detail: Schema.optionalKey(Schema.String),
  counts: Schema.Struct({ pending: Count, held: Count, ready: Count, drift: Count }),
});
export const InspectResultSchema = Schema.Struct({ profile: ProfileSchema, items: Schema.Array(ObservedSchema), probeErrors: Schema.Array(Schema.String), status: Schema.optionalKey(WireStatusSchema) });
export const decodeWireStatus = Schema.decodeUnknownSync(WireStatusSchema, { onExcessProperty: 'error' });
export const StatusEventSchema = Schema.Struct({ version: Version, event: Schema.Literal('status'), status: WireStatusSchema });

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
export const decodeHostedState = Schema.decodeUnknownSync(HostedStateSchema, strict);
export type WireHostedState = typeof HostedStateSchema.Type;
export const decodeRequest = Schema.decodeUnknownSync(RequestSchema, strict);
export const decodeMessage = Schema.decodeUnknownSync(Schema.Union([RunEventSchema, StatusEventSchema, NotificationEventSchema, ResponseSchema]), strict);
export const decodeHelloResult = Schema.decodeUnknownSync(HelloResultSchema, strict);
export const decodeInspectResult = Schema.decodeUnknownSync(InspectResultSchema, strict);
export const decodePreviewResult = Schema.decodeUnknownSync(PreviewResultSchema, strict);
export const decodeApplyResult = Schema.decodeUnknownSync(ApplyResultSchema, strict);

export type HistoryCursor = typeof HistoryCursorSchema.Type;
export type HistoryResult = {
  readonly events: ReadonlyArray<HistoryEvent>;
  readonly nextBefore: HistoryCursor | null;
};
export type Request = typeof RequestSchema.Type;
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
export type Message = RunEvent | StatusEvent | NotificationEvent | Response;

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
