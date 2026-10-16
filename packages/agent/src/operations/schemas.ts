import { FILES } from '@nortuscc/profile-engine/author-values';
import { IntentSchema } from '../author/intents.ts';
import { DraftSchema } from '../author/draft-schema.ts';
import { PublicSetupSchema, utf8ByteLength, MachinePatchSchema, DisplayNameSchema, DeviceStartResponseSchema, SyncMachineSchema, SyncSetupSchema, RepoUrlSchema, ProfileNameSchema } from '@nortuscc/hosted-protocol';
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
export const SourceDecisionChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('sourceDecision'), sourceId: OperationKeySchema, action: Schema.Literals(['pin', 'ignore']), revision: SkillRevisionSchema }),
  Schema.Struct({ kind: Schema.Literal('sourceDecision'), sourceId: OperationKeySchema, action: Schema.Literals(['unpin', 'unignore']) }),
]);
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
export const SetupApplyChangeSchema = Schema.Struct({ kind: Schema.Literal('setupApply'), setupId: IdSchema,
  revision: SyncRevisionIdentitySchema, choices: Schema.Array(Schema.Struct({ itemId: KeySchema,
    action: Schema.Literals(['accept', 'hold', 'release', 'takeTheirs']) })).check(Schema.isMinLength(1), Schema.isMaxLength(1000)) });
export const SetPolicyChangeSchema = Schema.Struct({ kind: Schema.Literal('setPolicy'), policy: Schema.Literals(POLICIES) });
export const ResumeChangeSchema = Schema.Struct({ kind: Schema.Literal('resume') });
export const SignInChangeSchema = Schema.Struct({ kind: Schema.Literal('signIn'), name: Schema.optionalKey(DisplayNameSchema), reportStatus: Schema.optionalKey(Schema.Boolean) });
export const SignOutChangeSchema = Schema.Struct({ kind: Schema.Literal('signOut') });
export const SyncAccountChangeSchema = Schema.Struct({ kind: Schema.Literal('syncAccount') });
export const PatchMachineMetadataChangeSchema = Schema.Struct({ kind: Schema.Literal('patchMachineMetadata'), patch: MachinePatchSchema });
export const AccountChangeSchema = Schema.Union([SetPolicyChangeSchema, ResumeChangeSchema, SignInChangeSchema, SignOutChangeSchema, SyncAccountChangeSchema, PatchMachineMetadataChangeSchema]);
export const PruneBackupsChangeSchema = Schema.Struct({kind: Schema.Literal('pruneBackups')});
export const FollowedProfileSchema = Schema.Struct({ repoUrl: RepoUrlSchema, profile: ProfileNameSchema, setupId: Schema.NullOr(OperationIdSchema) });
export const FollowProfileChangeSchema = Schema.Struct({ kind: Schema.Literal('followProfile'), ...FollowedProfileSchema.fields });
export const InspectProfilesInputSchema = Schema.Struct({ scope: OperationScopeSchema.pipe(Schema.withDecodingDefaultKey(Effect.succeed({ kind: 'machine' } as const))) });
export const InspectProfilesResultSchema = Schema.Struct({ followed: Schema.NullOr(FollowedProfileSchema), available: Schema.Array(Schema.Struct({ name: ProfileNameSchema, extends: Schema.NullOr(ProfileNameSchema) })).check(Schema.isMaxLength(1000)) });
export const InspectShareLinkInputSchema = Schema.Struct({ ...InspectProfilesInputSchema.fields, setupId: OperationIdSchema });
export const InspectShareLinkResultSchema = Schema.Struct({ ...PublicSetupSchema.fields, access: Schema.Literals(['readable', 'denied', 'unreachable']) });
export const PublishDraftChangeSchema = Schema.Struct({ kind: Schema.Literal('publishDraft'), draftId: IdSchema, digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)) });
export const AnnouncePublicationChangeSchema = Schema.Struct({ kind: Schema.Literal('announcePublication'), runId: IdSchema });
// Author sources are Git remotes, never installer URL modes or credential-bearing URLs.
export const AuthorSourceSchema = Schema.String.check(Schema.isMaxCodePoints(2048), Schema.makeFilter(value => {
  if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._][A-Za-z0-9._-]*$(?![\s\S])/u.test(value)) return true;
  if (!/^https:\/\//i.test(value) || /[\s\\\x00-\x1f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !/^https:\/\/[^/]*@/i.test(value) && !value.includes('?') && !value.includes('#')
      && (url.hostname.toLowerCase() === 'github.com' ? url.pathname.split('/').filter(Boolean).length === 2 : url.pathname.split('/').filter(Boolean).length >= 1);
  } catch { return false; }
}));
const AuthorIntentSchema = IntentSchema.check(Schema.makeFilter(intent => !('source' in intent) || Schema.is(AuthorSourceSchema)(intent.source)));
const DraftIdSchema = DraftSchema.fields.id;
export const AuthorLocalChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('editDraft'), draftId: Schema.NullOr(DraftIdSchema), intent: AuthorIntentSchema }),
  Schema.Struct({ kind: Schema.Literal('removeDraftIntent'), draftId: DraftIdSchema, index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ kind: Schema.Literal('deleteDraft'), draftId: DraftIdSchema }),
  Schema.Struct({ kind: Schema.Literal('ghLogin') }),
]);
export const ChangeSchema = Schema.Union([FollowProfileChangeSchema,...AuthorLocalChangeSchema.members, PublishDraftChangeSchema, AnnouncePublicationChangeSchema, PruneBackupsChangeSchema, ...AccountChangeSchema.members, ...SourceDecisionChangeSchema.members, SyncDecisionChangeSchema, SetupApplyChangeSchema, ReconcileChangeSchema, UninstallConfigChangeSchema, UpdateChangeSchema, CaptureChangeSchema, AddSkillChangeSchema, MachineIntentChangeSchema]);
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
export const CAPABILITY_NAMES = ['inspectProfiles','inspectShareLink','followProfile','authorProfiles','machineFile','authorFile','upstreams','discoverUpstream','upstreamSkill','drafts','draftPreview','ghState','editDraft','removeDraftIntent','deleteDraft','ghLogin','publishDraft','announcePublication','listBackups','pruneBackups','agentStatus','accountState','setPolicy','resume','signIn','signOut','syncAccount','patchMachineMetadata','sourceDecision','watchSources','inspectSourceDiff','pinImpact','draftChangelog', 'getContext', 'inspect', 'inspectIntent', 'inspectUpdates', 'setupReview', 'setupApply', 'inspectSetups', 'incomingChanges', 'prepareTrustRequest', 'syncDecision', 'machineIntent', 'previewChange', 'applyChange', 'getRun', 'listRuns', 'cancelRun', 'history', 'resolveSkillCandidate', 'addSkill', 'shareWithMyMachines', 'promoteToProfile'] as const;
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
  Schema.Struct({ ...semanticFields, domain: Schema.Literal('author'), action: Schema.Literals(['publish-draft', 'announce-publication', 'edit-draft', 'delete-draft', 'gh-login']) }),
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
export const BackupFolderIdSchema = Schema.String.check(Schema.isPattern(new RegExp(String.raw`^nortuscc-${DATE}T(?:[01][0-9]|2[0-3])-[0-5][0-9]-[0-5][0-9]-[0-9]{3}Z(?![\s\S])`,'u')));
export const BackupPrunePlanSchema = Schema.Struct({folderIds: Schema.Array(BackupFolderIdSchema).check(Schema.isMaxLength(100)), inventoryDigest: DigestSchema, keepId: Schema.NullOr(BackupFolderIdSchema), evaluatedAt: OperationTimeSchema, limited: Schema.Boolean});
const PruneAcceptanceSchema = Schema.Struct({kind:Schema.Literal('pruneBackups'),...parityAcceptanceFields,retention:BackupPrunePlanSchema});
const ReconcileAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), ...parityAcceptanceFields });
const UninstallAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('uninstallConfig'), ...parityAcceptanceFields });
const IntentAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('machineIntent'), ...parityAcceptanceFields });
const AuthorHeadSchema = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$(?![\s\S])/u));
const AuthorEvidenceSchema = Schema.Struct({ checkout: Text, realCheckout: Text, gitDir: Text, head: AuthorHeadSchema,
  files: Schema.Array(Schema.Struct({ path: Text, kind: Schema.Literals(['absent', 'file']), sha256: Schema.NullOr(DigestSchema), indexBlob: Schema.NullOr(DigestSchema) })).check(Schema.isMaxLength(100)) });
const CaptureAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('capture'), ...parityAcceptanceFields, author: AuthorEvidenceSchema });
const UpdateAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('update'), ...parityAcceptanceFields, author: Schema.optionalKey(AuthorEvidenceSchema) });
const FollowAcceptanceSchema = Schema.Struct({kind:Schema.Literal('followProfile'),...parityAcceptanceFields});
const SetupAcceptanceSchema = Schema.Struct({kind:Schema.Literal('setupApply'),...parityAcceptanceFields});
const SyncAcceptanceSchema = Schema.Struct({kind:Schema.Literal('syncDecision'),...parityAcceptanceFields});
const SourceAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('sourceDecision'), ...parityAcceptanceFields, author: AuthorEvidenceSchema, sourceId: KeySchema, observedRevision: AuthorHeadSchema });
const SetPolicyAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('setPolicy'), ...parityAcceptanceFields });
const ResumeAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('resume'), ...parityAcceptanceFields });
const SignInAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('signIn'), ...parityAcceptanceFields });
const SignOutAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('signOut'), ...parityAcceptanceFields });
const SyncAccountAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('syncAccount'), ...parityAcceptanceFields });
const PatchMachineMetadataAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('patchMachineMetadata'), ...parityAcceptanceFields });
export const PublicationTargetSchema = Schema.Struct({ repoUrl: RepoUrlSchema, base: AuthorHeadSchema, draftId: IdSchema, draftDigest: DigestSchema, profiles: Schema.Array(ProfileNameSchema), accountId: Schema.NullOr(IdSchema) });
const PublishAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('publishDraft'), ...parityAcceptanceFields, publication: PublicationTargetSchema });
const AnnounceAcceptanceSchema = Schema.Struct({ kind: Schema.Literal('announcePublication'), ...parityAcceptanceFields, publication: PublicationTargetSchema, commit: AuthorHeadSchema });
const AuthorLocalAcceptanceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('editDraft'), ...parityAcceptanceFields, draftId: Schema.NullOr(DraftIdSchema) }),
  Schema.Struct({ kind: Schema.Literal('removeDraftIntent'), ...parityAcceptanceFields, draftId: Schema.NullOr(DraftIdSchema) }),
  Schema.Struct({ kind: Schema.Literal('deleteDraft'), ...parityAcceptanceFields, draftId: Schema.NullOr(DraftIdSchema) }),
  Schema.Struct({ kind: Schema.Literal('ghLogin'), ...parityAcceptanceFields, draftId: Schema.NullOr(DraftIdSchema) }),
]);
export const ParityAcceptanceSchema = Schema.Union([FollowAcceptanceSchema, AuthorLocalAcceptanceSchema, PublishAcceptanceSchema, AnnounceAcceptanceSchema, PruneAcceptanceSchema, SetPolicyAcceptanceSchema, ResumeAcceptanceSchema, SignInAcceptanceSchema, SignOutAcceptanceSchema, SyncAccountAcceptanceSchema, PatchMachineMetadataAcceptanceSchema, SourceAcceptanceSchema, SyncAcceptanceSchema, SetupAcceptanceSchema, ReconcileAcceptanceSchema, UninstallAcceptanceSchema, CaptureAcceptanceSchema, UpdateAcceptanceSchema, IntentAcceptanceSchema]);
const parityEvidenceFields = { state: Schema.Literals(['pending', 'committed', 'partial', 'needsInspection']), committedKeys: list(KeySchema), remainingKeys: list(KeySchema), backupIds: list(IdSchema) };
const PruneEvidenceSchema = Schema.Struct({kind:Schema.Literal('pruneBackups'),...parityEvidenceFields});
const ReconcileEvidenceSchema = Schema.Struct({ kind: Schema.Literal('reconcile'), ...parityEvidenceFields });
const UninstallEvidenceSchema = Schema.Struct({ kind: Schema.Literal('uninstallConfig'), ...parityEvidenceFields });
const RoutingEffectSchema = Schema.Union([
  Schema.Struct({ fileId: Schema.Literals(['claude:CLAUDE.md', 'codex:AGENTS.md']), state: Schema.Literal('needsInspection') }),
  Schema.Struct({ fileId: Schema.Literals(['claude:CLAUDE.md', 'codex:AGENTS.md']), state: Schema.Literal('observed'), intentChanged: Schema.Boolean, instructionsChanged: Schema.Boolean, outcome: Schema.Literals(['changed', 'unchanged', 'conflict', 'unmanaged']) }),
]);
const IntentEvidenceSchema = Schema.Struct({ kind: Schema.Literal('machineIntent'), ...parityEvidenceFields, intentState: Schema.Literals(['pending', 'saved', 'needsInspection']), routingEffects: Schema.Array(RoutingEffectSchema).check(Schema.isMaxLength(2)) });
const CaptureEvidenceSchema = Schema.Struct({ kind: Schema.Literal('capture'), ...parityEvidenceFields });
const UpdateEvidenceSchema = Schema.Struct({ kind: Schema.Literal('update'), ...parityEvidenceFields });
const FollowEvidenceSchema = Schema.Struct({kind:Schema.Literal('followProfile'),...parityEvidenceFields});
const SetupEvidenceSchema = Schema.Struct({kind:Schema.Literal('setupApply'),...parityEvidenceFields});
const SyncEvidenceSchema = Schema.Struct({kind:Schema.Literal('syncDecision'),...parityEvidenceFields});
const SourceEvidenceSchema = Schema.Struct({ kind: Schema.Literal('sourceDecision'), ...parityEvidenceFields });
export const SignInRunResultSchema = Schema.Union([
  Schema.Struct({kind:Schema.Literal('signIn'),state:Schema.Literal('awaiting-user'),userCode:Schema.optionalKey(DeviceStartResponseSchema.fields.userCode),verificationUri:Schema.optionalKey(DeviceStartResponseSchema.fields.verificationUri.check(Schema.isMaxCodePoints(500))),expiresAt:OperationTimeSchema}),
  Schema.Struct({kind:Schema.Literal('signIn'),state:Schema.Literals(['expired','needsInspection']),expiresAt:OperationTimeSchema}),
]);
export type SignInRunResult = typeof SignInRunResultSchema.Type;
const SetPolicyEvidenceSchema = Schema.Struct({ kind: Schema.Literal('setPolicy'), ...parityEvidenceFields, metadata: Schema.optionalKey(Schema.Literal('locally-queued')) });
const ResumeEvidenceSchema = Schema.Struct({ kind: Schema.Literal('resume'), ...parityEvidenceFields, resumed: Schema.optionalKey(Schema.Boolean) });
const SignInEvidenceSchema = Schema.Struct({ kind: Schema.Literal('signIn'), ...parityEvidenceFields, signIn: Schema.optionalKey(SignInRunResultSchema) });
const SignOutEvidenceSchema = Schema.Struct({ kind: Schema.Literal('signOut'), ...parityEvidenceFields });
const SyncAccountEvidenceSchema = Schema.Struct({ kind: Schema.Literal('syncAccount'), ...parityEvidenceFields, metadata: Schema.optionalKey(Schema.Literal('locally-queued')) });
const PatchMachineMetadataEvidenceSchema = Schema.Struct({ kind: Schema.Literal('patchMachineMetadata'), ...parityEvidenceFields, metadata: Schema.optionalKey(Schema.Literal('locally-queued')) });
const PublishEvidenceSchema = Schema.Struct({ kind: Schema.Literal('publishDraft'), ...parityEvidenceFields });
const AnnounceEvidenceSchema = Schema.Struct({ kind: Schema.Literal('announcePublication'), ...parityEvidenceFields });
const AuthorLocalEvidenceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('editDraft'), ...parityEvidenceFields }),
  Schema.Struct({ kind: Schema.Literal('removeDraftIntent'), ...parityEvidenceFields }),
  Schema.Struct({ kind: Schema.Literal('deleteDraft'), ...parityEvidenceFields }),
  Schema.Struct({ kind: Schema.Literal('ghLogin'), ...parityEvidenceFields }),
]);
export const ParityRunEvidenceSchema = Schema.Union([FollowEvidenceSchema, AuthorLocalEvidenceSchema, PublishEvidenceSchema, AnnounceEvidenceSchema, PruneEvidenceSchema, SetPolicyEvidenceSchema, ResumeEvidenceSchema, SignInEvidenceSchema, SignOutEvidenceSchema, SyncAccountEvidenceSchema, PatchMachineMetadataEvidenceSchema, SourceEvidenceSchema, SyncEvidenceSchema, SetupEvidenceSchema, ReconcileEvidenceSchema, UninstallEvidenceSchema, CaptureEvidenceSchema, UpdateEvidenceSchema, IntentEvidenceSchema]);
const IntentOrigin = Schema.Struct({ layer: Schema.Literals(['base', 'pin', 'machine', 'profile']), source: PatchId });
const IntentTargets = Schema.Array(Schema.Literals(['claude', 'codex'])).check(Schema.isMaxLength(2));
export const IntentItemSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('manageConfig'), value: Schema.Boolean, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('configTargets'), value: IntentTargets, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('file'), id: PatchId, target: Schema.Literals(['claude', 'codex']), managed: Schema.Boolean, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('setting'), fileId: PatchId, key: PatchId, value: IntentValueSchema, from: IntentOrigin }),
  Schema.Struct({ kind: Schema.Literal('skill'), source: SkillSourceSchema, name: SkillNameSchema, choice: Schema.NullOr(Schema.Boolean), defaultEnabled: Schema.Boolean, enabled: Schema.Boolean, from: IntentOrigin, declaredFrom: IntentOrigin, targets: IntentTargets,
    policy: Schema.Literals(['upstream', 'source-pin', 'personal-pin']), revision: Schema.optionalKey(SkillRevisionSchema) }),
  Schema.Struct({ kind: Schema.Literal('integration'), id: PatchId, type: Schema.Literals(['hook', 'mcp', 'plugin', 'marketplace', 'unknown']), target: Schema.optionalKey(Schema.Literals(['claude', 'codex'])), enabled: Schema.Boolean, from: IntentOrigin, prerequisites: Schema.Array(Text).check(Schema.isMaxLength(4)) }),
  Schema.Struct({ kind: Schema.Literal('issue'), layer: Schema.Literals(['base', 'pin', 'machine', 'profile']), source: PatchId, message: Schema.Literal('Configuration input is invalid; inspect the owning document in the app') }),
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
export const FollowPreviewSchema = Schema.Struct({ ...previewFields, change: FollowProfileChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), droppedChoices: Schema.Struct({ holds: list(KeySchema), overrides: list(KeySchema) }), actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)) });
export const SetupPreviewSchema = Schema.Struct({ ...previewFields, change: SetupApplyChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)) });
export const SyncPreviewSchema = Schema.Struct({...previewFields,change:SyncDecisionChangeSchema,sourceImpact:Schema.NullOr(Schema.Struct({source:Text,skills:Schema.Array(Text).check(Schema.isMaxLength(256)),before:Schema.NullOr(Text),after:Schema.NullOr(Text)})),skillAddition:Schema.optionalKey(Schema.Never),actionEffects:Schema.Array(Text).check(Schema.isMaxLength(4))});
export const SourceDecisionPreviewSchema = Schema.Struct({ ...previewFields, change: SourceDecisionChangeSchema, skillAddition: Schema.optionalKey(Schema.Never),
  sourceDecision: Schema.Struct({ sourceId: KeySchema, observedRevision: AuthorHeadSchema, checkout: Text, head: AuthorHeadSchema, redacted: Schema.Literal(true),
    documents: Schema.Array(Schema.Struct({ path: Text, beforeSha256: Schema.NullOr(DigestSchema), afterSha256: DigestSchema })).check(Schema.isMaxLength(1)),
    authorIntent: Schema.Struct({ before: Schema.NullOr(AuthorHeadSchema), after: Schema.NullOr(SkillRevisionSchema) }),
    machinePolicy: Schema.Array(Schema.Struct({ skillId: KeySchema, revision: Schema.NullOr(AuthorHeadSchema), enabled: Schema.Boolean })).check(Schema.isMaxLength(256)),
    impact: Schema.Array(Schema.Struct({ skillId: KeySchema, status: Schema.Literals(['unchanged', 'changed', 'removed', 'missing']) })).check(Schema.isMaxLength(256)),
  }), actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)),
});
const AccountPreviewSchema = Schema.Struct({...previewFields,change:AccountChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),actionEffects:Schema.Array(Text).check(Schema.isMaxLength(4))});
const PrunePreviewSchema = Schema.Struct({...previewFields,change:PruneBackupsChangeSchema,retention:BackupPrunePlanSchema,skillAddition:Schema.optionalKey(Schema.Never),actionEffects:Schema.Array(Text).check(Schema.isMaxLength(4))});
const PublicationPreviewSchema = Schema.Struct({ ...previewFields, change: Schema.Union([PublishDraftChangeSchema, AnnouncePublicationChangeSchema]), actionEffects: Schema.Array(Text).check(Schema.isMaxLength(4)), skillAddition: Schema.optionalKey(Schema.Never) });
export const DraftPreviewSchema = Schema.Struct({ draftId: DraftIdSchema, base: AuthorHeadSchema, digest: DigestSchema,
  diff: Schema.Array(Schema.Struct({ path: Schema.String, before: Schema.NullOr(Schema.String), after: Schema.NullOr(Schema.String) })),
  invalid: Schema.Array(Schema.Struct({ index: CountSchema, reason: Schema.String })), affectedProfiles: Schema.Array(ProfileNameSchema) });
