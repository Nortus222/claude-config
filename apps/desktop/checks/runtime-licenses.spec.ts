import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { bundleRuntimeLicenses } from '../scripts/bundle-runtime-licenses.mjs';

const require = createRequire(import.meta.url);
test('agent runtime resources carry the exact Effect and YAML license notices', async t => {
  const resources = await mkdtemp(join(tmpdir(), 'runtime-notices-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  await bundleRuntimeLicenses(resources);
  assert.deepEqual((await readdir(resources)).sort(), ['EFFECT-LICENSE', 'YAML-LICENSE']);
  assert.equal(await readFile(join(resources, 'EFFECT-LICENSE'), 'utf8'), await readFile(join(dirname(require.resolve('effect/package.json')), 'LICENSE'), 'utf8'));
  assert.equal(await readFile(join(resources, 'YAML-LICENSE'), 'utf8'), await readFile(join(dirname(require.resolve('yaml/package.json')), 'LICENSE'), 'utf8'));
  assert.match(await readFile(join(resources, 'YAML-LICENSE'), 'utf8'), /Copyright.*Eemeli Aro/);
});
