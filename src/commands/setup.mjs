import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readLock, writeLock, migrateLegacyState } from '../lock.mjs';
import { repoRoot, moduleRoot, isGitCheckout, statePath } from '../resolve.mjs';
import { parseTarget } from '../targets.mjs';
import { run as applyRun, installFor } from './apply.mjs';
import { run as statusRun } from './status.mjs';
import { parseConfigMode } from '../config-mode.mjs';

const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

export function defaultSetupDir(home = homedir()) {
  return join(home, 'claude-config');
}

export function isNortusccCheckout(root) {
  if (!isGitCheckout(root)) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg.name === 'nortuscc'
      && pkg.bin?.nortuscc === './bin/nortuscc.mjs'
      && existsSync(join(root, 'bin', 'nortuscc.mjs'));
  } catch {
    return false;
  }
}

function cloneRepo(url, dir) {
  execFileSync('git', ['clone', url, dir], { stdio: 'inherit' });
}

export function installGlobalCommand(
  root,
  {
    run = execFileSync,
    platform = process.platform,
    node = process.execPath,
    npmExecPath = process.env.npm_execpath,
  } = {},
) {
  const bundledNpm = join(dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCli = npmExecPath || (existsSync(bundledNpm) ? bundledNpm : null);
  const args = ['install', '--global', '--no-audit', '--no-fund', root];

  // PowerShell may block npm.ps1, and Windows cannot reliably execute npm.cmd
  // through execFile. npx provides npm_execpath, so run npm's JS entry point
  // with the current Node executable and keep paths with spaces as argv.
  if (npmCli) return run(node, [npmCli, ...args], { stdio: 'inherit' });
  if (platform === 'win32') throw new Error('could not locate npm-cli.js');
  return run('npm', args, { stdio: 'inherit' });
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// `deps` is forwarded to the closing status run, so a test can answer "what
// can each agent see?" without spawning the real installer.
export async function run(allArgs = [], deps = {}) {
  // setup is where a machine says what it wants managed, so it is the one
  // command that records the choice rather than merely honouring it.
  const { rest: modeArgs, persist, manageConfig } = parseConfigMode(allArgs);

  const { target, rest: args, error } = parseTarget(modeArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  // setup repairs stale state itself by choosing a durable checkout below, so
  // repoRoot's generic "re-run setup" warning would prescribe work this same
  // invocation is already doing.
  const runtimeRoot = deps.currentRoot ?? moduleRoot();
  const resolvedRoot = deps.resolvedRoot ?? repoRoot({ warnStale: false });
  const packageLaunch = !isGitCheckout(runtimeRoot);
  const requestedDir = flag(args, '--dir');
  // GitHub-backed npx runs from npm's disposable package cache. Put the
  // managed files in a real checkout by default, then link the command to that
  // checkout so later `nortuscc` invocations do not depend on the cache.
  const dir = requestedDir ?? (
    packageLaunch
      ? (isGitCheckout(resolvedRoot) ? resolvedRoot : (deps.defaultDir ?? defaultSetupDir()))
      : null
  );
  const url = flag(args, '--repo') ?? DEFAULT_REPO;

  // Import the pre-Codex lock before anything reads or writes state, so a
  // machine that has been managed before keeps its recorded baselines instead
  // of reporting every managed file as never synced. The old lock is left
  // exactly where it is.
  const migration = migrateLegacyState();
  if (migration.migrated) {
    console.log(`migrated existing nortuscc state -> ${statePath()}`);
  }

  // A package launch always chooses a durable directory above. A checkout
  // launch uses --dir only when the caller explicitly supplied one.
  if (dir && !existsSync(dir)) {
    console.log(`cloning ${url} -> ${dir}`);
    try {
      (deps.cloneRepo ?? cloneRepo)(url, dir);
    } catch (e) {
      console.error(`failed to clone ${url}: ${e.message}`);
      return 1;
    }
  }

  // An interrupted `git clone` leaves the directory behind, so re-running the
  // documented onboarding command lands here with --dir naming something that
  // exists but is not a checkout. repoRoot() would then reject that path for
  // having no .git and silently resolve elsewhere — while setup announced the
  // path and wrote it into lock.repo, poisoning every later apply, capture and
  // push. Refuse instead: the same isGitCheckout() test repoRoot() applies.
  if (dir && !isGitCheckout(dir)) {
    console.error(
      `nortuscc: ${dir} exists but is not a git checkout.\n` +
        'Remove it and re-run setup to clone into it, or pass a --dir that names a clone.',
    );
    return 2;
  }

  const root = dir ?? resolvedRoot;
  if (packageLaunch && !isNortusccCheckout(root)) {
    console.error(
      `nortuscc: ${root} is a git checkout but not a nortuscc checkout.\n` +
        'Move it or pass --dir with a nortuscc checkout.',
    );
    return 2;
  }
  console.log(`repo: ${root}`);

  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    console.log(`commit: ${commit}`);
  } catch {
    console.log('commit: unknown (not a git checkout)');
  }

  if (packageLaunch) {
    console.log(`installing nortuscc command from ${root}`);
    try {
      (deps.installCli ?? installGlobalCommand)(root);
    } catch (e) {
      console.error(`nortuscc: could not install the global command: ${e.message}`);
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      console.error(`Run '${npm} install --global "${root}"', then re-run setup.`);
      return 1;
    }
    if (process.platform === 'win32') {
      console.log('PowerShell: use nortuscc.cmd (the nortuscc.ps1 shim may be blocked by execution policy).');
    }
  }

  // Record where the repo lives so later runs work from any directory, and
  // what this machine wants managed. Written before apply runs, so the very
  // first apply already honours a `setup --skills-only` rather than syncing
  // the configuration files once and respecting the choice only from the next
  // command onward.
  const lock = readLock();
  lock.repo = root;
  if (persist !== null) lock.skillsOnly = persist;
  writeLock(lock);

  if (!manageConfig) {
    console.log('skills-only: this machine keeps its own agent configuration');
  }

  // Configuration first, so a conflict is decided before any installer runs.
  // The target is put back explicitly — the filter keeps setup's own flags out
  // of apply, and would otherwise drop it and reconcile both agents on a
  // `setup --target codex`.
  const forwarded = ['--target', target, ...args.filter((a) => a.startsWith('--take-'))];
  const applied = await applyRun(forwarded);
  if (applied !== 0) return applied;

  if (manageConfig && target !== 'claude') {
    process.stdout.write(
      '\nT3 Code provider handoff:\n' +
        '  Display name: Codex · GLM Flash\n' +
        '  CODEX_HOME path: ~/.codex-openrouter\n' +
        '  Environment: OPENROUTER_API_KEY (enter it as a sensitive value)\n' +
        '  Restart T3 Code, refresh providers, then select z-ai/glm-5.3-flash.\n',
    );
  }

  // setup always offers the full workflow: a bare machine is exactly when
  // integrations and skills are wanted. Re-running it is idempotent, because
  // everything already in place is offered as satisfied and never reinstalled.
  const installed = await installFor(target, args, {
    takeRepo: args.includes('--take-repo'),
    deps,
    manageConfig,
  });
  if (installed !== 0) return installed;

  console.log('\n--- status ---');
  return await statusRun(['--target', target], deps);
}
