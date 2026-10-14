import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify final packaged bytes without refreshing metadata or changing signed artifacts.
export async function verifyAppRuntime(app, version) {
  const resources = join(app, 'Contents/Resources/agent-runtime');
  const read = async file => {
    const path = join(resources, file);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > (file === 'bun' ? 268_435_456 : file === 'runtime.json' ? 16_384 : 67_108_864)) throw new Error('Invalid packaged runtime file');
    return readFile(path);
  };
  const metadata = JSON.parse((await read('runtime.json')).toString('utf8'));
  if (metadata.target !== 'darwin-arm64' || metadata.appVersion !== version || metadata.maintenanceProtocol !== 1 || metadata.executable !== 'bun' || metadata.mcp?.protocol !== 1 || metadata.mcp?.executable !== 'mcp.mjs' || metadata.mcp?.sdk !== '2.3.1') throw new Error('Packaged runtime compatibility mismatch');
  const hashes = {
    bunSha256: createHash('sha256').update(await read('bun')).digest('hex'),
    agentVersion: createHash('sha256').update(await read('agent.mjs')).digest('hex'),
    mcpSha256: createHash('sha256').update(await read('mcp.mjs')).digest('hex'),
  };
  if (hashes.bunSha256 !== metadata.bunSha256 || hashes.agentVersion !== metadata.agentVersion || hashes.mcpSha256 !== metadata.mcp.sha256) throw new Error('Packaged runtime hash mismatch');
  return hashes;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: verify-runtime.mjs <finished.app> <version>');
    console.log(JSON.stringify(await verifyAppRuntime(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
