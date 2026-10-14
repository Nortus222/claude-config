import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
test('finished app validation independently hashes shipped Bun, agent and MCP bytes', async () => {
  const { verifyAppRuntime } = await import('../scripts/verify-runtime.mjs');
  const root = await mkdtemp(join(tmpdir(), 'app-integrity-'));
  const app = join(root, 'Nortuscc.app');
  const resources = join(app, 'Contents/Resources/agent-runtime');
  await mkdir(resources, { recursive: true });
  const metadata = { target: 'darwin-arm64', appVersion: '0.1.6', maintenanceProtocol: 1, executable: 'bun', bunSha256: hash('bun'), agentVersion: hash('agent'), mcp: { protocol: 1, executable: 'mcp.mjs', sdk: '2.3.1', sha256: hash('mcp') } };
  try {
    await writeFile(join(resources, 'runtime.json'), JSON.stringify(metadata));
    for (const [file, bytes] of [['bun', 'bun'], ['agent.mjs', 'agent'], ['mcp.mjs', 'mcp']] as const) await writeFile(join(resources, file), bytes);
    const verified = await verifyAppRuntime(app, '0.1.6');
    assert.deepEqual(verified, { bunSha256: metadata.bunSha256, agentVersion: metadata.agentVersion, mcpSha256: metadata.mcp.sha256 });
    for (const [file, bytes] of [['bun', 'bun'], ['agent.mjs', 'agent'], ['mcp.mjs', 'mcp']] as const) {
      await writeFile(join(resources, file), bytes + ' altered after signing');
      await assert.rejects(() => verifyAppRuntime(app, '0.1.6'), /hash mismatch/);
      await writeFile(join(resources, file), bytes);
    }
    await assert.rejects(() => verifyAppRuntime(app, '9.9.9'), /compatibility/);
    assert.equal(JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')).agentVersion, metadata.agentVersion, 'verification never rewrites metadata');
  } finally { await rm(root, { recursive: true, force: true }); }
});
