import { build } from 'esbuild';
import { bundleMcp } from './bundle-mcp.mjs';
import { bundleRuntimeLicenses } from './bundle-runtime-licenses.mjs';
import { mkdir, copyFile, chmod, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.env.DESKTOP_TARGET || `${process.platform}-${process.arch}`;
if (target !== 'darwin-arm64' && target !== 'win32-x64')
  throw new Error('Desktop resources target darwin-arm64 or win32-x64.');
const windows = target === 'win32-x64';
const executable = windows ? 'bun.exe' : 'bun';
const resources = resolve(root, 'src-tauri/resources', target);
// Tauri packages the whole directory, so stale runtimes must not survive a rebuild.
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await build({
  entryPoints: [resolve(root, 'agent/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'esnext',
  outfile: resolve(resources, 'agent.mjs'),
});
const mcp = await bundleMcp({ root, resources });
const sourceRuntime =
  process.env.DESKTOP_BUN_RUNTIME ||
  execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim();
// Windows Bun is a self-contained PE; the dylib allow-list is a macOS check.
const linked = windows ? [] : execFileSync('/usr/bin/otool', ['-L', sourceRuntime], { encoding: 'utf8' })
  .split('\n')
  .slice(1)
  .filter(Boolean);
if (
  linked.some(
    (line) => !line.trim().startsWith('/usr/lib/') && !line.trim().startsWith('/System/Library/'),
  )
)
  throw new Error(
    'Bun links external libraries. Set DESKTOP_BUN_RUNTIME to an official standalone Bun binary.',
  );
const bunVersion = execFileSync(sourceRuntime, ['--version'], { encoding: 'utf8' }).trim();
const [major, minor] = bunVersion.split('.').map(Number);
if (major < 1 || (major === 1 && minor < 3)) throw new Error('Bundled Bun must be 1.3 or newer.');
// Bun releases ship without a license file; its LICENSE.md lists the statically linked notices.
const licensePath = process.env.DESKTOP_BUN_LICENSE;
if (!licensePath)
  throw new Error(`Set DESKTOP_BUN_LICENSE to LICENSE.md from Bun's bun-v${bunVersion} tag.`);
const runtime = resolve(resources, executable);
await copyFile(sourceRuntime, runtime);
if (!windows) await chmod(runtime, 0o755);
await copyFile(licensePath, resolve(resources, 'BUN-LICENSE.md'));
await bundleRuntimeLicenses(resources);
await writeFile(
  resolve(resources, 'runtime.json'),
  JSON.stringify({ target, appVersion: JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version, maintenanceProtocol: 1, mcp, bun: bunVersion, bunSha256: createHash('sha256').update(await readFile(runtime)).digest('hex'), executable, agentVersion: createHash('sha256').update(await readFile(resolve(resources, 'agent.mjs'))).digest('hex') }, null, 2),
);
console.log(`Bundled agent, MCP and Bun ${bunVersion} for ${target}`);
