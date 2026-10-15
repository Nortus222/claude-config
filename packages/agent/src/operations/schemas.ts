import { Effect, Schema } from 'effect';
import { POLICIES } from '../policy-values.ts';
import { CountSchema, PlanSchema, InspectResultSchema, MAX_EXCLUDED, MAX_HISTORY, MAX_KEY_LENGTH } from './wire.ts';

// Operation string limits count Unicode code points, as JSON Schema does.
export const OperationIdSchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(100));
export const OperationKeySchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(MAX_KEY_LENGTH));
const IdSchema = OperationIdSchema;
const KeySchema = OperationKeySchema;
const YEAR = '[0-9]{4}';
const LEAP_YEAR = '(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)';
const DATE = `(?:${YEAR}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|${LEAP_YEAR}-02-29)`;
// Calendar dates, hours 00–23, and offsets 00:00–23:59. The end assertion rejects a trailing newline.
export const OperationTimeSchema = Schema.String.check(Schema.isPattern(new RegExp(
  String.raw`^${DATE}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])(?![\s\S])`, 'u',
)));
export const OperationHistoryCursorSchema = Schema.Struct({
  at: OperationTimeSchema,
  seq: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
});

export const OperationScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('machine') }),
  Schema.Struct({ kind: Schema.Literal('user') }),
  Schema.Struct({ kind: Schema.Literal('profile'), profileId: IdSchema }),
]);
export const CapabilityStateSchema = Schema.Struct({ available: Schema.Boolean, reason: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(500))) });
export const ReconcileChangeSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), only: Schema.Array(KeySchema).check(Schema.isMaxLength(MAX_EXCLUDED)) });
const SkillSourceSchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(202), Schema.isPattern(/^[a-z0-9._-]+\/[a-z0-9._-]+$(?![\s\S])/u));
const SkillNameSchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255), Schema.isPattern(/^(?![.-])(?!.*--)[a-z0-9._-]+(?<![.-])$(?![\s\S])/u));
const SkillTargetsSchema = Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMinLength(1), Schema.isMaxLength(2));
const SkillRevisionSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$(?![\s\S])/u));
export const AddSkillChangeSchema = Schema.Struct({ kind: Schema.Literal('addSkill'), candidateId: IdSchema, targets: SkillTargetsSchema });
export const ChangeSchema = Schema.Union([ReconcileChangeSchema, AddSkillChangeSchema]);
export const SkillCandidateSchema = Schema.Struct({ candidateId: IdSchema, source: SkillSourceSchema, revision: SkillRevisionSchema,
  sourceDir: KeySchema, selectorName: Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255)), installedName: SkillNameSchema,
  description: Schema.String.check(Schema.isMaxCodePoints(500)), internal: Schema.Boolean });
export const SkillCandidateResultSchema = Schema.Struct({ knownSources: CountSchema, unsupportedSources: CountSchema, limit: Schema.optionalKey(Schema.Literals(['source-inventory', 'unsupported-source-inventory', 'candidate-count', 'candidate-path', 'result-bytes', 'candidate-retention'])), status: Schema.Literals(['found', 'ambiguous', 'not-found', 'unavailable', 'limited']),
  candidates: Schema.Array(SkillCandidateSchema).check(Schema.isMaxLength(32)), searchedSources: Schema.Array(SkillSourceSchema).check(Schema.isMaxLength(8)),
  failures: Schema.Array(Schema.Struct({ source: SkillSourceSchema, reason: Schema.Literals(['invalid-source', 'invalid-revision', 'source-unavailable', 'unsupported-layout', 'unsupported-metadata', 'ambiguous-selection', 'limit-exceeded', 'timed-out', 'cleanup-failed']), retainedDirectory: Schema.optionalKey(KeySchema) })).check(Schema.isMaxLength(8)),
  limits: Schema.Struct({ sources: Schema.Literal(8), sourceTimeoutMs: Schema.Literal(15000), candidateLifetimeMs: Schema.Literal(600000), retainedCandidates: Schema.Literal(32), concurrentLookups: Schema.Literal(2), resultBytes: Schema.Literal(32768), deadlineMs: Schema.Literal(20000) }) });