const AuthorLocalPreviewSchema = Schema.Struct({ ...previewFields, skillAddition: Schema.optionalKey(Schema.Never), change: AuthorLocalChangeSchema,
  draftId: Schema.NullOr(DraftIdSchema), draft: Schema.NullOr(DraftPreviewSchema), actionEffects: Schema.Array(Text) });
export const ChangePreviewSchema = Schema.Union([FollowPreviewSchema, AuthorLocalPreviewSchema, PublicationPreviewSchema, PrunePreviewSchema, AccountPreviewSchema, SourceDecisionPreviewSchema, SyncPreviewSchema, SetupPreviewSchema, ReconcilePreviewSchema, UninstallConfigPreviewSchema, CapturePreviewSchema, UpdatePreviewSchema, AddSkillPreviewSchema, MachineIntentPreviewSchema]);
export const StepOutcomeSchema = Schema.Struct({ key: KeySchema, outcome: Schema.Literals(['ok', 'failed', 'cancelled']), note: Text });
export const PublicationResultSchema = Schema.Struct({ status: Schema.Literals(['succeeded', 'needs-preview', 'interrupted']), message: Text });
export const RunTerminalResultSchema = Schema.Union([
  PublicationResultSchema,
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
export const PublicationSchema = Schema.Struct({ commit: Schema.NullOr(AuthorHeadSchema), pushed: Schema.Boolean, tagged: Schema.Boolean, announced: Schema.Array(ProfileNameSchema), pending: Schema.Array(ProfileNameSchema),
  unannounceable: Schema.optionalKey(Schema.Array(Schema.Struct({ profile: ProfileNameSchema, reason: Text }))),
});
const runFields = {
  ghCode: Schema.optionalKey(Schema.NullOr(Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)), url: Schema.Literal('https://github.com/login/device') }))),
  publicationRecovery: Schema.optionalKey(Schema.Struct({ published: Schema.Union([Schema.Boolean, Schema.Literal('unknown')]), action: Schema.NullOr(Schema.Literals(['announce', 're-check', 're-preview'])) })),
  publication: Schema.optionalKey(PublicationSchema),
  actor: Schema.optionalKey(Schema.Literals(['app', 'cli', 'mcp'])),
  runId: IdSchema, state: Schema.Literals(['accepted', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'abandoned']),
  abandonedAt: Schema.optionalKey(OperationTimeSchema),
  operation: Schema.Literal('applyChange'), scope: OperationScopeSchema,
  intentSaved: Schema.Boolean, intentState: Schema.optionalKey(Schema.Literals(['pending', 'saved', 'needsInspection'])),
  installation: Schema.optionalKey(SkillInstallationSchema), steps: list(StepOutcomeSchema), result: Schema.NullOr(RunTerminalResultSchema),
};
export const RunViewSchema = Schema.Union([
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AuthorLocalChangeSchema.members[0], parity: AuthorLocalAcceptanceSchema.members[0], skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(AuthorLocalEvidenceSchema.members[0]) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AuthorLocalChangeSchema.members[1], parity: AuthorLocalAcceptanceSchema.members[1], skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(AuthorLocalEvidenceSchema.members[1]) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AuthorLocalChangeSchema.members[2], parity: AuthorLocalAcceptanceSchema.members[2], skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(AuthorLocalEvidenceSchema.members[2]) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AuthorLocalChangeSchema.members[3], parity: AuthorLocalAcceptanceSchema.members[3], skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(AuthorLocalEvidenceSchema.members[3]) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: PublishDraftChangeSchema, parity: PublishAcceptanceSchema, skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(PublishEvidenceSchema) }),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: AnnouncePublicationChangeSchema, parity: AnnounceAcceptanceSchema, skillAddition: Schema.optionalKey(Schema.Never) }), parity: Schema.optionalKey(AnnounceEvidenceSchema) }),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:PruneBackupsChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:PruneAcceptanceSchema}),parity:Schema.optionalKey(PruneEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SetPolicyChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SetPolicyAcceptanceSchema}),parity:Schema.optionalKey(SetPolicyEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:ResumeChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:ResumeAcceptanceSchema}),parity:Schema.optionalKey(ResumeEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SignInChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SignInAcceptanceSchema}),parity:Schema.optionalKey(SignInEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SignOutChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SignOutAcceptanceSchema}),parity:Schema.optionalKey(SignOutEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SyncAccountChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SyncAccountAcceptanceSchema}),parity:Schema.optionalKey(SyncAccountEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:PatchMachineMetadataChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:PatchMachineMetadataAcceptanceSchema}),parity:Schema.optionalKey(PatchMachineMetadataEvidenceSchema)}),
  Schema.Struct({ ...runFields, intent: Schema.Struct({ ...intentFields, change: SourceDecisionChangeSchema, skillAddition: Schema.optionalKey(Schema.Never), parity: SourceAcceptanceSchema }), parity: Schema.optionalKey(SourceEvidenceSchema) }),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SyncDecisionChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SyncAcceptanceSchema}),parity:Schema.optionalKey(SyncEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:FollowProfileChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:FollowAcceptanceSchema}),parity:Schema.optionalKey(FollowEvidenceSchema)}),
  Schema.Struct({...runFields,intent:Schema.Struct({...intentFields,change:SetupApplyChangeSchema,skillAddition:Schema.optionalKey(Schema.Never),parity:SetupAcceptanceSchema}),parity:Schema.optionalKey(SetupEvidenceSchema)}),
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
const HistoryDetailSchema = Schema.Union([
  Schema.Struct({kind:Schema.Literal('decision'),setupId:IdSchema,itemId:KeySchema,revision:Schema.NullOr(CountSchema),commit:Schema.NullOr(IdSchema),choice:Schema.Literals(['accept','skip'])}),
  Schema.Struct({kind:Schema.Literal('setup'),setupId:Schema.NullOr(IdSchema)}),
  Schema.Struct({kind:Schema.Literal('revision'),setupId:IdSchema,revision:Schema.Union([IdSchema,CountSchema]),accepted:Schema.Boolean}),
  Schema.Struct({kind:Schema.Literal('policy'),from:Schema.Literals(POLICIES),to:Schema.Literals(POLICIES),origin:Schema.Literals(['local','synced'])}),
  Schema.Struct({kind:Schema.Literal('pause'),reason:Schema.Literals(['Automatic application paused','Application pause cleared'])}),
  Schema.Struct({kind:Schema.Literal('backups'),ids:Schema.Array(BackupFolderIdSchema).check(Schema.isMaxLength(100)),pruned:Schema.Boolean,limited:Schema.optionalKey(Schema.Boolean)}),
]);
export const HistoryTimeSchema = OperationTimeSchema.check(Schema.isMaxCodePoints(100));
const HistoryStepSchema = Schema.Union([
  Schema.Struct({key:KeySchema,outcome:Schema.Literal('ok'),note:Schema.Literal('Step completed')}),
  Schema.Struct({key:KeySchema,outcome:Schema.Literal('failed'),note:Schema.Literal('Step failed')}),
  Schema.Struct({key:KeySchema,outcome:Schema.Literal('cancelled'),note:Schema.Literal('Step cancelled')}),
]);
const historyFields = {at:HistoryTimeSchema,actor:Schema.Literals(['agent','cli','app','sync','mcp'])};
export const OperationHistoryEventSchema = Schema.Union([
  Schema.Struct({...historyFields,kind:Schema.Literal('unknown'),message:Schema.Literal('Unsupported historical event')}),
  Schema.Struct({...historyFields,kind:Schema.Literals(['apply-started','apply-finished','operation-checkpoint','skill-addition','held','ready','decided','policy-changed','setup-trusted','paused','resumed','revision-verified','revision-rejected','backups-pruned','outbox-dropped']),
    operation:Schema.optionalKey(Schema.Literal('applyChange')),scope:Schema.optionalKey(OperationScopeSchema),requestId:Schema.optionalKey(IdSchema),runId:Schema.optionalKey(IdSchema),
    keys:Schema.optionalKey(list(KeySchema)),steps:Schema.optionalKey(list(HistoryStepSchema)),message:Schema.optionalKey(Text),detail:Schema.optionalKey(HistoryDetailSchema)}),
]);
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
const incomingItemFields = {itemId:KeySchema,kind:Schema.Literals(['setting','file','skill','integration']),conflict:Schema.Boolean};
const IncomingItemSchema = Schema.Union([
  Schema.Struct({...incomingItemFields,revision:SyncRevisionIdentitySchema,change:Schema.Literals(['added','changed','removed']),held:Schema.Boolean}),
  Schema.Struct({...incomingItemFields,revision:Schema.Struct({kind:Schema.Literal('local'),commit:SyncCommitSchema}),change:Schema.Literal('unchanged'),held:Schema.Literal(true)}),
]);
export const IncomingChangesResultSchema = Schema.Struct({generation:IdSchema,setupId:IdSchema,revision:SyncRevisionIdentitySchema,items:Schema.Array(IncomingItemSchema).check(Schema.isMaxLength(100)),nextCursor:syncCursor});
export const TrustRequestResultSchema = Schema.Struct({generation:IdSchema,setupId:IdSchema,repository:Schema.NullOr(Text),trusted:Schema.Boolean,action:Schema.Literal('open-app-repository-trust')});

