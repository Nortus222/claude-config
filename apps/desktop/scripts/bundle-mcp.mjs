import { build } from 'esbuild';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

// MCP has a separate hash; the installed agent's runtime identity continues to hash only agent.mjs.
export async function bundleMcp({ root, resources }) {
  await build({ entryPoints: [join(root, 'mcp/main.ts')], bundle: true, platform: 'node', format: 'esm', target: 'esnext', outfile: join(resources, 'mcp.mjs') });
  const require = createRequire(import.meta.url);
  const moduleRoot = name => dirname(require.resolve(`${name}/package.json`));
  // Split SDK export maps omit package.json, so resolve its public entry instead.
  const sdkRoot = name => dirname(dirname(require.resolve(name)));
  for (const [name, file] of [['server', 'MCP-SERVER-LICENSE'], ['core', 'MCP-CORE-LICENSE']])
    await copyFile(join(sdkRoot(`@modelcontextprotocol/${name}`), 'LICENSE'), join(resources, file));
  const zodLicense = await readFile(join(moduleRoot('zod'), 'LICENSE'), 'utf8');
  await writeFile(join(resources, 'ZOD-LICENSE'), zodLicense);
  // The SDK embeds content-type 1.0.5. Its MIT terms match Zod's; retain its own copyright notice.
  if (!zodLicense.includes('Copyright (c) 2025 Colin McDonnell')) throw new Error('Review Zod and embedded content-type license notices before bundling.');
  await writeFile(join(resources, 'CONTENT-TYPE-LICENSE'), zodLicense.replace('Copyright (c) 2025 Colin McDonnell', 'Copyright (c) 2015 Douglas Christopher Wilson'));
  const sdk = JSON.parse(await readFile(join(sdkRoot('@modelcontextprotocol/server'), 'package.json'), 'utf8')).version;
  return { protocol: 1, executable: 'mcp.mjs', sdk, sha256: createHash('sha256').update(await readFile(join(resources, 'mcp.mjs'))).digest('hex') };
}
