import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { runMcpEntry } from '../mcp/main.ts';

// The app MCP entry's platform gates, with an injected platform and a fake agent connection.
const layouts = {
  darwin: { target: 'darwin-arm64', resources: 'Nortuscc.app/Contents/Resources/agent-runtime', app: 'Nortuscc.app/Contents/MacOS/Nortuscc' },
  win32: { target: 'win32-x64', resources: 'Nortuscc/agent-runtime', app: 'Nortuscc/Nortuscc.exe' },
} as const;

const fixture = (t: { after: (f: () => void) => void }, layout: keyof typeof layouts, target: string = layouts[layout].target) => {
  const root = mkdtempSync(join(tmpdir(), 'nme-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, layouts[layout].resources);
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, 'runtime.json'), JSON.stringify({ target, appVersion: '0.1.6', agentVersion: 'bundle-hash' }));
  return { root, resources, app: join(root, layouts[layout].app), env: { HOME: root, NORTUSCC_STATE_DIR: join(root, 'state') } };
};

// Speaks newline-delimited MCP to an in-process entry and returns each reply by id.
const serve = async (f: ReturnType<typeof fixture>, platform: NodeJS.Platform) => {
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const connected: string[] = [];
  const handle = await runMcpEntry({ args: ['--app', f.app], env: f.env, resources: f.resources, platform, stdin, stdout, stderr: () => {},
    connect: async input => { connected.push(input.expectedApp); throw new Error('no agent in this fixture'); } });
  let buffer = ''; const replies = new Map<number, any>(); const waiting = new Map<number, (value: any) => void>();
  stdout.on('data', chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const record = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      replies.set(record.id, record); waiting.get(record.id)?.(record);
    }
  });
  const ask = (id: number, method: string, params: object = {}) => new Promise<any>(resolve => {
    waiting.set(id, resolve); stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { handle, ask, connected, notify: (method: string) => stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n') };
};

for (const platform of ['darwin', 'win32'] as const) {
  test(`${platform}: the installed layout and its own runtime target serve MCP initialize and tools/list`, async t => {
    const f = fixture(t, platform);
    const mcp = await serve(f, platform);
    try {
      const init = await mcp.ask(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
      assert.equal(init.result.protocolVersion, '2025-11-25');
      mcp.notify('notifications/initialized');
      const tools = await mcp.ask(2, 'tools/list');
      assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === 'nortuscc_get_context'));
      assert.deepEqual(mcp.connected, [], 'listing tools does not contact the agent');
    } finally { await mcp.handle.close(); }
  });
}

test('each platform refuses the other platform\'s runtime target and app layout', async t => {
  const wrongTarget = fixture(t, 'win32', 'darwin-arm64');
  await assert.rejects(runMcpEntry({ args: ['--app', wrongTarget.app], env: wrongTarget.env, resources: wrongTarget.resources, platform: 'win32' }), /incompatible/);
  const macTarget = fixture(t, 'darwin', 'win32-x64');
  await assert.rejects(runMcpEntry({ args: ['--app', macTarget.app], env: macTarget.env, resources: macTarget.resources, platform: 'darwin' }), /incompatible/);
  const macLayout = fixture(t, 'darwin');
  await assert.rejects(runMcpEntry({ args: ['--app', macLayout.app], env: macLayout.env, resources: macLayout.resources, platform: 'win32' }), /identity/);
  const windowsLayout = fixture(t, 'win32');
  await assert.rejects(runMcpEntry({ args: ['--app', windowsLayout.app], env: windowsLayout.env, resources: windowsLayout.resources, platform: 'darwin' }), /identity/);
});

test('other platforms stay unsupported', async t => {
  const f = fixture(t, 'darwin');
  await assert.rejects(runMcpEntry({ args: ['--app', f.app], env: f.env, resources: f.resources, platform: 'linux' }), /requires macOS arm64 or Windows x64/);
});
