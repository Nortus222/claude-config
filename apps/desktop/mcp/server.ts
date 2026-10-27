import { McpServer, type StandardSchemaWithJSON, type JSONObject } from '@modelcontextprotocol/server';
import { decodeOperationInput, decodeOperationOutput, operationDefinitions, operationJsonSchemas, type OperationName } from '@nortuscc/agent/operations';
import { AgentError, AgentUnavailable } from '../../../src/agent-client.ts';
import type { AppAgentClient } from './client.ts';

export const toolNames = {
  inspectProfiles: 'nortuscc_inspect_profiles', inspectShareLink: 'nortuscc_inspect_share_link',
  authorProfiles: 'nortuscc_author_profiles',
  machineFile: 'nortuscc_machine_file',
  authorFile: 'nortuscc_author_file',
  upstreams: 'nortuscc_upstreams',
  discoverUpstream: 'nortuscc_discover_upstream',
  upstreamSkill: 'nortuscc_upstream_skill',
  drafts: 'nortuscc_drafts',
  draftPreview: 'nortuscc_draft_preview',
  ghState: 'nortuscc_gh_state',

  listBackups: 'nortuscc_list_backups',
  agentStatus: 'nortuscc_agent_status', accountState: 'nortuscc_account_state',
  watchSources: 'nortuscc_watch_sources', inspectSourceDiff: 'nortuscc_inspect_source_diff', pinImpact: 'nortuscc_pin_impact', draftChangelog: 'nortuscc_draft_changelog',
  setupReview: 'nortuscc_setup_review',
  inspectSetups: 'nortuscc_inspect_setups', incomingChanges: 'nortuscc_incoming_changes', prepareTrustRequest: 'nortuscc_prepare_trust_request',
  inspectUpdates: 'nortuscc_inspect_updates',
  inspectIntent: 'nortuscc_inspect_intent',
  resolveSkillCandidate: 'nortuscc_resolve_skill_candidate',
  getContext: 'nortuscc_get_context', inspect: 'nortuscc_inspect', previewChange: 'nortuscc_preview_change',
  applyChange: 'nortuscc_apply_change', getRun: 'nortuscc_get_run', listRuns: 'nortuscc_list_runs',
  cancelRun: 'nortuscc_cancel_run', abandonRun: 'nortuscc_abandon_run', history: 'nortuscc_history',
  remoteAccess: 'nortuscc_remote_access', setRemoteAccess: 'nortuscc_set_remote_access',
  myMachines: 'nortuscc_my_machines', machineSkills: 'nortuscc_machine_skills',
  applySkillOnMachines: 'nortuscc_apply_skill_on_machines', machineRun: 'nortuscc_machine_run',
} as const satisfies Record<OperationName, string>;
const descriptions: Record<OperationName, string> = {
  inspectProfiles: 'Read the followed profile and available named profiles.',
  inspectShareLink: 'Read shared setup metadata and prove Git read access before following. No subscription is created.',
  authorProfiles: 'Read all author profiles, inherited skills and files with their declaring documents.',
  machineFile: 'Read a built-in capturable file from this machine. Refuse capture if absent or truncated; never save partial text.',
  authorFile: 'Read a selected resolved author file from the private clone; truncated bytes cannot authorize capture.',
  upstreams: 'Read sources across all profiles and locally browsed sources, pins and cached discovery.',
  discoverUpstream: 'Discover the complete revision-bound skill list using the pinned skills CLI; unavailable results expose no partial list.',
  upstreamSkill: 'Read immutable upstream SKILL.md contents and file names at an exact commit.',
  drafts: 'List local drafts, including corrupt entries that can be deleted.',
  draftPreview: 'Replay a saved draft against fresh remote main; inspect every affected profile and the complete diff before publishDraft.',
  ghState: 'Read gh availability and GitHub authentication independently of the hosted account.',

  listBackups: 'List validated generated backup folder IDs, creation dates and latest History reference with observation-bound pagination. No content browsing or general restore.',
  agentStatus: 'Read bounded agent status, pending items, drift or conflicts. Manual policy and failure resume retain their meanings; no user pause tool.',
  accountState: 'Read bounded account, offered setup or machine metadata. Machine persistence distinguishes locally queued changes from server-confirmed values. Device authorization initiation does not imply signed in.',
  watchSources: 'Read up to eight declared sources and known trusted local checkout facts with observation-bound cursors. Limited or unavailable results never authorize a mutation. Continue with nextCursor for additional known sources.',
  inspectSourceDiff: 'Read a bounded skill diff between exact source revisions, or select localObservation from watchSources for known trusted checkout edits. Continuations revalidate local facts. Use the returned source and skill IDs; no caller paths.',
  pinImpact: 'Read source-wide pin impact for every declared skill and the resolved target revision. This read changes no pin.',
  draftChangelog: 'Draft a bounded changelog for up to eight accepted source revision pairs with report-validated ignored and added selections. No publication or intent writes.',

  setupReview: 'Review incoming setup values, holds, conflicts and source pin groups without scheduling or changing machine state.',
  inspectSetups: 'Read known setup identities and local trust without granting consent.',
  incomingChanges: 'Read verified exact setup revisions and incoming item identities without repository contents.',
  prepareTrustRequest: 'Prepare the existing app-local repository trust action. This read grants no trust and writes no consent.',
  inspectUpdates: 'Read bounded source-qualified skill update offers, selection keys, target policy and content identities. Addition repair requires resolveSkillCandidate, previewChange(addSkill) and applyChange. Unavailable observations never prove installation or authorization.',
  inspectIntent: 'Read bounded effective machine configuration, owned settings, declaration enablement, required targets, source policy and provenance. Reset reveals inherited intent. Intent changes save choices without installing or deleting content.',
  resolveSkillCandidate: 'Resolve an exact native selector or canonical installed name in a public GitHub source. Without source, search bounded configured and installed sources. Ambiguous candidates require source selection before preview.',
  getContext: 'Read the installed app, agent, setup and operation capabilities. Start here. Machine scope is the default.',
  inspect: 'Inspect current machine configuration and available reconcile keys.',
  previewChange: 'Preview followProfile with repoUrl, profile and setupId, using null for direct Git. Review dropped choices before a backed-up switch and inspect-only refetch. Preview pruneBackups for exact retention cleanup without backup-of-backups: keep newest 20, folders at most 90 days old and latest History reference. Batches remove at most 100 IDs; limited batches require another preview. No paths, folder selection or retention settings. Preview setPolicy, resume, signIn, signOut, syncAccount or patchMachineMetadata using existing owners. Sign-in starts device authorization only; use getRun for its short-lived challenge and finish in the browser. Metadata changes are locally queued until confirmed. Preview author changes through editDraft, removeDraftIntent and deleteDraft. Capture uses a captureFile intent with frozen text and an explicit updateShared or ownCopy choice. Saving a draft changes no checkout. Use draftPreview before publishDraft with its digest. Publication pushes main, tags the commit and announces profiles; announcePublication retries announcements or re-checks an uncertain push. ghLogin returns a pending run whose ghCode is visible through getRun while signing in. Direct sourceDecision, capture and authorManifest updates are retired. Machine-only update, reconcile, uninstallConfig, machineIntent, addSkill, setupApply, syncDecision, account and backup changes retain their shared owners. Review the preview and use applyChange with a stable requestId. Preview update with explicit authorManifest false for selected machine work, or reconciliation for explicitly selected inspected keys with optional targets, declined categories and force, config uninstall/restoration for selected recorded documents, machine intent, or an exact addSkill candidate. Config uninstall restores the entire selected recorded document including all recorded keys; it never removes integration or skill content. Force retains existing ownership guards. For skill additions select the current coding host target unless the user names another target or both; check getContext targets and clarify unavailable target setup in the app. Always send explicit targets. Host identity does not grant permission. Review the exact declaration, revision policy, selected native model catalogs and shared-store visibility: Codex also scans the shared store. Targets require usable exposure; they do not promise exclusive visibility. Preview skillNow with source, name and action install or remove: Install or remove one skill on this machine now. Installs bundled scripts without asking.',
  applyChange: 'Apply a reviewed plan and return its durable run immediately. Keep the same caller-chosen requestId when retrying uncertain acceptance; query the run for completion.',
  getRun: 'Read a durable operation run after reconnecting. Inspect committed and remaining effects, uncertain outcomes, backups and the configured author destination. Partial results require inspection before another preview. Saved machine intent is separate from installation. Only after installation is verified, ask: Do you want to share it with your other machines? If the user agrees and share_with_my_machines is available, list them with myMachines and install it with applySkillOnMachines. Also mention promotion to an owned profile. Follow nextActions readiness, destination and prerequisite reasons. Never share or promote without a user request. Failed, cancelled or incomplete installation offers neither. Claude catalog discovery does not attest selected source or invocation authorization.',
  listRuns: 'List durable operation runs with bounded pagination.',
  cancelRun: 'Request cancellation of a machine operation run and read its settled receipt.',
  abandonRun: 'Mark an interrupted run abandoned while retaining its steps, committed and remaining keys, backups and result. Interrupted runs never block new applies or app updates.',
  remoteAccess: 'Read whether remote access is on for this machine, Tailscale readiness and whether it is listening.',
  setRemoteAccess: 'Turn remote access for this machine on or off. Only works from the app or CLI at this machine; MCP callers are refused with FORBIDDEN.',
  myMachines: 'List the user\'s other machines on their Tailscale tailnet: those reached before or answering now, with each machine\'s nodeId, name, OS and reach: ok, offline, app-closed, remote-off or incompatible. Only ok machines can be read or changed. notSetUp lists the user\'s desktop machines whose app has never answered; tell the user to turn on remote access in the app on them.',
  machineSkills: 'Read the skills on one of the user\'s machines: machine is "this" or a nodeId from myMachines. States are installed, absent, undeclared (installed outside the app) or profile-off. An undeclared skill with a null source cannot be copied to other machines. It answers from the machine\'s last inspection with its inspectedAt; fresh re-inspects it first, unless a change is running there: then it answers from the last inspection with busy true, so read again after that change finishes.',
  applySkillOnMachines: 'Install or remove one skill on the user\'s other machines now: machines is a list of "this" and nodeIds from myMachines, or "all" for every reachable machine plus this one. This acts on those machines without review there: each one installs immediately, including bundled scripts, or removes the copy the app installed. Use it only when the user asked for these machines. Keep the same requestId when retrying; it returns the same runs. Each machine answers started with a runId, refused with a reason, or offline; nothing is queued. Poll machineRun for each started run.',
  machineRun: 'Read a run that applySkillOnMachines started on one of the user\'s machines ("this" or its nodeId) until it is no longer accepted or running.',
  history: 'Read bounded safe History details for decisions, setups, revisions, policy, pause and backup retention, with shared actor and durable operation attribution. Unknown historical events use a constant fallback.',
};

