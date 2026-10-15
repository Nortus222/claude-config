import type { OperationName } from './index.ts';

type Coverage = { readonly source: string } & (
  | { readonly state: 'available'; readonly operations: readonly OperationName[]; readonly reason: string }
  | { readonly state: 'remaining' | 'prerequisite'; readonly workstream: string; readonly reason: string }
);
const available = (source: string, operations: readonly OperationName[], reason: string): Coverage => ({ source, state: 'available', operations, reason });
const remaining = (source: string, workstream: string, reason: string, state: 'remaining' | 'prerequisite' = 'remaining'): Coverage => ({ source, state, workstream, reason });
const parity = 'Remaining current-engine operation parity';
const additions = 'Verified machine-local skill additions';
const profiles = 'Personal sharing and owned-profile distribution';

// Audited user-facing behavior, including existing engine operations awaiting a transport adapter.
export const engineCapabilityCoverage = {
  appContext: available('operations/context.ts', ['getContext'], 'App ownership, runtime, configured targets, setup/account availability and supported scopes.'),
  machineInspection: available('machine/run.ts', ['inspect'], 'Config, integrations, skills, drift, conflicts and reconciliation keys.'),
  effectiveConfiguration: available('operations/intent.ts', ['inspectIntent'], 'Bounded effective owned values, provenance, enablement, targets and source policy; safe constant issue diagnostics.'),
  reconciliationPreview: available('machine/run.ts plan(apply)', ['previewChange'], 'Selected inspected keys, targets, declined categories and bounded force use the existing owners.'),
  reconciliationApply: available('machine/run.ts execute', ['applyChange'], 'Reviewed plans use the shared lock, maintenance fence, backups and scheduler.'),
  configApply: available('machine/config/domain.ts', ['previewChange', 'applyChange'], 'Declared file copies and settings-key merges preserve unrelated keys and project trust.'),
  integrationInstall: available('machine/integrations/domain.ts', ['inspect', 'previewChange', 'applyChange'], 'Reconcile declared hooks, plugins, marketplaces and existing supported MCP installers with unchanged prerequisites.'),
  skillInspection: available('machine/skills/domain.ts and store.ts', ['inspect'], 'Installed declarations, pin drift and existing agent exposure evidence.'),
  skillRepair: available('machine/skills/domain.ts', ['previewChange', 'applyChange'], 'Repair declared missing/off-pin skills and links using existing pinned verification. No new unpinned content or selected-agent isolation guarantee.'),
  undeclaredInspection: available('machine/undeclared/probe.ts', ['inspect'], 'Report undeclared content and declaration defects; no arbitrary adoption/removal.'),
  durableRunRead: available('agent/run-store.ts and agent/runs.ts', ['getRun', 'listRuns'], 'Accepted/running/terminal receipts survive client disconnect and agent restart recovery.'),
  cancellation: available('agent/ipc/session.ts', ['cancelRun'], 'Cancel a retained authorized machine run at existing safe boundaries.'),
  history: available('machine/history.ts', ['history'], 'Bounded pagination and MCP actor, operation, scope, request and run attribution.'),
  targetCategoryForceSelection: available('operations/actions.ts and machine/model.ts Selection', ['previewChange', 'applyChange'], 'Typed selected reconciliation retains target/category/force rules and owner guards.'),
  configCapture: available('operations/capture.ts and machine/capture.ts', ['previewChange', 'applyChange', 'getRun'], 'Selected capture binds the configured author checkout, current allowlist, exact bytes and index entries; backed-up writes preserve observation snapshots and per-file baselines.'),
  configUninstall: available('operations/actions.ts and machine/config/restore.ts plan(uninstall)', ['previewChange', 'applyChange', 'getRun'], 'Restore selected recorded documents through the existing owner, retaining document-wide guards, trusted-original cutoff, backups and partial routing-release evidence. Integration and skill removal remain unavailable.'),
  skillUpdates: available('operations/updates.ts and machine/skills/upstream.ts', ['inspectUpdates', 'previewChange', 'applyChange'], 'Bounded source-qualified update discovery; selected machine actions and separately reviewed author manifests retain existing policy and native prerequisites.'),
  skillAdoptionPruning: available('operations/updates.ts and machine/skills/domain.ts', ['previewChange', 'applyChange', 'getRun'], 'Selected adoption and pruning retain configured native destination prerequisites, backups and partial outcomes.'),
  additionUpdateRepair: available('agent/skill-operations.ts and skill-addition.ts', ['resolveSkillCandidate', 'previewChange', 'applyChange'], 'Addition-touched update/repair requires the existing audited native selector, explicit environment, accepted content and catalog verification route.'),
  machineOverrides: available('machine/intent.ts', ['previewChange', 'applyChange'], 'Semantic machine choices and explicit declaration removal with backed-up intent persistence and routing release; no installer or physical content deletion.'),
  historyDetail: remaining('agent/ipc/server.ts History projection', parity, 'Expose bounded decision/setup/revision, policy from/to, pause and backup/pruning facts currently omitted by the operation projection.'),
  backupPruning: remaining('machine/prune.ts', parity, 'Existing retention pruning needs a bounded operation and common mutation contract.'),
  backupInventoryRestore: remaining('machine/backups.ts', 'Backup inventory and selected restoration', 'No public typed inventory or general selected-backup restoration exists.'),
  incomingSyncDecisions: remaining('sync/plan.ts and agent/agent.ts', parity, 'Accept/hold incoming items and resolve conflicting overrides with existing local consent.'),
  heldConfiguration: remaining('sync/compose.ts and setup-source.ts', parity, 'Expose held revisions and verified effective setup configuration through bounded owning reads.'),
  setupFollowTrust: remaining('sync/setups.ts and source.ts', 'Setup follow and local consent workflow', 'MCP may report the app action; an assistant boolean cannot replace repository trust.', 'prerequisite'),
  sourceWatch: remaining('source-watch/watch.ts', parity, 'Upstream/local skill diffs and commits require an authenticated bounded read adapter.'),
  sourcePinImpact: remaining('source-watch/impact.ts', parity, 'Source-wide pin impact preview must retain the resolved revision.'),
  sourcePinUnpin: remaining('source-watch/pins.ts', parity, 'Adapt existing backed-up writes to explicit services, common lock, preview and history.'),
  sourceIgnoreUnignore: remaining('source-watch/ignores.ts', parity, 'Adapt existing backed-up writes to explicit services, common lock, preview and history.'),
  changelogDraft: remaining('source-watch/changelog.ts', parity, 'Expose selected accepted revision drafts without publication.'),
  captureCommitPush: remaining('src/commands/capture.ts and push.ts', 'Author publication workflow', 'Existing CLI capture/commit/push is not reusable profile publication; explicit publication authority remains necessary.'),
  hostedAccount: remaining('hosted-client/client.ts', 'Account and metadata operation parity', 'Sign-in/out, recovery and sync retain credential ownership and app device-flow actions.'),
  hostedMachineMetadata: remaining('hosted-client/client.ts', 'Account and metadata operation parity', 'Machine name/reporting and durable outbox are metadata, not personal configuration sharing.'),
  agentPolicyResume: remaining('agent/agent.ts', parity, 'Manual/automatic policy and explicit resume are distinct from cancellation and require dedicated semantics.'),
  skillCandidateDiscovery: available('agent/skill-operations.ts', ['resolveSkillCandidate', 'previewChange'], 'Bounded source-specific metadata discovery and exact side-effect-free tentative machine declaration preview.'),
  skillAddition: available('agent/skill-addition.ts', ['applyChange', 'getRun', 'listRuns', 'cancelRun'], 'Durable machine declaration, accepted content verification and selected native catalog evidence.'),
  arbitrarySkillRemoval: remaining('machine/skills/installer.ts', 'Physical general skill removal', 'Enablement and declaration removal change intent; general physical deletion has no supported owner.'),
  integrationRemoval: remaining('machine/integrations/domain.ts', 'Integration removal semantics', 'No existing domain removal steps exist; cannot publish a callable placeholder.'),
  personalSharing: remaining('hosted-protocol/revisions.ts', profiles, 'Requires an available personal distribution destination and declaration workflow.', 'prerequisite'),
  profilePromotionPublication: remaining('profile-engine/resolve.ts and hosted-protocol/revisions.ts', profiles, 'Owned-profile identity, promotion, edits and verified revision publication remain prerequisite work.', 'prerequisite'),
  multipleFollowedProfiles: remaining('profile-engine/resolve.ts', profiles, 'Composition currently has base, pins and machine overrides, not multiple followed profiles.', 'prerequisite'),
  appLifecycle: remaining('desktop/agent/lifecycle.ts and maintenance.ts', 'App-owned setup and maintenance actions', 'Installation, ownership adoption, restart and maintenance recovery remain explicit app actions.', 'prerequisite'),
  hostRegistration: remaining('desktop/agent/mcp-connections.ts', 'App-owned host connection workflow', 'Settings owns Claude/Codex registration, relocation, conflicts and instruction cleanup; host session loading is unobserved.', 'prerequisite'),
} as const satisfies Record<string, Coverage>;

const capabilityCoverage: Record<string, { readonly state: 'available' | 'remaining'; readonly reason?: string }> = {
  inspectUpdates: { state: 'available' }, inspectIntent: { state: 'available' }, machineIntent: { state: 'available' }, getContext: { state: 'available' }, inspect: { state: 'available' }, previewChange: { state: 'available' },
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
