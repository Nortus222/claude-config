import { Schema } from 'effect';
import type { StatusError } from '../job.ts';
import { POLICIES } from '../policy-values.ts';

// Shared v3 result schemas. Keep wire behavior independent of either transport.
export const MAX_EXCLUDED = 10_000;
export const MAX_KEY_LENGTH = 500;
export const MAX_HISTORY = 500;
export const IdSchema = Schema.String.check(Schema.isBetweenLength(1, 100));
export const KeySchema = Schema.String.check(Schema.isBetweenLength(1, MAX_KEY_LENGTH));
export const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Id = IdSchema;
const Count = CountSchema;
const Policy = Schema.Literals(POLICIES);
const STATUS_ERRORS = ['PROFILE_INVALID', 'DECISIONS_INVALID', 'REVISION_UNAVAILABLE', 'JOB_FAILED'] as const satisfies ReadonlyArray<StatusError>;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const IsoTime = Schema.String.check(Schema.makeFilter((s: string) =>
  ISO_TIME_PATTERN.test(s) && !Number.isNaN(Date.parse(s)),
  { toJsonSchema: () => [{ pattern: ISO_TIME_PATTERN.source }, true] }));
export const HistoryCursorSchema = Schema.Struct({
  at: IsoTime,
  seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});
export const WirePausedSchema = Schema.NullOr(Schema.Struct({ reason: Schema.String, at: Schema.String }));

const Domain = Schema.Literals(['config', 'integrations', 'skills']);
const Origin = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String });

export const ObservedSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  // Absent for an agent-neutral item (a shared skill).
  target: Schema.optionalKey(Schema.Literals(['claude', 'codex'])),
  label: Schema.String,
  group: Schema.String,
  state: Schema.String,
  disposition: Schema.Literals(['in-sync', 'apply', 'capture', 'blocked', 'excluded', 'undeclared']),
  note: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Origin),
});
export const IssueSchema = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: Schema.String, path: Schema.String, message: Schema.String });
export const ProfileSchema = Schema.Struct({ repo: Schema.String, revision: Schema.NullOr(Schema.String), overrides: Schema.String, issues: Schema.Array(IssueSchema) });

export const StepSchema = Schema.Struct({
  key: Schema.String,
  domain: Domain,
  action: Schema.Literals(['write-file', 'merge-keys', 'restore', 'remove', 'capture-file', 'write-manifest', 'install-integration', 'install-skills', 'update-skills']),
  summary: Schema.String,
  touches: Schema.Array(Schema.String),
  interruptible: Schema.Boolean,
  targets: Schema.optionalKey(Schema.Array(Schema.Literals(['claude', 'codex']))),
});
export const PlanSchema = Schema.Struct({
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
export const ProgressSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('started'), index: Count, total: Count, step: StepSchema }),
  Schema.Struct({ type: Schema.Literal('finished'), index: Count, total: Count, key: Schema.String, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Schema.String }),
  Schema.Struct({ type: Schema.Literal('done'), ok: Count, failed: Count, backups: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('cancelled'), remaining: Schema.Array(Schema.String), backups: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('failed'), message: Schema.String }),
]);
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
