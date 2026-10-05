import { build } from 'esbuild';
import { mkdir, copyFile, chmod, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const target = `${process.platform}-${process.arch}`;
if (target !== 'darwin-arm64')
  throw new Error('This validation package currently targets macOS arm64.');
const resources = resolve(root, 'src-tauri/resources', target);
await mkdir(resources, { recursive: true });
await build({
  entryPoints: [resolve(root, 'backend/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: resolve(resources, 'backend.mjs'),
});
const runtime = resolve(resources, process.platform === 'win32' ? 'node.exe' : 'node');
const sourceRuntime = process.env.DESKTOP_NODE_RUNTIME || process.execPath;
const { execFileSync } = await import('node:child_process');
if (process.platform === 'darwin') {
  const linked = execFileSync('/usr/bin/otool', ['-L', sourceRuntime], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .filter(Boolean);
  if (
    linked.some(
      (line) => !line.trim().startsWith('/usr/lib/') && !line.trim().startsWith('/System/Library/'),
    )
  )
    throw new Error(
      'Node links external libraries. Set DESKTOP_NODE_RUNTIME to an official standalone Node binary.',
    );
}
const nodeVersion = execFileSync(sourceRuntime, ['-p', 'process.versions.node'], {
  encoding: 'utf8',
}).trim();
const [major, minor] = nodeVersion.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12))
  throw new Error('Bundled Node must be 22.12 or newer.');
await copyFile(sourceRuntime, runtime);
await chmod(runtime, 0o755);
await copyFile(resolve(root, 'node_modules/effect/LICENSE'), resolve(resources, 'EFFECT-LICENSE'));
// The official distribution license includes notices for bundled dependencies.
const licensePath = process.env.DESKTOP_NODE_LICENSE || resolve(sourceRuntime, '../../LICENSE');
await copyFile(licensePath, resolve(resources, 'NODE-LICENSE'));
await writeFile(
  resolve(resources, 'runtime.json'),
  JSON.stringify(
    { target, node: nodeVersion, executable: process.platform === 'win32' ? 'node.exe' : 'node' },
    null,
    2,
  ),
);
console.log(`Bundled backend and Node ${nodeVersion} for ${target}`);
