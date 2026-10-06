import { Schema } from 'effect';

// Protocol v2: JSON lines between the Rust host and the backend. The renderer reaches it only
// through Rust's allow-list, and every argument is an opaque key or id, never a path or command.
export const PROTOCOL_VERSION = 2;
export const MAX_RECORD_BYTES = 1_048_576;
export const MAX_EXCLUDED = 10_000;
export const MAX_KEY_LENGTH = 500;

export type ErrorCode =
  | 'INVALID_REQUEST' | 'MALFORMED' | 'OVERSIZED' | 'SHUTDOWN' | 'BUSY' | 'LOCKED' | 'NO_REPORT' | 'UNKNOWN_KEY'
  | 'UNKNOWN_PLAN' | 'PROFILE_INVALID' | 'REPO_NOT_FOUND' | 'INSPECT_FAILED' | 'INTERNAL';

const Version = Schema.Literal(PROTOCOL_VERSION);
const Id = Schema.String.check(Schema.isBetweenLength(1, 100));
const Key = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const RequestSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, command: Schema.Literals(['inspect', 'cancel', 'shutdown']) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('preview'), exclude: Schema.Array(Key).check(Schema.isMaxLength(MAX_EXCLUDED)) }),
  Schema.Struct({ version: Version, id: Id, command: Schema.Literal('apply'), planId: Id }),
]);

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
export const InspectResultSchema = Schema.Struct({ profile: ProfileSchema, items: Schema.Array(ObservedSchema), probeErrors: Schema.Array(Schema.String) });

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

export const ResponseSchema = Schema.Union([
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({ version: Version, id: Id, ok: Schema.Literal(false), error: Schema.Struct({ code: Id, message: Schema.String.check(Schema.isMaxLength(500)) }) }),
]);

const strict = { onExcessProperty: 'error' } as const;
export const decodeRequest = Schema.decodeUnknownSync(RequestSchema, strict);
export const decodeMessage = Schema.decodeUnknownSync(Schema.Union([RunEventSchema, ResponseSchema]), strict);
export const decodeInspectResult = Schema.decodeUnknownSync(InspectResultSchema, strict);
export const decodePreviewResult = Schema.decodeUnknownSync(PreviewResultSchema, strict);
export const decodeApplyResult = Schema.decodeUnknownSync(ApplyResultSchema, strict);

export type Request = typeof RequestSchema.Type;
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
export type Response = typeof ResponseSchema.Type;