// Standard Schema delegates validation and JSON Schema publication to the shared operation contract.
function schema(name: OperationName, side: 'input' | 'output'): StandardSchemaWithJSON {
  const json = operationJsonSchemas[name][side];
  return { '~standard': { version: 1, vendor: 'nortuscc',
    validate: value => {
      try { return { value: side === 'input' ? decodeOperationInput(name, value) : decodeOperationOutput(name, value) }; }
      catch { return { issues: [{ message: side === 'input' ? 'Invalid operation arguments. Use the advertised tool schema.' : 'The agent returned an invalid operation result.' }] }; }
    },
    // Every shared result is an object, including object-only union roots.
    jsonSchema: { input: () => side === 'output' ? { type: 'object', ...json } : json,
      output: () => side === 'output' ? { type: 'object', ...json } : json },
  } };
}

// Never forward exception text: local transport errors may contain credentials or machine paths.
function safeError(error: unknown) {
  if (error instanceof AgentUnavailable) return { code: 'APP_UNAVAILABLE', message: 'The app-owned agent is unavailable. Open Nortuscc and finish setup or repair its agent, then reconnect. If acceptance was uncertain, retry with the same requestId.' };
  if (error instanceof AgentError) {
    const messages: Record<string, string> = {
      TARGET_UNAVAILABLE: 'A selected skill target is unavailable in setup context. Check getContext targets and configure that target in Nortuscc before previewing it.',
      SKILL_INSTALL_UNAVAILABLE: 'Skill installation prerequisites are unavailable. Open Nortuscc to check the explicit native destination, shared-store and lock mapping before resolving and previewing again.',
      APP_UNAVAILABLE: 'The app-owned agent or gh is unavailable. Open Nortuscc to check agent setup and GitHub prerequisites.',
      NOT_SIGNED_IN: 'Sign in to GitHub with ghLogin, or configure the hosted account in Nortuscc, then preview again.',
      MALFORMED: 'The agent returned an invalid reply. Open Nortuscc to check runtime compatibility, then reconnect.',
      UNAUTHORIZED: 'GitHub repository access or agent authentication was refused. Check repository push permission and the app-owned agent.',
      LOCKED: 'Machine mutations are blocked by maintenance. Complete or recover the update in Nortuscc.',
      BUSY: 'Another machine operation is active. Check current runs and retry after it settles.',
      UNKNOWN_PLAN: 'The preview is no longer available. Inspect, resolve any skill candidate again, and preview the requested change.',
      UNSUPPORTED_SCOPE: 'Only machine scope is currently available. User and profile scopes cannot be applied.',
      UNKNOWN_RUN: 'The run is unavailable. List runs to find a retained receipt.',
      REQUEST_CONFLICT: 'This requestId already identifies a different accepted intent. Query the existing run; use a new requestId for a different intent.',
      TIMEOUT: 'The agent did not answer in time. Acceptance may be uncertain. Query runs or retry with the same requestId.',
      CLOSED: 'The agent connection closed. Acceptance may be uncertain. Query runs or retry with the same requestId.',
    };
    const code = Object.hasOwn(messages, error.code) ? error.code : 'OPERATION_FAILED';
    return { code, message: messages[code] ?? 'The agent refused this operation. Inspect context and current runs in Nortuscc before retrying.' };
  }
  return { code: 'OPERATION_FAILED', message: 'The operation failed. Check Nortuscc and reconnect. If acceptance was uncertain, query runs or retry with the same requestId.' };
}

