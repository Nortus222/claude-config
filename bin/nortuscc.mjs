#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTED, USAGE, VERBS } from './commands.mjs';
import { isCheckout, missingRuntime, npmCommand, recordedCheckout, RUNTIME_INSTALL } from './launcher.mjs';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`nortuscc needs Node.js 24 or later (found ${process.versions.node})`);
  process.exit(2);
}

const [verb, ...rest] = process.argv.slice(2);
if (!verb || verb === '--help' || verb === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (!VERBS.includes(verb)) {
  console.error(`nortuscc: unknown command '${verb}'\n`);
  console.error(USAGE);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (isCheckout(root)) {
  if (missingRuntime(root)) {
    console.error(`nortuscc: installing runtime dependencies in ${root}`);
    const npm = npmCommand({ args: RUNTIME_INSTALL });
    const installed = spawnSync(npm.cmd, npm.args, { cwd: root, stdio: 'inherit' });
    if (installed.status !== 0) {
      console.error(`nortuscc: could not install dependencies; run 'npm ${RUNTIME_INSTALL.join(' ')}' in ${root}`);
      process.exit(1);
    }
  }
  const { main } = await import('../src/main.ts');
  process.exit(await main([verb, ...rest]));
}

// An npx copy: legacy JavaScript still runs here; TypeScript commands run from the checkout.
if (!PORTED.includes(verb)) {
  const { run } = await import(`../src/commands/${verb}.mjs`);
  process.exit(await run(rest));
}
const checkout = recordedCheckout(process.env, homedir(), process.platform);
if (!checkout) {
  console.error(`nortuscc: '${verb}' needs a nortuscc checkout. Run 'npx github:Nortus222/claude-config setup' first.`);
  process.exit(2);
}
const handed = spawnSync(process.execPath, [join(checkout, 'bin', 'nortuscc.mjs'), verb, ...rest], { stdio: 'inherit' });
if (handed.error) {
  console.error(`nortuscc: could not run ${checkout}: ${handed.error.message}`);
  process.exit(1);
}
process.exit(handed.status ?? 128 + (constants.signals[handed.signal] ?? 0));
