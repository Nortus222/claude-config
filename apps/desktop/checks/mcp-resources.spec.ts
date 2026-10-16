import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { build } from 'esbuild';

test('MCP resource bundling records its own hash and every new bundled dependency notice', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'mcp-resource-'));
  try {
    const { bundleMcp } = await import('../scripts/bundle-mcp.mjs');
    const metadata = await bundleMcp({ root: fileURLToPath(new URL('..', import.meta.url)), resources });
    assert.deepEqual((await readdir(resources)).sort(), ['CONTENT-TYPE-LICENSE', 'MCP-CORE-LICENSE', 'MCP-SERVER-LICENSE', 'ZOD-LICENSE', 'mcp.mjs']);
    const bundle = await readFile(join(resources, 'mcp.mjs'), 'utf8');
    assert.doesNotMatch(bundle, /packages\/machine\/src\/(?:domains\/|run\.ts|processes\.ts|history\.ts)/);
    assert.deepEqual(metadata, { protocol: 1, executable: 'mcp.mjs', sdk: '2.3.1', sha256: createHash('sha256').update(await readFile(join(resources, 'mcp.mjs'))).digest('hex') });
    for (const file of ['MCP-CORE-LICENSE', 'MCP-SERVER-LICENSE']) assert.match(await readFile(join(resources, file), 'utf8'), /Apache License/);
    assert.match(await readFile(join(resources, 'ZOD-LICENSE'), 'utf8'), /Colin McDonnell/);
    assert.match(await readFile(join(resources, 'CONTENT-TYPE-LICENSE'), 'utf8'), /2015 Douglas Christopher Wilson/);
    assert.match(await readFile(join(resources, 'CONTENT-TYPE-LICENSE'), 'utf8'), /Permission is hereby granted/);
  } finally { await rm(resources, { recursive: true, force: true }); }
});


test('post-signing Bun hash refresh updates only the Bun fingerprint after bytes change', async () => {
  const resources = await mkdtemp(join(tmpdir(), 'mcp-signing-'));
  try {
    const { refreshBunHash } = await import('../scripts/refresh-bun-hash.mjs');
    const metadata = { target: 'darwin-arm64', appVersion: '0.1.6', bun: '1.3.14', executable: 'bun', bunSha256: createHash('sha256').update('runtime with its original signature').digest('hex'), agentVersion: 'agent-identity', mcp: { protocol: 1, executable: 'mcp.mjs', sdk: '2.3.1', sha256: 'mcp-identity' }, privateFutureField: { keep: true } };
    await writeFile(join(resources, 'runtime.json'), JSON.stringify(metadata));
    await writeFile(join(resources, 'bun'), 'runtime with its original signature');
    await writeFile(join(resources, 'bun'), 'runtime with a changed signature');
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/refresh-bun-hash.mjs', import.meta.url)), resources], { env: { HOME: resources, PATH: '' }, timeout: 5000 });
    const changed = JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8'));
    assert.equal(changed.bunSha256, createHash('sha256').update('runtime with a changed signature').digest('hex'));
    const { bunSha256: _before, ...before } = metadata, { bunSha256: _after, ...after } = changed;
    assert.deepEqual(after, before);
    await writeFile(join(resources, 'agent.mjs'), 'tampered agent');
    await writeFile(join(resources, 'mcp.mjs'), 'tampered MCP');
    await refreshBunHash(resources);
    assert.deepEqual(JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')), changed, 'the signing step must never replace agent or MCP identities');
    await writeFile(join(resources, 'runtime.json'), JSON.stringify({ ...metadata, executable: '../external-bun' }));
    await assert.rejects(() => refreshBunHash(resources));
    assert.equal(JSON.parse(await readFile(join(resources, 'runtime.json'), 'utf8')).bunSha256, metadata.bunSha256);
  } finally { await rm(resources, { recursive: true, force: true }); }
});


const runtimeImport = /(?:packages\/machine\/src\/(?!(?:paths|errors)\.ts$)|packages\/profile-engine\/src\/(?!(?:intent-value|author-values|files)\.ts$|files\.json$)|packages\/agent\/src\/skill-operations|node_modules\/yaml\/)/;

test('metadata exceptions allow only exact pure leaves', () => {
  for (const leaf of ['intent-value.ts', 'author-values.ts', 'files.ts', 'files.json']) assert.doesNotMatch(`packages/profile-engine/src/${leaf}`, runtimeImport);
  for (const path of ['intent-value.ts-runtime.ts', 'intent-value.ts/runtime.ts', 'intent-value.tsx']) assert.match(`packages/profile-engine/src/${path}`, runtimeImport);
});

test('MCP metadata import graph excludes machine readers, YAML and profile execution', async () => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../mcp/main.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', target: 'esnext', write: false, metafile: true });
  for (const output of Object.values(bundled.metafile!.outputs)) for (const [path, item] of Object.entries(output.inputs)) if (item.bytesInOutput > 0) assert.doesNotMatch(path, runtimeImport);
});
