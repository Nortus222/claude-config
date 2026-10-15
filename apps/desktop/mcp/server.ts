import { McpServer, type StandardSchemaWithJSON, type JSONObject } from '@modelcontextprotocol/server';
import { decodeOperationInput, decodeOperationOutput, operationDefinitions, operationJsonSchemas, type OperationName } from '@nortuscc/agent/operations';
import { AgentError, AgentUnavailable } from '../../../src/agent-client.ts';
import type { AppAgentClient } from './client.ts';

export const toolNames = {
  resolveSkillCandidate: 'nortuscc_resolve_skill_candidate',
  getContext: 'nortuscc_get_context', inspect: 'nortuscc_inspect', previewChange: 'nortuscc_preview_change',
  applyChange: 'nortuscc_apply_change', getRun: 'nortuscc_get_run', listRuns: 'nortuscc_list_runs',
  cancelRun: 'nortuscc_cancel_run', history: 'nortuscc_history',
} as const;
const descriptions: Record<OperationName, string> = {
  resolveSkillCandidate: 'Resolve an exact native selector or canonical installed name in a public GitHub source. Without source, search bounded configured and installed sources. Ambiguous candidates require source selection before preview.',
  getContext: 'Read the installed app, agent, setup and operation capabilities. Start here. Machine scope is the default.',
  inspect: 'Inspect current machine configuration and available reconcile keys.',
  previewChange: 'Preview reconciliation for explicitly selected inspected keys, or an exact addSkill candidate. For skill additions select the current coding host target unless the user names another target or both; check getContext targets and clarify unavailable target setup in the app. Always send explicit targets. Host identity does not grant permission. Review declaration enablement, source revision and shared-store Codex visibility. Skill installation is currently unavailable.',
  applyChange: 'Apply a reviewed plan and return its durable run immediately. Keep the same caller-chosen requestId when retrying uncertain acceptance; query the run for completion.',
  getRun: 'Read a durable operation run, including its outcomes, after reconnecting.',
  listRuns: 'List durable operation runs with bounded pagination.',
  cancelRun: 'Request cancellation of a machine operation run and read its settled receipt.',
  history: 'Read bounded operation History, including actor and durable intent attribution.',
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
      SKILL_INSTALL_UNAVAILABLE: 'Skill installation requires the durable verified-addition driver. Discovery and preview are available.',
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
