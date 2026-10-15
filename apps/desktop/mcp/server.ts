import { McpServer, type StandardSchemaWithJSON, type JSONObject } from '@modelcontextprotocol/server';
import { decodeOperationInput, decodeOperationOutput, operationDefinitions, operationJsonSchemas, type OperationName } from '@nortuscc/agent/operations';
import { AgentError, AgentUnavailable } from '../../../src/agent-client.ts';
import type { AppAgentClient } from './client.ts';

export const toolNames = {
  listBackups: 'nortuscc_list_backups',
  agentStatus: 'nortuscc_agent_status', accountState: 'nortuscc_account_state',
  watchSources: 'nortuscc_watch_sources', inspectSourceDiff: 'nortuscc_inspect_source_diff', pinImpact: 'nortuscc_pin_impact', draftChangelog: 'nortuscc_draft_changelog',
  inspectSetups: 'nortuscc_inspect_setups', incomingChanges: 'nortuscc_incoming_changes', prepareTrustRequest: 'nortuscc_prepare_trust_request',
  inspectUpdates: 'nortuscc_inspect_updates',
  inspectIntent: 'nortuscc_inspect_intent',
  resolveSkillCandidate: 'nortuscc_resolve_skill_candidate',
  getContext: 'nortuscc_get_context', inspect: 'nortuscc_inspect', previewChange: 'nortuscc_preview_change',
  applyChange: 'nortuscc_apply_change', getRun: 'nortuscc_get_run', listRuns: 'nortuscc_list_runs',
  cancelRun: 'nortuscc_cancel_run', history: 'nortuscc_history',
} as const;
const descriptions: Record<OperationName, string> = {
  listBackups: 'List validated generated backup folder IDs, creation dates and latest History reference with observation-bound pagination. No content browsing or general restore.',
  agentStatus: 'Read bounded agent status, pending items, drift or conflicts. Manual policy and failure resume retain their meanings; no user pause tool.',
  accountState: 'Read bounded account, offered setup or machine metadata. Machine persistence distinguishes locally queued changes from server-confirmed values. Device authorization initiation does not imply signed in.',
  watchSources: 'Read up to eight declared sources and known trusted local checkout facts with observation-bound cursors. Limited or unavailable results never authorize a mutation. Continue with nextCursor for additional known sources.',
  inspectSourceDiff: 'Read a bounded skill diff between exact source revisions, or select localObservation from watchSources for known trusted checkout edits. Continuations revalidate local facts. Use the returned source and skill IDs; no caller paths.',
  pinImpact: 'Read source-wide pin impact for every declared skill and the resolved target revision. This read changes no pin.',
  draftChangelog: 'Draft a bounded changelog for up to eight accepted source revision pairs with report-validated ignored and added selections. No publication or intent writes.',

  inspectSetups: 'Read known setup identities and local trust without granting consent.',
  incomingChanges: 'Read verified exact setup revisions and incoming item identities without repository contents.',
  prepareTrustRequest: 'Prepare the existing app-local repository trust action. This read grants no trust and writes no consent.',
  inspectUpdates: 'Read bounded source-qualified skill update offers, selection keys, target policy and content identities. Addition repair requires resolveSkillCandidate, previewChange(addSkill) and applyChange. Unavailable observations never prove installation or authorization.',
  inspectIntent: 'Read bounded effective machine configuration, owned settings, declaration enablement, required targets, source policy and provenance. Reset reveals inherited intent. Intent changes save choices without installing or deleting content.',
  resolveSkillCandidate: 'Resolve an exact native selector or canonical installed name in a public GitHub source. Without source, search bounded configured and installed sources. Ambiguous candidates require source selection before preview.',
  getContext: 'Read the installed app, agent, setup and operation capabilities. Start here. Machine scope is the default.',
  inspect: 'Inspect current machine configuration and available reconcile keys.',
  previewChange: 'Preview pruneBackups for exact retention cleanup without backup-of-backups: keep newest 20, folders at most 90 days old and latest History reference. Batches remove at most 100 IDs; limited batches require another preview. No paths, folder selection or retention settings. Preview setPolicy, resume, signIn, signOut, syncAccount or patchMachineMetadata using existing owners. Sign-in starts device authorization only; use getRun for its short-lived challenge and finish in the browser. Metadata changes are locally queued until confirmed. Preview sourceDecision pin/unpin/ignore/unignore using a known source ID. Pin/ignore require a full lowercase SHA; reset actions forbid revision. Source edits bind configured author documents, HEAD/index, fresh source revision, exact backups and separate machine policy; ignore only suppresses source notifications. No publication or installation is authorized. Preview update with explicit authorManifest false for selected machine work, or true for a separately reviewed configured author manifest edit, or reconciliation for explicitly selected inspected keys with optional targets, declined categories and force, config uninstall/restoration for selected recorded documents, selected configuration capture into the configured author checkout, machine intent, or an exact addSkill candidate. Capture requires explicit only keys; skills:manifest authorizes whole-manifest regeneration with held declarations and a shrink guard. Capture previews redact bodies and bind exact author bytes, HEAD and selected index entries; observation snapshots remain unchanged. Config uninstall restores the entire selected recorded document including all recorded keys; it never removes integration or skill content. Force retains existing ownership guards. For skill additions select the current coding host target unless the user names another target or both; check getContext targets and clarify unavailable target setup in the app. Always send explicit targets. Host identity does not grant permission. Review the exact declaration, revision policy, selected native model catalogs and shared-store visibility: Codex also scans the shared store. Targets require usable exposure; they do not promise exclusive visibility.',
  applyChange: 'Apply a reviewed plan and return its durable run immediately. Keep the same caller-chosen requestId when retrying uncertain acceptance; query the run for completion.',
  getRun: 'Read a durable operation run after reconnecting. Saved machine intent is separate from installation. Only after installation is verified, ask: Do you want to share it with your other machines? Also mention promotion to an owned profile. Follow nextActions readiness, destination and prerequisite reasons. Never share or promote without a user request. Failed, cancelled or incomplete installation offers neither. Claude catalog discovery does not attest selected source or invocation authorization.',
  listRuns: 'List durable operation runs with bounded pagination.',
  cancelRun: 'Request cancellation of a machine operation run and read its settled receipt.',
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
      APP_UNAVAILABLE: 'Open Nortuscc and finish setup or repair its app-owned agent, then reconnect.',
      MALFORMED: 'The agent returned an invalid reply. Open Nortuscc to check runtime compatibility, then reconnect.',
      UNAUTHORIZED: 'The agent refused authentication. Open Nortuscc to check its app-owned agent, then reconnect.',
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
      annotations: { readOnlyHint: !definition.mutation, destructiveHint: definition.mutation, openWorldHint: name === 'resolveSkillCandidate' || name === 'previewChange' },
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