const SourceIdentitySchema = Schema.String.check(Schema.isMinCodePoints(1),Schema.isMaxCodePoints(500));
const sourcePage = {scope,cursor:syncPage.cursor,limit:Schema.Int.check(Schema.isBetween({minimum:1,maximum:8})).pipe(Schema.withDecodingDefaultKey(Effect.succeed(8)))};
const SourceRevision = SyncCommitSchema;
const sourcePair = {sourceId:SourceIdentitySchema,fromRevision:SourceRevision,toRevision:SourceRevision};
const sourceNames = Schema.Array(SkillNameSchema).check(Schema.isMaxLength(100));
export const WatchSourcesInputSchema = Schema.Struct({...sourcePage,sourceIds:Schema.optionalKey(Schema.Array(SourceIdentitySchema).check(Schema.isMaxLength(8)))});
const localSelection = {sourceId:SourceIdentitySchema,localObservation:SourceRevision};
export const InspectSourceDiffInputSchema = Schema.Union([Schema.Struct({...syncPage,...sourcePair,skillId:KeySchema}),Schema.Struct({...syncPage,...localSelection,skillId:KeySchema})]);
export const PinImpactInputSchema = Schema.Struct({scope,sourceId:SourceIdentitySchema,revision:Schema.String.check(Schema.isMinCodePoints(1),Schema.isMaxCodePoints(200),Schema.isPattern(/^(?!-)[^\s\x00-\x1f]+$(?![\s\S])/u))});
export const DraftChangelogInputSchema = Schema.Struct({scope,accepted:Schema.Array(Schema.Struct({...sourcePair,ignored:Schema.optionalKey(sourceNames),added:Schema.optionalKey(sourceNames)})).check(Schema.isMaxLength(8))});
const sourceState = Schema.Literals(['complete','limited','unavailable']);
const sourceReason = Schema.optionalKey(Schema.Literals(['read-unavailable','deadline','cleanup-failed','unsafe-owner-data','result-bytes','source-retention']));
const sourceSkill = Schema.Struct({skillId:KeySchema,name:SkillNameSchema,status:Schema.Literals(['unchanged','changed','removed','missing'])});
const localSource = Schema.Struct({observation:SourceRevision,status:Schema.Literals(['clean','edits','no-upstream','not-a-repo']),branch:Schema.optionalKey(Text),unpushed:Schema.Array(Schema.Struct({sha:SourceRevision,subject:Text})).check(Schema.isMaxLength(100)),uncommitted:Schema.Array(Text).check(Schema.isMaxLength(256)),skills:Schema.Array(Schema.Struct({skillId:KeySchema,name:SkillNameSchema,hasDiff:Schema.Boolean})).check(Schema.isMaxLength(256))});
const sourceRow = Schema.Struct({sourceId:SourceIdentitySchema,status:Schema.Literals(['up-to-date','ahead','diverged','unpinned','baseline-missing','unreachable']),fromRevision:Schema.NullOr(SourceRevision),toRevision:Schema.NullOr(SourceRevision),skills:Schema.Array(sourceSkill).check(Schema.isMaxLength(256)),added:sourceNames,local:Schema.optionalKey(localSource)});
export const WatchSourcesResultSchema = Schema.Struct({generation:IdSchema,state:sourceState,reason:sourceReason,retainedCache:Schema.optionalKey(Schema.Literal(true)),items:Schema.Array(sourceRow).check(Schema.isMaxLength(8)),nextCursor:syncCursor});
const sourceDiffFields = {generation:IdSchema,skillId:KeySchema,state:sourceState,reason:sourceReason,retainedCache:Schema.optionalKey(Schema.Literal(true)),text:Schema.String.check(Schema.isMaxCodePoints(32768)),nextCursor:syncCursor};
export const SourceDiffResultSchema = Schema.Union([Schema.Struct({...sourceDiffFields,...sourcePair}),Schema.Struct({...sourceDiffFields,...localSelection})]);
export const PinImpactResultSchema = Schema.Struct({generation:IdSchema,sourceId:SourceIdentitySchema,state:sourceState,reason:sourceReason,retainedCache:Schema.optionalKey(Schema.Literal(true)),fromRevision:Schema.NullOr(SourceRevision),toRevision:Schema.NullOr(SourceRevision),skills:Schema.Array(sourceSkill).check(Schema.isMaxLength(256))});
export const ChangelogResultSchema = Schema.Struct({generation:IdSchema,state:sourceState,reason:sourceReason,retainedCache:Schema.optionalKey(Schema.Literal(true)),text:Schema.String.check(Schema.isMaxCodePoints(32768))});

