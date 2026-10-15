import { Effect, Schema, SchemaGetter } from 'effect';
import { intentValueProblem } from '@nortuscc/profile-engine/intent-value';
import { POLICIES } from '../policy-values.ts';
import { CountSchema, PlanSchema, StepSchema, ProgressSchema, InspectResultSchema, MAX_EXCLUDED, MAX_HISTORY, MAX_KEY_LENGTH } from './wire.ts';

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
const ActionTargetsSchema = Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMaxLength(2));
const actionSelection = { only: Schema.Array(KeySchema).check(Schema.isMaxLength(MAX_EXCLUDED)), targets: Schema.optionalKey(ActionTargetsSchema), force: Schema.optionalKey(Schema.Boolean) };
export const ReconcileChangeSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), ...actionSelection, declined: Schema.optionalKey(Schema.Array(Schema.Literals(['hooks', 'mcp', 'plugins', 'skills'])).check(Schema.isMaxLength(4))) });
export const UpdateChangeSchema = Schema.Struct({ kind: Schema.Literal('update'), only: actionSelection.only, targets: Schema.optionalKey(ActionTargetsSchema), declined: Schema.optionalKey(Schema.Array(Schema.Literals(['hooks', 'mcp', 'plugins', 'skills'])).check(Schema.isMaxLength(4))), authorManifest: Schema.Boolean });
export const CaptureChangeSchema = Schema.Struct({ kind: Schema.Literal('capture'), only: actionSelection.only, targets: Schema.optionalKey(ActionTargetsSchema), takeLocal: Schema.Boolean, allowShrink: Schema.Boolean, manageConfig: Schema.optionalKey(Schema.Boolean) });
export const UninstallConfigChangeSchema = Schema.Struct({ kind: Schema.Literal('uninstallConfig'), ...actionSelection });
const SkillSourceSchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(202), Schema.isPattern(/^[a-z0-9._-]+\/[a-z0-9._-]+$(?![\s\S])/u));
const SkillNameSchema = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255), Schema.isPattern(/^(?![.-])(?!.*--)[a-z0-9._-]+(?<![.-])$(?![\s\S])/u));
const SkillTargetsSchema = Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMinLength(1), Schema.isMaxLength(2));
const SkillRevisionSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$(?![\s\S])/u));
export const AddSkillChangeSchema = Schema.Struct({ kind: Schema.Literal('addSkill'), candidateId: IdSchema, targets: SkillTargetsSchema });
// Validation walks bounded JSON iteratively before the owner's recursive secret checks.
export const IntentValueSchema = Schema.declare((value): value is unknown => intentValueProblem(value) === undefined, {
  toCodecJson: () => Schema.link<unknown>()(Schema.Json.annotate({ description: 'Finite JSON; UTF-8 JSON <=32768 bytes, depth <=16, nodes <=4096. Limits are checked before recursive validation.' }), { decode: SchemaGetter.transform((value: Schema.Json): unknown => value), encode: SchemaGetter.transform((value: unknown) => value as Schema.Json) }),
});
const PatchId = Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(500));
export const MachineIntentPatchSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('setting'), fileId: PatchId, key: PatchId, action: Schema.Literal('set'), value: IntentValueSchema }),
  Schema.Struct({ kind: Schema.Literal('setting'), fileId: PatchId, key: PatchId, action: Schema.Literal('reset') }),
  Schema.Struct({ kind: Schema.Literal('manageConfig'), action: Schema.Literal('set'), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('manageConfig'), action: Schema.Literal('reset') }),
  Schema.Struct({ kind: Schema.Literal('configTargets'), action: Schema.Literal('set'), value: Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMaxLength(2)) }),
  Schema.Struct({ kind: Schema.Literal('configTargets'), action: Schema.Literal('reset') }),
  Schema.Struct({ kind: Schema.Literal('skill'), source: SkillSourceSchema, name: SkillNameSchema, action: Schema.Literals(['enable', 'disable', 'reset']) }),
  Schema.Struct({ kind: Schema.Literal('integration'), id: PatchId, action: Schema.Literals(['enable', 'disable', 'reset']) }),
  Schema.Struct({ kind: Schema.Literal('removeSkillDeclaration'), source: SkillSourceSchema, name: SkillNameSchema }),
]);
export const MachineIntentChangeSchema = Schema.Struct({ kind: Schema.Literal('machineIntent'), patch: MachineIntentPatchSchema });
const SyncCommitSchema = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$(?![\s\S])/u));
export const SyncRevisionIdentitySchema = Schema.Union([Schema.Struct({kind:Schema.Literal('local'),commit:SyncCommitSchema}),Schema.Struct({kind:Schema.Literal('hosted'),number:Schema.Int.check(Schema.isBetween({minimum:1,maximum:Number.MAX_SAFE_INTEGER})),commitSha:SyncCommitSchema})]);
export const SyncDecisionChangeSchema = Schema.Struct({kind:Schema.Literal('syncDecision'),setupId:IdSchema,revision:SyncRevisionIdentitySchema,itemId:KeySchema,action:Schema.Literals(['accept','hold','release','takeTheirs'])});
export const ChangeSchema = Schema.Union([SyncDecisionChangeSchema, ReconcileChangeSchema, UninstallConfigChangeSchema, UpdateChangeSchema, CaptureChangeSchema, AddSkillChangeSchema, MachineIntentChangeSchema]);
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
export const CAPABILITY_NAMES = ['getContext', 'inspect', 'inspectIntent', 'inspectUpdates', 'inspectSetups', 'incomingChanges', 'prepareTrustRequest', 'syncDecision', 'machineIntent', 'previewChange', 'applyChange', 'getRun', 'listRuns', 'cancelRun', 'history', 'resolveSkillCandidate', 'addSkill', 'shareWithMyMachines', 'promoteToProfile'] as const;
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
const semanticFields = { key: KeySchema, summary: Text, touches: list(KeySchema), interruptible: Schema.Boolean };
export const OperationStepSchema = Schema.Union([
  StepSchema,
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('intent'), action: Schema.Literal('save-intent') }),
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('sync'), action: Schema.Literal('save-decision') }),
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('sources'), action: Schema.Literal('edit-source') }),
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('agent'), action: Schema.Literals(['set-policy', 'resume']) }),
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('account'), action: Schema.Literals(['sign-in', 'sign-out', 'sync-account', 'patch-machine']) }),
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('backups'), action: Schema.Literal('prune-backups') }),
]);
export const OperationPlanSchema = Schema.Union([PlanSchema, Schema.Struct({ kind: Schema.Literal('operation'), steps: list(OperationStepSchema), skipped: list(Schema.Struct({ key: KeySchema, reason: Text })) })]);
export const OperationProgressSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('started'), index: CountSchema, total: CountSchema, step: OperationStepSchema }),
  ...ProgressSchema.members.slice(1),
]);
const DigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$(?![\s\S])/u));
const parityAcceptanceFields = { generation: IdSchema, baselineDigest: DigestSchema, planDigest: DigestSchema, plannedKeys: list(KeySchema) };
const ReconcileAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), ...parityAcceptanceFields });
const UninstallAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('uninstallConfig'), ...parityAcceptanceFields });
const IntentAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('machineIntent'), ...parityAcceptanceFields });
const AuthorHeadSchema = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u));
const AuthorEvidenceSchema = Schema.Struct({ checkout: Text, realCheckout: Text, gitDir: Text, head: AuthorHeadSchema,
  files: Schema.Array(Schema.Struct({ path: Text, kind: Schema.Literals(['absent', 'file']), sha256: Schema.NullOr(DigestSchema), indexBlob: Schema.NullOr(DigestSchema) })).check(Schema.isMaxLength(100)) });
const CaptureAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('capture'), ...parityAcceptanceFields, author: AuthorEvidenceSchema });
const UpdateAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('update'), ...parityAcceptanceFields, author: Schema.optionalKey(AuthorEvidenceSchema) });
const SyncAcceptanceSchema = Schema.Struct({kind:Schema.Literal('syncDecision'),...parityAcceptanceFields});
export const ParityAcceptanceSchema = Schema.Union([SyncAcceptanceSchema, ReconcileAcceptanceSchema, UninstallAcceptanceSchema, CaptureAcceptanceSchema, UpdateAcceptanceSchema, IntentAcceptanceSchema]);
const parityEvidenceFields = { state: Schema.Literals(['pending', 'committed', 'partial', 'needsInspection']), committedKeys: list(KeySchema), remainingKeys: list(KeySchema), backupIds: list(IdSchema) };
const ReconcileEvidenceSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), ...parityEvidenceFields });
const UninstallEvidenceSchema = Schema.Struct({ kind: Schema.Literal('uninstallConfig'), ...parityEvidenceFields });
const RoutingEffectSchema = Schema.Union([
  Schema.Struct({ fileId: Schema.Literals(['claude:CLAUDE.md', 'codex:AGENTS.md']), state: Schema.Literal('needsInspection') }),
  Schema.Struct({ fileId: Schema.Literals(['claude:CLAUDE.md', 'codex:AGENTS.md']), state: Schema.Literal('observed'), intentChanged: Schema.Boolean, instructionsChanged: Schema.Boolean, outcome: Schema.Literals(['changed', 'unchanged', 'conflict', 'unmanaged']) }),
]);
const IntentEvidenceSchema = Schema.Struct({ kind: Schema.Literal('machineIntent'), ...parityEvidenceFields, intentState: Schema.Literals(['pending', 'saved', 'needsInspection']), routingEffects: Schema.Array(RoutingEffectSchema).check(Schema.isMaxLength(2)) });
const CaptureEvidenceSchema = Schema.Struct({ kind: Schema.Literal('capture'), ...parityEvidenceFields });
const UpdateEvidenceSchema = Schema.Struct({ kind: Schema.Literal('update'), ...parityEvidenceFields });
const SyncEvidenceSchema = Schema.Struct({kind:Schema.Literal('syncDecision'),...parityEvidenceFields});
export const ParityRunEvidenceSchema = Schema.Union([SyncEvidenceSchema, ReconcileEvidenceSchema, UninstallEvidenceSchema, CaptureEvidenceSchema, UpdateEvidenceSchema, IntentEvidenceSchema]);
const IntentOrigin = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine']), source: PatchId });
const IntentTargets = Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMaxLength(2));
export const IntentItemSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('manageConfig'), value: Schema.Boolean, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('configTargets'), value: IntentTargets, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('file'), id: PatchId, target: Schema.Literals(['claude', 'codex']), managed: Schema.Boolean, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('setting'), fileId: PatchId, key: PatchId, value: IntentValueSchema, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('skill'), source: SkillSourceSchema, name: SkillNameSchema, enabled: Schema.Boolean, from: IntentOrigin, declaredFrom: IntentOrigin, targets: IntentTargets,
    policy: Schema.Literals(['upstream', 'source-pin', 'personal-pin']), revision: Schema.optionalKey(SkillRevisionSchema) }),
  Schema.Struct({ kind: Schema.Literal('integration'), id: PatchId, type: Schema.Literals(['hook', 'mcp', 'plugin', 'marketplace', 'unknown']), target: Schema.optionalKey(Schema.Literals(['claude', 'codex'])), enabled: Schema.Boolean, from: IntentOrigin, prerequisites: Schema.Array(Text).check(Schema.isMaxLength(4)) }),
  Schema.Struct({ kind: Schema.Literal('issue'), layer: Schema.Literals(['base', 'pin', 'machine']), source: PatchId, message: Schema.Literal('Configuration input is invalid; inspect the owning document in the app') }),
]);
export const IntentInspectionResultSchema = Schema.Struct({ generation: IdSchema, items: Schema.Array(IntentItemSchema).check(Schema.isMaxLength(100)), nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxCodePoints(512))), limitReason: Schema.optionalKey(Schema.Literals(['record-bytes', 'result-bytes', 'value-limit', 'unsafe-value', 'identity-limit'])) });
export const MachineIntentDetailsSchema = Schema.Struct({
  intentChanges: Schema.Array(Schema.Struct({ kind: Schema.Literal('machine-choice'), action: Schema.Literals(['set', 'reset', 'enable', 'disable', 'removeSkillDeclaration']), message: Text, before: Schema.NullOr(IntentItemSchema), after: Schema.NullOr(IntentItemSchema) })).check(Schema.isMaxLength(1)),
  installationEffects: Schema.Array(Text).check(Schema.isMaxLength(4)),
  sourceImpact: Schema.Array(Schema.Struct({ source: SkillSourceSchema, skills: Schema.Array(SkillNameSchema).check(Schema.isMaxLength(256)), policy: Schema.Literals(['upstream', 'source-pin', 'personal-pin']) })).check(Schema.isMaxLength(1)),
});
const previewFields = { planId: IdSchema, scope: OperationScopeSchema,
  generation: IdSchema, plan: OperationPlanSchema, nextActions: Schema.Array(NextActionSchema).check(Schema.isMaxLength(2)) };
