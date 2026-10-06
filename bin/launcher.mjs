import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

// Runtime dependencies only: an end-user checkout never needs the desktop app's toolchain.
export const RUNTIME_INSTALL = [
  'ci', '--omit=dev', '--include-workspace-root',
  '--workspace=packages/profile-engine', '--workspace=packages/machine',
  '--no-audit', '--no-fund',
];

// npm's stdout goes to stderr: a command's report on stdout stays clean.
export const INSTALL_STDIO = ['ignore', 2, 2];

// How to run npm with argv only: npm's JS entry point under this Node, else plain `npm` off Windows.
export function npmCommand({ args, node = process.execPath, npmExecPath = process.env.npm_execpath, platform = process.platform, exists = existsSync }) {
  const bundled = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli = npmExecPath || (exists(bundled) ? bundled : null);
  if (cli) return { cmd: node, args: [cli, ...args] };
  if (platform === 'win32') throw new Error('could not locate npm-cli.js');
  return { cmd: 'npm', args };
}

// Installs the runtime dependencies in `root`; returns why it failed, or null on success.
export function installRuntime(root) {
  try {
    const npm = npmCommand({ args: RUNTIME_INSTALL });
    const installed = spawnSync(npm.cmd, npm.args, { cwd: root, stdio: INSTALL_STDIO });
    if (installed.error) return installed.error.message;
    if (installed.status !== 0) return installed.signal ? `npm was killed by ${installed.signal}` : `npm exited with ${installed.status}`;
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
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

// Runs a command with this terminal's stdio; throws when it cannot start or exits non-zero.
function runInherited(cmd, args) {
  const ran = spawnSync(cmd, args, { stdio: 'inherit' });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) throw new Error(ran.signal ? `killed by ${ran.signal}` : `exited with ${ran.status}`);
}

// Links the `nortuscc` command to `root`. npm runs through its JS entry point under this Node, because
// PowerShell may block npm.ps1 and Windows cannot reliably execute npm.cmd without a shell.
export function installGlobalCommand(root, { run = runInherited, platform, node, npmExecPath } = {}) {
  const npm = npmCommand({ args: ['install', '--global', '--no-audit', '--no-fund', root], platform, node, npmExecPath });
  return run(npm.cmd, npm.args);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
}

// `setup` from an npx copy, which cannot run the TypeScript CLI from npm's cache: clone a durable
// checkout (--dir, else the recorded one, else ~/claude-config), install its runtime and the global
// command from it, then hand the run to that checkout's own setup. Returns the exit code.
export function setupFromCopy(args, { env = process.env, home = homedir(), platform = process.platform, isTTY = process.stdin.isTTY } = {}) {
  // Refused before cloning: the checkout's setup would refuse it anyway.
  if (!isTTY && !args.includes('--yes')) {
    console.error('nortuscc: no terminal to choose on. Re-run with --yes to accept the defaults.');
    return 2;
  }
  const requested = flagValue(args, '--dir');
  const url = flagValue(args, '--repo') ?? DEFAULT_REPO;
  const dir = requested ? resolve(requested) : recordedCheckout(env, home, platform) ?? join(home, 'claude-config');

  if (!existsSync(dir)) {
    console.log(`cloning ${url} -> ${dir}`);
    try {
      runInherited('git', ['clone', url, dir]);
    } catch (err) {
      console.error(`failed to clone ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
  // An interrupted clone leaves the directory behind; it must not be recorded as the repo.
  if (!existsSync(join(dir, '.git'))) {
    console.error(
      `nortuscc: ${dir} exists but is not a git checkout.\n` +
        'Remove it and re-run setup to clone into it, or pass a --dir that names a clone.',
    );
    return 2;
  }
  if (!isNortusccCheckout(dir)) {
    console.error(
      `nortuscc: ${dir} is a git checkout but not a nortuscc checkout.\n` +
        'Move it or pass --dir with a nortuscc checkout.',
    );
    return 2;
  }

  if (missingRuntime(dir)) {
    console.error(`nortuscc: installing runtime dependencies in ${dir}`);
    const failure = installRuntime(dir);
    if (failure) {
      console.error(`nortuscc: could not install dependencies (${failure}); run 'npm ${RUNTIME_INSTALL.join(' ')}' in ${dir}`);
      return 1;
    }
  }

  // Later `nortuscc` invocations run from the checkout, never from npm's disposable cache.
  console.log(`installing nortuscc command from ${dir}`);
  try {
    installGlobalCommand(dir, { platform });
  } catch (err) {
    console.error(`nortuscc: could not install the global command: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Run '${platform === 'win32' ? 'npm.cmd' : 'npm'} install --global "${dir}"', then re-run setup.`);
    return 1;
  }
  if (platform === 'win32') {
    console.log('PowerShell: use nortuscc.cmd (the nortuscc.ps1 shim may be blocked by execution policy).');
  }

  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dir' || args[i] === '--repo') i += 1;
    else rest.push(args[i]);
  }
  const handed = spawnSync(process.execPath, [join(dir, 'bin', 'nortuscc.mjs'), 'setup', '--dir', dir, ...rest], { stdio: 'inherit' });
  if (handed.error) {
    console.error(`nortuscc: could not run ${dir}: ${handed.error.message}`);
    return 1;
  }
  return handed.status ?? 128 + (constants.signals[handed.signal] ?? 0);
}