const SkillDeclarationSchema = Schema.Struct({ source: SkillSourceSchema, name: SkillNameSchema, targets: SkillTargetsSchema, revision: Schema.optionalKey(SkillRevisionSchema) });
export const SkillAdditionPreviewSchema = Schema.Struct({ candidate: SkillCandidateSchema,
  declaration: Schema.Struct({ before: Schema.Array(SkillDeclarationSchema).check(Schema.isMaxLength(32)), after: SkillDeclarationSchema, changed: Schema.Boolean }),
  enablement: Schema.optionalKey(Schema.Struct({ before: Schema.Literal(false), after: Schema.Literal(true) })),
  installationTargets: SkillTargetsSchema, sharedStore: Schema.Struct({ codexScans: Schema.Literal(true), visibility: Schema.Literal('shared') }),
  pinImpact: Schema.Struct({ policy: Schema.Literals(['source-pin', 'personal-pin', 'upstream']), revision: SkillRevisionSchema, affectedSkills: Schema.Array(KeySchema).check(Schema.isMaxLength(256)) }),
  nativeVerification: Schema.Literal('required') });
export const NextActionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('share_with_my_machines'), capability: CapabilityStateSchema, requiredDestination: Schema.Literal('user'), destinationId: Schema.optionalKey(IdSchema) }),
  Schema.Struct({ kind: Schema.Literal('promote_to_profile'), capability: CapabilityStateSchema, requiredDestination: Schema.Literal('profile'), destinationId: Schema.optionalKey(IdSchema) }),
]);
const Text = Schema.String.check(Schema.isMaxCodePoints(500));
const Version = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(100));
const Protocol = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }));
const list = <S extends Schema.Constraint>(schema: S) => Schema.Array(schema).check(Schema.isMaxLength(MAX_EXCLUDED));
const availability = <S extends Schema.Constraint>(item: S) => Schema.Union([
  Schema.Struct({ state: Schema.Literal('available'), items: list(item) }),
  Schema.Struct({ state: Schema.Literals(['unknown', 'unavailable']), reason: Text }),
]);
export const CAPABILITY_NAMES = ['getContext', 'inspect', 'previewChange', 'applyChange', 'getRun', 'listRuns', 'cancelRun', 'history', 'resolveSkillCandidate', 'addSkill', 'shareWithMyMachines', 'promoteToProfile'] as const;
const capabilityFields = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, CapabilityStateSchema])) as { readonly [K in typeof CAPABILITY_NAMES[number]]: typeof CapabilityStateSchema };
export const ContextResultSchema = Schema.Struct({
  app: Schema.Struct({ ownership: Schema.NullOr(Schema.Literals(['app', 'cli'])), version: Schema.NullOr(Version), runtimeId: Schema.NullOr(IdSchema) }),
  agent: Schema.Struct({ version: Version, protocol: Protocol }),
  targets: Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMaxLength(2)),
  setups: availability(Schema.Struct({ setupId: IdSchema, trusted: Schema.Boolean, revision: Schema.NullOr(Schema.Union([Version, CountSchema])) })),
  profiles: availability(Schema.Struct({ profileId: IdSchema, name: Text, owned: Schema.Boolean })),
  account: Schema.Union([
    Schema.Struct({ state: Schema.Literal('signed-in'), accountId: IdSchema }),
    Schema.Struct({ state: Schema.Literals(['signed-out', 'unauthenticated']) }),
    Schema.Struct({ state: Schema.Literals(['unknown', 'unavailable']), reason: Text }),
  ]),
  policy: Schema.Literals(POLICIES),
  paused: Schema.NullOr(Schema.Struct({ reason: Text, at: Text })),
  scopes: Schema.Struct({ machine: CapabilityStateSchema, user: CapabilityStateSchema, profile: CapabilityStateSchema }),
  capabilities: Schema.Struct(capabilityFields), diagnostics: Schema.Array(Text).check(Schema.isMaxLength(100)),
});
const previewFields = { planId: IdSchema, scope: OperationScopeSchema,
  generation: IdSchema, plan: PlanSchema, nextActions: Schema.Array(NextActionSchema).check(Schema.isMaxLength(2)) };