export const ReconcilePreviewSchema = Schema.Struct({ ...previewFields, change: ReconcileChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), actionEffects: Schema.optionalKey(Schema.Array(Text).check(Schema.isMaxLength(4))) });
export const UninstallConfigPreviewSchema = Schema.Struct({ ...previewFields, change: UninstallConfigChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), actionEffects: Schema.optionalKey(Schema.Array(Text).check(Schema.isMaxLength(4))) });
export const CapturePreviewSchema = Schema.Struct({ ...previewFields, change: CaptureChangeSchema, skillAddition: Schema.optionalKey(Schema.Never),
  capture: Schema.Struct({ checkout: Text, head: AuthorHeadSchema, redacted: Schema.Literal(true),
    documents: Schema.Array(Schema.Struct({ path: Text, beforeSha256: Schema.NullOr(DigestSchema), afterSha256: DigestSchema })).check(Schema.isMaxLength(100)),
    manifest: Schema.Struct({ write: Schema.Boolean, reason: Text }) }),
  actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)),
});
export const UpdatePreviewSchema = Schema.Struct({ ...previewFields, change: UpdateChangeSchema, skillAddition: Schema.optionalKey(Schema.Never),
  authorManifest: Schema.optionalKey(Schema.Struct({ checkout: Text, head: AuthorHeadSchema, redacted: Schema.Literal(true), documents: Schema.Array(Schema.Struct({ path: Text, beforeSha256: Schema.NullOr(DigestSchema), afterSha256: DigestSchema })).check(Schema.isMaxLength(1)) })),
  actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)),
});
export const AddSkillPreviewSchema = Schema.Struct({ ...previewFields, change: AddSkillChangeSchema, skillAddition: SkillAdditionPreviewSchema });
export const MachineIntentPreviewSchema = Schema.Struct({ ...previewFields, change: MachineIntentChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), machineIntent: MachineIntentDetailsSchema });
export const SyncPreviewSchema = Schema.Struct({...previewFields,change:SyncDecisionChangeSchema,sourceImpact:Schema.NullOr(Schema.Struct({source:Text,skills:Schema.Array(Text).check(Schema.isMaxLength(256)),before:Schema.NullOr(Text),after:Schema.NullOr(Text)})),skillAddition:Schema.optionalKey(Schema.Never),actionEffects:Schema.Array(Text).check(Schema.isMaxLength(4))});
export const ChangePreviewSchema = Schema.Union([SyncPreviewSchema, ReconcilePreviewSchema, UninstallConfigPreviewSchema, CapturePreviewSchema, UpdatePreviewSchema, AddSkillPreviewSchema, MachineIntentPreviewSchema]);
export const StepOutcomeSchema = Schema.Struct({ key: KeySchema, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Text });
export const RunTerminalResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('done'), ok: CountSchema, failed: CountSchema }),
  Schema.Struct({ status: Schema.Literal('cancelled'), remaining: list(KeySchema) }),
  Schema.Struct({ status: Schema.Literals(['failed', 'interrupted']), message: Text }),
]);
export const AcceptedSkillSchema = Schema.Struct({
  source: SkillSourceSchema, acceptedRevision: SkillRevisionSchema, sourceDir: KeySchema,
  selectorName: Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(255)), installedName: SkillNameSchema,
  blob: SkillRevisionSchema, tree: SkillRevisionSchema, internal: Schema.Boolean, targets: SkillTargetsSchema,
  declaration: SkillDeclarationSchema, policy: Schema.Literals(['upstream', 'source-pin', 'personal-pin']),
});
const NativePath = Schema.String.check(Schema.isMaxCodePoints(4096));
const NativeReason = Schema.String.check(Schema.isMaxCodePoints(100));
export const SkillInstallationSchema = Schema.Struct({
  state: Schema.Literals(['verified', 'failed', 'cancelled', 'needsInspection']), message: Text, retainedDirectory: Schema.optionalKey(NativePath),
  sharedStore: Schema.Struct({ codexScans: Schema.Literal(true), visibility: Schema.Literal('shared') }),
  codex: Schema.optionalKey(Schema.Union([
    Schema.Struct({ verified: Schema.Literal(true), path: NativePath, enabled: Schema.Literal(true) }),
    Schema.Struct({ verified: Schema.Literal(false), reason: NativeReason }),
  ])),
  claude: Schema.optionalKey(Schema.Struct({ verified: Schema.Boolean, reason: Schema.optionalKey(NativeReason),
    physical: Schema.Union([Schema.Struct({ status: Schema.Literal('present'), path: NativePath }), Schema.Struct({ status: Schema.Literal('unavailable') })]),
    catalog: Schema.Struct({ status: Schema.Literals(['present', 'missing', 'ambiguous', 'unavailable']), userCommand: Schema.optionalKey(Schema.Boolean) }),
    restrictions: Schema.Struct({ status: Schema.Literals(['no-known-denial', 'denied', 'unknown', 'unavailable']), managedOnly: Schema.optionalKey(Schema.Boolean), diagnostics: Schema.Array(NativeReason).check(Schema.isMaxLength(6)) }),
    limits: Schema.Struct({ selectedSource: Schema.Literal('not-attested'), invocationAuthorization: Schema.Literal('not-attested'), configRoot: Schema.Literal('requested-environment-only'), managedStartup: Schema.Literal('remains-active') }),
  })),
  nextActions: Schema.Array(NextActionSchema).check(Schema.isMaxLength(2)),
});
const intentFields = { requestId: IdSchema, inputDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)), planId: IdSchema };
const runFields = {
  actor: Schema.optionalKey(Schema.Literals(['app', 'cli', 'mcp'])),
  runId: IdSchema, state: Schema.Literals(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  operation: Schema.Literal('applyChange'), scope: OperationScopeSchema,
  intentSaved: Schema.Boolean, intentState: Schema.optionalKey(Schema.Literals(['pending', 'saved', 'needsInspection'])),
  installation: Schema.optionalKey(SkillInstallationSchema), steps: list(StepOutcomeSchema), result: Schema.NullOr(RunTerminalResultSchema),
};
export const RunViewSchema = Schema.Union([
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SyncDecisionChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SyncAcceptanceSchema}),parity:Schema.optionalKey(SyncEvidenceSchema)}),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: ReconcileChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: ReconcileChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: ReconcileAcceptanceSchema }), parity: Schema.optionalKey(ReconcileEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: UninstallConfigChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: UninstallAcceptanceSchema }), parity: Schema.optionalKey(UninstallEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: UpdateChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: UpdateAcceptanceSchema }), parity: Schema.optionalKey(UpdateEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: CaptureChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: CaptureAcceptanceSchema }), parity: Schema.optionalKey(CaptureEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: MachineIntentChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: IntentAcceptanceSchema }), parity: Schema.optionalKey(IntentEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AddSkillChangeSchema, skillAddition: AcceptedSkillSchema, parity: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(Schema.Never) }),
]);
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
export const InspectIntentInputSchema = Schema.Struct({ scope, section: Schema.Literals(['configuration', 'files', 'settings', 'skills', 'integrations', 'issues']), cursor: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(512))), limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(50))) });
export const InspectUpdatesInputSchema = Schema.Struct({ scope, cursor: Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1), Schema.isMaxCodePoints(512))), limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(50))) });
export const UpdatesInspectionResultSchema = Schema.Struct({ generation: IdSchema, items: Schema.Array(Schema.Struct({
  id: Text, key: KeySchema, source: SkillSourceSchema, name: SkillNameSchema, state: Schema.Literals(['current', 'outdated', 'off-pin', 'gone', 'unknown', 'available', 'local']), targets: IntentTargets, policy: Schema.Literals(['upstream', 'source-pin', 'personal-pin']),
  offered: Schema.NullOr(Schema.Struct({ kind: Schema.Literals(['tree', 'revision']), digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$(?![\s\S])/u)) })), repairRoute: Schema.Literals(['reconcile', 'addition', 'unavailable']), prerequisite: Schema.optionalKey(Text),
})).check(Schema.isMaxLength(100)), nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxCodePoints(512))), unavailable: Schema.Boolean, limitReason: Schema.optionalKey(Schema.Literals(['unsafe-owner-data', 'result-bytes'])) });
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

