import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

// Runtime dependencies only: an end-user checkout never needs the desktop app's toolchain.
export const RUNTIME_INSTALL = [
  'ci', '--omit=dev', '--include-workspace-root',
  '--workspace=packages/profile-engine', '--workspace=packages/machine',
  '--no-audit', '--no-fund',
];

// How to run npm with argv only: npm's JS entry point under this Node, else plain `npm` off Windows.
export function npmCommand({ args, node = process.execPath, npmExecPath = process.env.npm_execpath, platform = process.platform, exists = existsSync }) {
  const bundled = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli = npmExecPath || (exists(bundled) ? bundled : null);
  if (cli) return { cmd: node, args: [cli, ...args] };
  if (platform === 'win32') throw new Error('could not locate npm-cli.js');
  return { cmd: 'npm', args };
}

// Node will not strip TypeScript under node_modules, so only a real checkout may load src/main.ts.
export function isCheckout(root) {
  return !root.split(sep).includes('node_modules') && existsSync(join(root, '.git'));
}

export function missingRuntime(root) {
  return !existsSync(join(root, 'node_modules', 'effect', 'package.json'));
}

function isNortusccCheckout(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.name === 'nortuscc' && isCheckout(dir) && existsSync(join(dir, 'bin', 'nortuscc.mjs'));
  } catch {
    return false;
  }
}

// The checkout setup recorded in state.json, when it still is one; the same stateRoot rule as the CLI.
export function recordedCheckout(env, home, platform) {
  const stateRoot = env.NORTUSCC_STATE_DIR
    || (platform === 'win32' ? join(env.APPDATA ?? '', 'nortuscc') : join(home, '.config', 'nortuscc'));
  try {
    const { repo } = JSON.parse(readFileSync(join(stateRoot, 'state.json'), 'utf8'));
    return typeof repo === 'string' && isNortusccCheckout(repo) ? repo : null;
  } catch {
    return null;
  }
}
