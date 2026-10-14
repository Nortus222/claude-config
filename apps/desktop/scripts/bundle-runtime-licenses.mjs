import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Find hoisted runtime packages the same way Node resolves the agent's dependencies.
export const bundleRuntimeLicenses = async resources => {
  for (const [pkg, notice] of [['effect', 'EFFECT-LICENSE'], ['yaml', 'YAML-LICENSE']])
    await copyFile(join(dirname(require.resolve(`${pkg}/package.json`)), 'LICENSE'), join(resources, notice));
};
