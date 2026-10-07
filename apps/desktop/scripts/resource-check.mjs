import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Portable test resources are independent of the macOS release bundler.
const root = fileURLToPath(new URL('..', import.meta.url));
const resources = await mkdtemp(join(tmpdir(), 'nar-fixture-'));
const require = createRequire(import.meta.url);
try {
  await build({
    entryPoints: [join(root, 'agent/main.ts')], bundle: true, platform: 'node',
    format: 'esm', target: 'esnext', outfile: join(resources, 'agent.mjs'),
  });
  const sourceRuntime = process.env.DESKTOP_BUN_RUNTIME || execFileSync('bun', ['-e', 'console.log(process.execPath)'], {
    cwd: resources, encoding: 'utf8', timeout: 5000, windowsHide: true,
  }).trim();
  const bunVersion = execFileSync(sourceRuntime, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  const executable = process.platform === 'win32' ? 'bun.exe' : 'bun';
  await copyFile(sourceRuntime, join(resources, executable));
  await chmod(join(resources, executable), 0o755);
  if (process.env.DESKTOP_BUN_LICENSE) {
    await copyFile(process.env.DESKTOP_BUN_LICENSE, join(resources, 'BUN-LICENSE.md'));
  } else {
    const license = await fetch(`https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!license.ok) throw new Error(`Bun ${bunVersion} license download failed: ${license.status}`);
    await writeFile(join(resources, 'BUN-LICENSE.md'), await license.text());
  }
  await copyFile(join(dirname(require.resolve('effect/package.json')), 'LICENSE'), join(resources, 'EFFECT-LICENSE'));
  const agentVersion = createHash('sha256').update(await readFile(join(resources, 'agent.mjs'))).digest('hex');
  await writeFile(join(resources, 'runtime.json'), JSON.stringify({
    target: `${process.platform}-${process.arch}`, bun: bunVersion, executable, agentVersion,
  }, null, 2));
  execFileSync(process.execPath, [require.resolve('tsx/cli'), '--test', 'checks/agent-resources.spec.ts', 'checks/smoke.spec.ts'], {
    cwd: root, env: { ...process.env, DESKTOP_AGENT_RESOURCES: resources },
    stdio: 'inherit', windowsHide: true,
  });
} finally {
  await rm(resources, { recursive: true, force: true });
}