const syncPage = {scope,cursor:Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1),Schema.isMaxCodePoints(512))),limit:Schema.Int.check(Schema.isBetween({minimum:1,maximum:100})).pipe(Schema.withDecodingDefaultKey(Effect.succeed(50)))};
const syncCursor = Schema.NullOr(Schema.String.check(Schema.isMaxCodePoints(512)));
export const InspectSetupsInputSchema = Schema.Struct(syncPage);
export const IncomingChangesInputSchema = Schema.Struct({...syncPage,setupId:IdSchema});
export const PrepareTrustRequestInputSchema = Schema.Struct({scope,setupId:IdSchema});
export const SetupInspectionResultSchema = Schema.Struct({generation:IdSchema,items:Schema.Array(Schema.Struct({setupId:IdSchema,trusted:Schema.Boolean,repository:Schema.NullOr(Text),accountId:Schema.NullOr(IdSchema)})).check(Schema.isMaxLength(100)),nextCursor:syncCursor});
export const IncomingChangesResultSchema = Schema.Struct({generation:IdSchema,setupId:IdSchema,revision:SyncRevisionIdentitySchema,items:Schema.Array(Schema.Struct({itemId:KeySchema,revision:SyncRevisionIdentitySchema,kind:Schema.Literals(['setting','file','skill','integration']),change:Schema.Literals(['added','changed','removed']),held:Schema.Boolean,conflict:Schema.Boolean})).check(Schema.isMaxLength(100)),nextCursor:syncCursor});
export const TrustRequestResultSchema = Schema.Struct({generation:IdSchema,setupId:IdSchema,repository:Schema.NullOr(Text),trusted:Schema.Boolean,action:Schema.Literal('open-app-repository-trust')});