export const AgentStatusInputSchema = Schema.Struct({...syncPage,section:Schema.Literals(['status','pending','drift','conflicts'])});
export const AccountStateInputSchema = Schema.Struct({...syncPage,section:Schema.Literals(['account','setups','machine'])});
const accountPageResult = {generation:IdSchema,nextCursor:syncCursor};
const agentStatusFields = {policy:Schema.Literals(POLICIES),paused:Schema.Boolean,trusted:Schema.Boolean,error:Schema.NullOr(Schema.Literals(['PROFILE_INVALID','DECISIONS_INVALID','REVISION_UNAVAILABLE','JOB_FAILED']))};
export const AgentStatusResultSchema = Schema.Union([
 Schema.Struct({...accountPageResult,section:Schema.Literal('status'),items:Schema.Array(Schema.Struct(agentStatusFields)).check(Schema.isMaxLength(1))}),
 Schema.Struct({...accountPageResult,section:Schema.Literal('pending'),items:Schema.Array(Schema.Struct({key:KeySchema,itemId:KeySchema,verdict:Schema.Literals(['inert','held'])})).check(Schema.isMaxLength(100))}),
 Schema.Struct({...accountPageResult,section:Schema.Literals(['drift','conflicts']),items:Schema.Array(KeySchema).check(Schema.isMaxLength(100))}),
]);
const accountBase = {...accountPageResult,enabled:Schema.Boolean};
export const AccountStateResultSchema = Schema.Union([
 Schema.Struct({...accountBase,section:Schema.Literal('account'),items:Schema.Array(Schema.Struct({accountId:Schema.NullOr(IdSchema),login:Schema.NullOr(Text),machineId:Schema.NullOr(IdSchema),auth:Schema.Literals(['signed-in','signed-out','unauthenticated']),recovered:Schema.Boolean,signingIn:Schema.Boolean,lastSyncAt:Schema.NullOr(OperationTimeSchema),retryAt:Schema.NullOr(OperationTimeSchema),error:Schema.NullOr(Schema.Literal('hosted-unavailable'))})).check(Schema.isMaxLength(1))}),
 Schema.Struct({...accountBase,section:Schema.Literal('setups'),items:Schema.Array(SyncSetupSchema).check(Schema.isMaxLength(100))}),
 Schema.Struct({...accountBase,section:Schema.Literal('machine'),items:Schema.Array(Schema.Struct({effective:Schema.NullOr(SyncMachineSchema),confirmed:Schema.NullOr(SyncMachineSchema),persistence:Schema.Literals(['locally-queued','confirmed','unknown'])})).check(Schema.isMaxLength(1))}),
]);