export function createMcpServer(input: {
  readonly agentClient: AppAgentClient;
  readonly definitions?: typeof operationDefinitions;
}): McpServer {
  const server = new McpServer({ name: 'nortuscc', version: '1' }, { capabilities: { tools: {} }, maxToolInputElements: 20_000 });
  for (const name of Object.keys(input.definitions ?? operationDefinitions) as OperationName[]) {
    const definition = (input.definitions ?? operationDefinitions)[name];
    server.registerTool(toolNames[name], {
      description: descriptions[name], inputSchema: schema(name, 'input'), outputSchema: schema(name, 'output'),
      annotations: { readOnlyHint: !definition.mutation, destructiveHint: definition.mutation, openWorldHint: ['resolveSkillCandidate', 'previewChange', 'myMachines', 'machineSkills', 'applySkillOnMachines', 'machineRun', 'authorProfiles', 'authorFile', 'upstreams', 'discoverUpstream', 'upstreamSkill', 'draftPreview'].includes(name) },
    }, async args => {
      try {
        const result = decodeOperationOutput(name, await input.agentClient.operation(name, decodeOperationInput(name, args)));
        return { structuredContent: result as unknown as JSONObject, content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const result = { error: safeError(error) };
        return { isError: true, structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    });
  }
  return server;
}
