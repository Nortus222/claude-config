import { build } from 'esbuild';
import { mkdir, copyFile, chmod, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const target = `${process.platform}-${process.arch}`;
if (target !== 'darwin-arm64')
  throw new Error('This validation package currently targets macOS arm64.');
const resources = resolve(root, 'src-tauri/resources', target);
// Tauri packages the whole directory, so stale runtimes must not survive a rebuild.
await rm(resources, { recursive: true, force: true });
await mkdir(resources, { recursive: true });
await build({
  entryPoints: [resolve(root, 'backend/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'esnext',
  outfile: resolve(resources, 'backend.mjs'),
});
const sourceRuntime =
  process.env.DESKTOP_BUN_RUNTIME ||
  execFileSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf8' }).trim();
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
    'Bun links external libraries. Set DESKTOP_BUN_RUNTIME to an official standalone Bun binary.',
  );
const bunVersion = execFileSync(sourceRuntime, ['--version'], { encoding: 'utf8' }).trim();
const [major, minor] = bunVersion.split('.').map(Number);
if (major < 1 || (major === 1 && minor < 3)) throw new Error('Bundled Bun must be 1.3 or newer.');
// Bun releases ship without a license file; its LICENSE.md lists the statically linked notices.
const licensePath = process.env.DESKTOP_BUN_LICENSE;
if (!licensePath)
  throw new Error(`Set DESKTOP_BUN_LICENSE to LICENSE.md from Bun's bun-v${bunVersion} tag.`);
const runtime = resolve(resources, 'bun');
await copyFile(sourceRuntime, runtime);
await chmod(runtime, 0o755);
await copyFile(licensePath, resolve(resources, 'BUN-LICENSE.md'));
// Effect is hoisted to the workspace root, so find it the way Node would.
const effectRoot = dirname(createRequire(import.meta.url).resolve('effect/package.json'));
await copyFile(resolve(effectRoot, 'LICENSE'), resolve(resources, 'EFFECT-LICENSE'));
await writeFile(
  resolve(resources, 'runtime.json'),
  JSON.stringify({ target, bun: bunVersion, executable: 'bun' }, null, 2),
);
console.log(`Bundled backend and Bun ${bunVersion} for ${target}`);