export const ReconcilePreviewSchema = Schema.Struct({ ...previewFields, change: ReconcileChangeSchema, skillAddition: Schema.optionalKey(Schema.Never) });
export const AddSkillPreviewSchema = Schema.Struct({ ...previewFields, change: AddSkillChangeSchema, skillAddition: SkillAdditionPreviewSchema });
export const ChangePreviewSchema = Schema.Union([ReconcilePreviewSchema, AddSkillPreviewSchema]);
export const StepOutcomeSchema = Schema.Struct({ key: KeySchema, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Text });
export const RunTerminalResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('done'), ok: CountSchema, failed: CountSchema }),
  Schema.Struct({ status: Schema.Literal('cancelled'), remaining: list(KeySchema) }),
  Schema.Struct({ status: Schema.Literals(['failed', 'interrupted']), message: Text }),
]);
export const RunViewSchema = Schema.Struct({
  runId: IdSchema, state: Schema.Literals(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  operation: Schema.Literal('applyChange'), scope: OperationScopeSchema,
  intent: Schema.Struct({ requestId: IdSchema, inputDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)), planId: IdSchema, change: ReconcileChangeSchema }),
  // Reconciliation changes installed state without saving a new declaration.
  intentSaved: Schema.Boolean, steps: list(StepOutcomeSchema), result: Schema.NullOr(RunTerminalResultSchema),
});
export const ApplyChangeResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('started'), run: RunViewSchema }),
  Schema.Struct({ status: Schema.Literal('stale'), preview: ChangePreviewSchema }),
]);
export const RunListResultSchema = Schema.Struct({ runs: Schema.Array(RunViewSchema).check(Schema.isMaxLength(MAX_HISTORY)), nextBefore: Schema.NullOr(IdSchema) });
export const OperationHistoryEventSchema = Schema.Struct({
  kind: Version, at: Text, actor: Schema.Literals(['agent', 'cli', 'app', 'sync', 'mcp']),
  operation: Schema.optionalKey(Schema.Literal('applyChange')), scope: Schema.optionalKey(OperationScopeSchema),
  requestId: Schema.optionalKey(IdSchema), runId: Schema.optionalKey(IdSchema),
  keys: Schema.optionalKey(list(KeySchema)), steps: Schema.optionalKey(list(StepOutcomeSchema)), message: Schema.optionalKey(Text),
});
export const OperationHistoryResultSchema = Schema.Struct({ events: Schema.Array(OperationHistoryEventSchema).check(Schema.isMaxLength(MAX_HISTORY)), nextBefore: Schema.NullOr(OperationHistoryCursorSchema) });
const scope = OperationScopeSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ kind: 'machine' } as const)));
const limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_HISTORY }));
export const GetContextInputSchema = Schema.Struct({ scope });
export const InspectInputSchema = Schema.Struct({ scope });
export const PreviewChangeInputSchema = Schema.Struct({ scope, change: ChangeSchema });
export const ResolveSkillCandidateInputSchema = Schema.Struct({ scope, source: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(250))), name: Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255)) });
export const ApplyChangeInputSchema = Schema.Struct({ scope, planId: IdSchema, requestId: IdSchema });
export const GetRunInputSchema = Schema.Struct({ scope, runId: IdSchema });
export const ListRunsInputSchema = Schema.Struct({ scope, before: Schema.optionalKey(IdSchema), limit });
export const CancelRunInputSchema = Schema.Struct({ scope, runId: IdSchema });
export const HistoryInputSchema = Schema.Struct({ scope, before: Schema.optionalKey(OperationHistoryCursorSchema), limit });
export { InspectResultSchema };
const strict = { onExcessProperty: 'error' } as const;
export const decodeOperationScope = Schema.decodeUnknownSync(OperationScopeSchema, strict);
export const decodeContextResult = Schema.decodeUnknownSync(ContextResultSchema, strict);
export const decodeChangePreview = Schema.decodeUnknownSync(ChangePreviewSchema, strict);
export const decodeRunView = Schema.decodeUnknownSync(RunViewSchema, strict);
export const decodeNextAction = Schema.decodeUnknownSync(NextActionSchema, strict);