export const ListBackupsInputSchema = Schema.Struct({scope,cursor:Schema.optionalKey(Schema.String.check(Schema.isMinCodePoints(1),Schema.isMaxCodePoints(512))),limit:Schema.Int.check(Schema.isBetween({minimum:1,maximum:100})).pipe(Schema.withDecodingDefaultKey(Effect.succeed(50)))});
export const ListBackupsResultSchema = Schema.Struct({generation:IdSchema,folders:Schema.Array(Schema.Struct({id:BackupFolderIdSchema,createdAt:OperationTimeSchema,latestReferenced:Schema.Boolean})).check(Schema.isMaxLength(100)),nextCursor:Schema.NullOr(Schema.String.check(Schema.isMaxCodePoints(512)))});

export const SETUP_TEXT_MAX_BYTES = 65_536;
const SetupTextSchema = Schema.String.check(Schema.isMaxCodePoints(SETUP_TEXT_MAX_BYTES), Schema.makeFilter(value => utf8ByteLength(value) <= SETUP_TEXT_MAX_BYTES));
export const SetupReviewInputSchema = Schema.Struct({ ...syncPage, setupId: IdSchema, refetch: Schema.Boolean });
export const SetupReviewRowSchema = Schema.Struct({ ...incomingItemFields,
  change: Schema.Literals(['added', 'changed', 'removed', 'unchanged']), held: Schema.Boolean,
  before: Schema.optionalKey(SetupTextSchema), after: Schema.optionalKey(SetupTextSchema), mine: Schema.optionalKey(SetupTextSchema),
  truncated: Schema.optionalKey(Schema.Literal(true)) });
