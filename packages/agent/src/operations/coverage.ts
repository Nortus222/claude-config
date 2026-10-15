import type { OperationName, OperationChange } from './index.ts';

type Coverage = { readonly source: string } & (
  | { readonly state: 'available'; readonly operations: readonly OperationName[]; readonly changes: readonly OperationChange['kind'][]; readonly reason: string }
  | { readonly state: 'remaining' | 'prerequisite'; readonly workstream: string; readonly reason: string }
);
const available = (source: string, operations: readonly OperationName[], reason: string, changes: readonly OperationChange['kind'][] = []): Coverage => ({ source, state: 'available', operations, changes, reason });
const remaining = (source: string, workstream: string, reason: string, state: 'remaining' | 'prerequisite' = 'remaining'): Coverage => ({ source, state, workstream, reason });
const profiles = 'Personal sharing and owned-profile distribution';

// Supported owner behavior and explicit prerequisites, with shared reads and mutation kinds.
export const engineCapabilityCoverage = {
  appContext: available('operations/context.ts', ['getContext'], 'App ownership, runtime, configured targets, setup/account availability and supported scopes.'),
  machineInspection: available('machine/run.ts', ['inspect'], 'Config, integrations, skills, drift, conflicts and reconciliation keys.'),
  effectiveConfiguration: available('operations/intent.ts', ['inspectIntent'], 'Bounded effective owned values, provenance, enablement, targets and source policy; safe constant issue diagnostics.'),
  reconciliationPreview: available('machine/run.ts plan(apply)', ['previewChange'], 'Selected inspected keys, targets, declined categories and bounded force use the existing owners.', ['reconcile']),
  reconciliationApply: available('machine/run.ts execute', ['applyChange'], 'Reviewed plans use the shared lock, maintenance fence, backups and scheduler.', ['reconcile']),
  configApply: available('machine/config/domain.ts', ['previewChange', 'applyChange'], 'Declared file copies and settings-key merges preserve unrelated keys and project trust.', ['reconcile']),
  integrationInstall: available('machine/integrations/domain.ts', ['inspect', 'previewChange', 'applyChange'], 'Reconcile declared hooks, plugins, marketplaces and existing supported MCP installers with unchanged prerequisites.', ['reconcile']),
  skillInspection: available('machine/skills/domain.ts and store.ts', ['inspect'], 'Installed declarations, pin drift and existing agent exposure evidence.'),
  skillRepair: available('machine/skills/domain.ts', ['previewChange', 'applyChange'], 'Repair declared missing/off-pin skills and links using existing pinned verification. No new unpinned content or selected-agent isolation guarantee.', ['reconcile']),
  undeclaredInspection: available('machine/undeclared/probe.ts', ['inspect'], 'Report undeclared content and declaration defects; no arbitrary adoption/removal.'),
  durableRunRead: available('agent/run-store.ts and agent/runs.ts', ['getRun', 'listRuns'], 'Accepted/running/terminal receipts survive client disconnect and agent restart recovery.'),
  cancellation: available('agent/ipc/session.ts', ['cancelRun'], 'Cancel a retained authorized machine run at existing safe boundaries.'),
  history: available('machine/history.ts', ['history'], 'Bounded pagination and MCP actor, operation, scope, request and run attribution.'),
  targetCategoryForceSelection: available('operations/actions.ts and machine/model.ts Selection', ['previewChange', 'applyChange'], 'Typed selected reconciliation retains target/category/force rules and owner guards.', ['reconcile']),
  configCapture: available('operations/capture.ts and machine/capture.ts', ['previewChange', 'applyChange', 'getRun'], 'Selected capture binds the configured author checkout, current allowlist, exact bytes and index entries; backed-up writes preserve observation snapshots and per-file baselines.', ['capture']),
  configUninstall: available('operations/actions.ts and machine/config/restore.ts plan(uninstall)', ['previewChange', 'applyChange', 'getRun'], 'Restore selected recorded documents through the existing owner, retaining document-wide guards, trusted-original cutoff, backups and partial routing-release evidence. Integration and skill removal remain unavailable.', ['uninstallConfig']),
  skillUpdates: available('operations/updates.ts and machine/skills/upstream.ts', ['inspectUpdates', 'previewChange', 'applyChange'], 'Bounded source-qualified update discovery; selected machine actions and separately reviewed author manifests retain existing policy and native prerequisites.', ['update']),
  skillAdoptionPruning: available('operations/updates.ts and machine/skills/domain.ts', ['previewChange', 'applyChange', 'getRun'], 'Selected adoption and pruning retain configured native destination prerequisites, backups and partial outcomes.', ['update']),
  additionUpdateRepair: available('agent/skill-operations.ts and skill-addition.ts', ['resolveSkillCandidate', 'previewChange', 'applyChange'], 'Addition-touched update/repair requires the existing audited native selector, explicit environment, accepted content and catalog verification route.', ['addSkill']),
  machineOverrides: available('machine/intent.ts', ['previewChange', 'applyChange'], 'Semantic machine choices and explicit declaration removal with backed-up intent persistence and routing release; no installer or physical content deletion.', ['machineIntent']),
  historyDetail: available('operations/history.ts', ['history'], 'Discriminated safe decision, setup, revision, policy, pause and backup facts; constant unknown fallback.'),
  backupPruning: available('machine/prune.ts and operations/backups.ts', ['listBackups','previewChange','applyChange','getRun'], 'Exact bounded retention batches bind generated contained directories, inventory, latest reference and fixed evaluation time under the common lock; observed partial deletions persist without backup-of-backups.', ['pruneBackups']),
  backupInventoryRestore: remaining('machine/backups.ts', 'Backup inventory and selected restoration', 'Validated folder date/ID/reference inventory is available through listBackups; general selected-backup restoration has no owner.'),
  incomingSyncDecisions: available('sync/decisions.ts and operations/sync.ts', ['incomingChanges','previewChange','applyChange'], 'Exact local or hosted per-item accept, hold, release and take-theirs retain backups, partial facts and post-lock policy scheduling.', ['syncDecision']),
  heldConfiguration: available('sync/compose.ts and setup-source.ts', ['inspectSetups','incomingChanges'], 'Known trusted setup and verified incoming item inspection; no repository document projection.'),
  setupTrust: available('agent/setups.ts and operations/sync.ts', ['prepareTrustRequest'], 'Returns only the existing app-local trust action and bounded repository identity; no consent write.'),
  setupFollowTrust: remaining('sync/setups.ts and source.ts', 'Independent follow and primary selection', 'No independent follow or select-primary owner exists; known trusted setup access is available separately.', 'prerequisite'),
  sourceWatch: available('source-watch/watch.ts', ['watchSources','inspectSourceDiff'], 'Bounded declared-source and trusted configured checkout observations; exact revision or local-observation skill diffs; no intent writes.'),
  sourcePinImpact: available('source-watch/impact.ts', ['pinImpact'], 'Source-wide impact retains resolved revisions and every declared skill.'),
  sourcePinUnpin: available('source-watch/documents.ts and operations/sources.ts', ['previewChange','applyChange','getRun'], 'Exact configured author pin/unpin edits retain source-wide impact, fresh source and document guards, backups and durable recovery.', ['sourceDecision']),
  sourceIgnoreUnignore: available('source-watch/documents.ts and operations/sources.ts', ['previewChange','applyChange','getRun'], 'Author ignore/unignore edits only suppress source notifications; machine installation policy remains separate.', ['sourceDecision']),
  changelogDraft: available('source-watch/changelog.ts', ['draftChangelog'], 'Read-only accepted revision draft with validated added and ignored selections.'),
  captureCommitPush: remaining('src/commands/capture.ts and push.ts', 'Author publication workflow', 'Existing CLI capture/commit/push is not reusable profile publication; explicit publication authority remains necessary.'),
  hostedAccount: available('hosted-client/client.ts and operations/account.ts', ['accountState','previewChange','applyChange','getRun'], 'Existing account owner and device flow; bounded challenge retention and explicit queued metadata.', ['signIn', 'signOut', 'syncAccount']),
  hostedMachineMetadata: available('hosted-client/client.ts and operations/account.ts', ['accountState','previewChange','applyChange'], 'Exact machine metadata patches queue through the existing outbox; reads distinguish effective values from last authoritative values.', ['patchMachineMetadata']),
  agentPolicyResume: available('agent/agent.ts and operations/account.ts', ['agentStatus','previewChange','applyChange'], 'Manual, notify and auto-apply retain policy semantics; resume clears failure pause without changing policy. No user pause or trust grant.', ['setPolicy', 'resume']),
  skillCandidateDiscovery: available('agent/skill-operations.ts', ['resolveSkillCandidate', 'previewChange'], 'Bounded source-specific metadata discovery and exact side-effect-free tentative machine declaration preview.', ['addSkill']),
  skillAddition: available('agent/skill-addition.ts', ['applyChange', 'getRun', 'listRuns', 'cancelRun'], 'Durable machine declaration, accepted content verification and selected native catalog evidence.', ['addSkill']),
  arbitrarySkillRemoval: remaining('machine/skills/installer.ts', 'Physical general skill removal', 'Enablement and declaration removal change intent; general physical deletion has no supported owner.'),
  integrationRemoval: remaining('machine/integrations/domain.ts', 'Integration removal semantics', 'No existing domain removal steps exist; cannot publish a callable placeholder.'),
  personalSharing: remaining('hosted-protocol/revisions.ts', profiles, 'Requires an available personal distribution destination and declaration workflow.', 'prerequisite'),
  profilePromotionPublication: remaining('profile-engine/resolve.ts and hosted-protocol/revisions.ts', profiles, 'Owned-profile identity, promotion, edits and verified revision publication remain prerequisite work.', 'prerequisite'),
  multipleFollowedProfiles: remaining('profile-engine/resolve.ts', profiles, 'Composition currently has base, pins and machine overrides, not multiple followed profiles.', 'prerequisite'),
  userPause: remaining('agent/pause.ts', 'User-attributed pause', 'No supported user pause owner exists; manual policy and failure resume have different meanings.', 'prerequisite'),
  standalonePull: remaining('src/commands/pull.ts', 'Standalone CLI pull', 'Standalone pull updates code and dependencies and restarts its service; use the CLI workflow.', 'prerequisite'),
  appLifecycle: remaining('desktop/agent/lifecycle.ts and maintenance.ts', 'App-owned setup and maintenance actions', 'Installation, ownership adoption, restart and maintenance recovery remain explicit app actions.', 'prerequisite'),
  hostRegistration: remaining('desktop/agent/mcp-connections.ts', 'App-owned host connection workflow', 'Settings owns Claude/Codex registration, relocation, conflicts and instruction cleanup; host session loading is unobserved.', 'prerequisite'),
} as const satisfies Record<string, Coverage>;

