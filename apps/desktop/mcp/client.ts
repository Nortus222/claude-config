import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { connectAgent, AgentError, type AgentConnection } from '../../../src/agent-client.ts';
import { PROTOCOL_VERSION, OPERATIONS_PROTOCOL_VERSION } from '@nortuscc/agent/ipc/protocol';
import { decodeOperationInput, decodeOperationOutput, type OperationInput, type OperationName, type OperationOutput } from '@nortuscc/agent/operations';

export type AppAgentClient = {
  readonly operation: <N extends OperationName>(name: N, input: OperationInput<N>) => Promise<OperationOutput<N>>;
  readonly close: () => void;
};

// Authenticates to the installed app's agent without changing its registration or lifecycle.
export async function connectAppAgent(input: {
  readonly stateRoot: string;
  readonly expectedRuntime: string;
  readonly expectedApp: string;
  readonly connect?: typeof connectAgent;
}): Promise<AppAgentClient> {
  const registered = async (diagnostics: boolean) => {
    try {
      const text = await readFile(join(input.stateRoot, 'agent', 'agent.json'), 'utf8');
      if (text.length > 1_048_576) return false;
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        && 'version' in value && value.version === 1
        && 'installedBy' in value && (value.installedBy === 'app' || (diagnostics && value.installedBy === 'cli'))
        && 'agentVersion' in value && typeof value.agentVersion === 'string' && (diagnostics || value.agentVersion === input.expectedRuntime)
        && 'appPath' in value && typeof value.appPath === 'string' && isAbsolute(value.appPath)
        && value.appPath === input.expectedApp;
    } catch { return false; }
  };
  const checkRegistration = async (diagnostics = false) => {
    if (!await registered(diagnostics)) throw new AgentError('APP_UNAVAILABLE', 'Reconnect from the currently registered Nortuscc app.');
  };
  await checkRegistration(true);
  const connection: AgentConnection = await (input.connect ?? connectAgent)({ stateRoot: input.stateRoot }, { client: 'mcp', runtimeId: input.expectedRuntime });
  const hello = connection.hello;
  const compatible = hello.protocol === PROTOCOL_VERSION && hello.operationsProtocol === OPERATIONS_PROTOCOL_VERSION;
  const ready = compatible && hello.app?.ownership === 'app' && hello.app.runtimeId === input.expectedRuntime
    && hello.agentVersion === input.expectedRuntime && hello.operations?.available === true;
  return {
    operation: async (name, args) => {
      await checkRegistration(name === 'getContext');
      if (!compatible || (name !== 'getContext' && !ready))
        throw new AgentError('APP_UNAVAILABLE', 'Open Nortuscc and finish setup or repair its app-owned agent, then reconnect.');
      const result = await connection.request({ command: 'operation', operation: name, input: decodeOperationInput(name, args) });
      return decodeOperationOutput(name, result);
    },
    close: connection.close,
  };
}