export const SetupReviewSchema = Schema.Struct({ generation: CountSchema, setupId: IdSchema, revision: SyncRevisionIdentitySchema,
  rows: Schema.Array(SetupReviewRowSchema).check(Schema.isMaxLength(100)),
  pinGroups: Schema.Array(Schema.Struct({ source: KeySchema, itemIds: Schema.Array(KeySchema) })), nextCursor: syncCursor });
export type SetupApplyChange = typeof SetupApplyChangeSchema.Type;
export type SetupReview = typeof SetupReviewSchema.Type;
export type SetupReviewRow = typeof SetupReviewRowSchema.Type;

export const AuthorProfilesInputSchema = Schema.Struct({ scope });
export const MachineFileInputSchema = Schema.Struct({ scope, profile: Schema.optionalKey(ProfileNameSchema), fileId: Schema.String.check(Schema.makeFilter(value => FILES.some(file => file.id === value && file.capture))) });
export const MachineFileResultSchema = Schema.Struct({ fileId: Schema.String, exists: Schema.Boolean, text: Schema.String, truncated: Schema.Boolean });
export const AuthorFileInputSchema = Schema.Struct({ scope, profile: ProfileNameSchema, fileId: KeySchema });
export const UpstreamsInputSchema = Schema.Struct({ scope });
export const DiscoverUpstreamInputSchema = Schema.Struct({ scope, source: AuthorSourceSchema });
export const UpstreamSkillInputSchema = Schema.Struct({ scope, source: AuthorSourceSchema, commit: SourceRevision, name: KeySchema });
export const DraftsInputSchema = Schema.Struct({ scope });
export const DraftPreviewInputSchema = Schema.Struct({ scope, draftId: DraftIdSchema });
export const GhStateInputSchema = Schema.Struct({ scope });
const GhState = Schema.Literals(['ready', 'missing', 'signed-out', 'error']);
export const GhStateResultSchema = Schema.Struct({ state: GhState });
export const DiscoveryResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('complete'), source: Schema.String, commit: SourceRevision, skills: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })) }),
  Schema.Struct({ kind: Schema.Literal('unavailable'), source: Schema.String, reason: Schema.Literals(['cli-failed', 'unparseable', 'head-moved', 'timeout', 'too-large']) }),
]);
const authorIssues = { issues: Schema.optionalKey(Schema.Array(Schema.Struct({ profile: ProfileNameSchema, issues: Schema.Array(Schema.Struct({
  layer: Schema.Literals(['base', 'profile', 'pin', 'machine']), source: Schema.String, path: Schema.String, message: Schema.String,
})) }))) };
export const AuthorProfilesResultSchema = Schema.Struct({ ...authorIssues, repoUrl: RepoUrlSchema, profiles: Schema.Array(Schema.Struct({ name: ProfileNameSchema, extends: Schema.NullOr(ProfileNameSchema),
  skills: Schema.Array(Schema.Struct({ source: Schema.String, name: Schema.String, included: Schema.Boolean, from: Schema.String })),
  files: Schema.Array(Schema.Struct({ fileId: Schema.String, path: Schema.NullOr(Schema.String), from: Schema.String })) })) });
export const AuthorFileResultSchema = Schema.Struct({ ...authorIssues, path: Schema.NullOr(Schema.String), text: Schema.String, truncated: Schema.Boolean });
export const UpstreamsResultSchema = Schema.Struct({ ...authorIssues, sources: Schema.Array(Schema.Struct({ source: Schema.String, inProfiles: Schema.Array(ProfileNameSchema), pin: Schema.NullOr(SourceRevision), discovery: Schema.NullOr(DiscoveryResultSchema) })) });
export const UpstreamSkillResultSchema = Schema.Union([
  Schema.Struct({ path: Schema.String, text: Schema.String, files: Schema.Array(Schema.String) }),
  Schema.Struct({ unavailable: Schema.String }),
]);
export const DraftsResultSchema = Schema.Struct({ drafts: Schema.Array(Schema.Union([DraftSchema, Schema.Struct({ id: DraftIdSchema, error: Schema.String })])) });
