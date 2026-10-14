import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

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
