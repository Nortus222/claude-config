import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Inner signing changes Bun's bytes after resource generation; other runtime identities stay fixed.
export async function refreshBunHash(resources) {
  const path = join(resources, 'runtime.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  if (metadata?.executable !== 'bun' || typeof metadata.bunSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.bunSha256))
    throw new Error('Cannot refresh an invalid bundled Bun identity.');
  metadata.bunSha256 = createHash('sha256').update(await readFile(join(resources, 'bun'))).digest('hex');
  await writeFile(path, JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: refresh-bun-hash.mjs <agent-runtime directory>');
  await refreshBunHash(resolve(process.argv[2]));
}
