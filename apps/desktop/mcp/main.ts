import type { Readable, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Effect } from 'effect';
import { pathsFromEnvironment } from '@nortuscc/machine/paths';
import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { connectAppAgent, type AppAgentClient } from './client.ts';
import { createMcpServer } from './server.ts';

export type McpEntryInput = {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly resources: string;
  readonly platform?: NodeJS.Platform;
  readonly connect?: typeof connectAppAgent;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: (text: string) => void;
};

// Resolves only app-relative metadata and machine paths; never installs, repairs or adopts a setup.
export async function runMcpEntry(input: McpEntryInput): Promise<StdioServerHandle> {
  const [flag, expectedApp] = input.args;
  if (input.args.length !== 2 || flag !== '--app' || !expectedApp || !isAbsolute(expectedApp)
    || /[\x00-\x1f\x7f]/.test(expectedApp) || dirname(expectedApp) !== resolve(input.resources, '../../MacOS'))
    throw new Error('MCP requires its installed app executable identity.');
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') throw new Error('App MCP currently requires macOS arm64.');
  const metadata: unknown = JSON.parse(await readFile(resolve(input.resources, 'runtime.json'), 'utf8'));
  if (typeof metadata !== 'object' || metadata === null || !('target' in metadata) || metadata.target !== 'darwin-arm64'
    || !('agentVersion' in metadata) || typeof metadata.agentVersion !== 'string' || !/^[^\x00-\x1f\x7f]{1,100}$/.test(metadata.agentVersion))
    throw new Error('App MCP runtime metadata is unavailable or incompatible.');
  const expectedRuntime = metadata.agentVersion;
  const home = input.env.HOME ?? homedir();
  const paths = await Effect.runPromise(pathsFromEnvironment({ env: input.env, home, platform, fallbackRepo: home }));
  const client: AppAgentClient = {
    operation: async (name, args) => {
      const connection = await (input.connect ?? connectAppAgent)({ stateRoot: paths.stateRoot, expectedRuntime, expectedApp });
      try { return await connection.operation(name, args); } finally { connection.close(); }
    },
    close: () => {},
  };
  const stderr = input.stderr ?? (text => { process.stderr.write(text); });
  return serveStdio(() => createMcpServer({ agentClient: client }), {
    transport: new StdioServerTransport(input.stdin, input.stdout),
    onerror: () => stderr('Nortuscc MCP protocol error. Check the client configuration and reconnect.\n'),
  });
}
const entry = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === entry) {
  try { await runMcpEntry({ args: process.argv.slice(2), env: process.env, resources: dirname(entry) }); }
  catch { process.stderr.write('Nortuscc MCP could not start. Open the installed app and check its runtime and connection settings.\n'); process.exitCode = 1; }
}
