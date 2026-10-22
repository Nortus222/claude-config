import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Where the agent records its per-start pipe name on Windows (ADR 0040), beside agent.token.
export const AGENT_PIPE_FILE = 'agent.pipe';

const PIPE_NAME = /^\\\\\.\\pipe\\nortuscc-agent-[0-9a-f]{32}$/;

// The agent's endpoint cannot be found: no agent.pipe, or one that does not name a local agent pipe.
export class AgentEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEndpointError';
  }
}

// A fresh pipe name for one agent start: `\\.\pipe\nortuscc-agent-<32 lowercase hex>`.
export const newPipeName = (): string => `\\\\.\\pipe\\nortuscc-agent-${randomBytes(16).toString('hex')}`;

// The path a client connects to for the agent whose directory is `agentDir`: agent.sock off Windows;
// on Windows the pipe named in agent.pipe, read fresh. Throws AgentEndpointError when that file is
// missing or does not hold a valid name.
export const agentEndpoint = (agentDir: string, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') return join(agentDir, 'agent.sock');
  const file = join(agentDir, AGENT_PIPE_FILE);
  let name: string;
  try {
    name = readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new AgentEndpointError(`the agent has no ${AGENT_PIPE_FILE} (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!PIPE_NAME.test(name)) throw new AgentEndpointError(`${file} does not name an agent pipe`);
  return name;
};
