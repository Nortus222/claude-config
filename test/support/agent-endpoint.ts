import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PIPE_FILE, newPipeName } from '@nortuscc/sync';

// A fresh temporary directory short enough to hold a Unix socket: under /tmp off Windows, where the
// endpoint is a pipe and the path length does not matter.
export const shortTempDir = (prefix: string): string =>
  mkdtempSync(process.platform === 'win32' ? join(tmpdir(), prefix) : `/tmp/${prefix}`);

// Listens `server` where clients find the agent whose directory is `agentDir`: agent.sock, or on
// Windows a fresh pipe named in agent.pipe once listening (ADR 0040).
export const listenAgent = async (server: Server, agentDir: string): Promise<void> => {
  const pipe = process.platform === 'win32';
  const endpoint = pipe ? newPipeName() : join(agentDir, 'agent.sock');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (pipe) writeFileSync(join(agentDir, AGENT_PIPE_FILE), endpoint + '\n');
};