const capabilityCoverage: Record<string, { readonly state: 'available' | 'remaining'; readonly reason?: string }> = {
  listBackups: {state:'available'}, pruneBackups: {state:'available'},
  agentStatus: {state:'available'}, accountState: {state:'available'},
  setPolicy: {state:'available'}, resume: {state:'available'}, signIn: {state:'available'}, signOut: {state:'available'}, syncAccount: {state:'available'}, patchMachineMetadata: {state:'available'},
  sourceDecision: {state:'available'}, watchSources: {state:'available'}, inspectSourceDiff: {state:'available'}, pinImpact: {state:'available'}, draftChangelog: {state:'available'},
  inspectSetups: { state: 'available' }, incomingChanges: { state: 'available' }, prepareTrustRequest: { state: 'available' }, syncDecision: { state: 'available' }, inspectUpdates: { state: 'available' }, inspectIntent: { state: 'available' }, machineIntent: { state: 'available' }, getContext: { state: 'available' }, inspect: { state: 'available' }, previewChange: { state: 'available' },
  applyChange: { state: 'available' }, getRun: { state: 'available' }, listRuns: { state: 'available' }, cancelRun: { state: 'available' }, history: { state: 'available' }, resolveSkillCandidate: { state: 'available' },
  addSkill: { state: 'available' }, shareWithMyMachines: { state: 'remaining', reason: profiles }, promoteToProfile: { state: 'remaining', reason: profiles },
};

// Refuse an operation/capability added without reviewing its coverage and readiness.
export function assertCapabilityCoverage(input: { operations: readonly string[]; capabilities: Readonly<Record<string, { available: boolean; reason?: string }>> }): void {
  const mapped = new Set(Object.values(engineCapabilityCoverage).flatMap(item => item.state === 'available' ? item.operations : []));
  for (const operation of input.operations) if (!mapped.has(operation as OperationName)) throw new Error(`Missing engine coverage for ${operation}`);
  for (const operation of mapped) if (!input.operations.includes(operation)) throw new Error(`Missing registered operation ${operation}`);
  for (const [name, capability] of Object.entries(input.capabilities)) {
    const coverage = capabilityCoverage[name];
    if (!coverage) throw new Error(`Missing capability coverage for ${name}`);
    if (capability.available !== (coverage.state === 'available') || (!capability.available && !capability.reason)) throw new Error(`Capability readiness requires coverage review for ${name}`);
  }
  for (const name of Object.keys(capabilityCoverage)) if (!Object.hasOwn(input.capabilities, name)) throw new Error(`Missing advertised capability ${name}`);
}
