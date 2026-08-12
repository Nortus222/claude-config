import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readLock, writeLock, migrateLegacyState } from '../lock.mjs';
import { repoRoot, isGitCheckout, statePath } from '../resolve.mjs';
import { parseTarget } from '../targets.mjs';
import { run as applyRun, installFor } from './apply.mjs';
import { run as statusRun } from './status.mjs';

const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// `deps` is forwarded to the closing status run, so a test can answer "what
// can each agent see?" without spawning the real installer.
export async function run(allArgs = [], deps = {}) {
  const { target, rest: args, error } = parseTarget(allArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  const dir = flag(args, '--dir');
  const url = flag(args, '--repo') ?? DEFAULT_REPO;

  // Import the pre-Codex lock before anything reads or writes state, so a
  // machine that has been managed before keeps its recorded baselines instead
  // of reporting every managed file as never synced. The old lock is left
  // exactly where it is.
  const migration = migrateLegacyState();
  if (migration.migrated) {
    console.log(`migrated existing nortuscc state -> ${statePath()}`);
  }

  // When --dir is given and empty, clone into it. Otherwise this CLI is already
  // running from a clone, which is the npx-from-GitHub case.
  if (dir && !existsSync(dir)) {
    console.log(`cloning ${url} -> ${dir}`);
    try {
      execFileSync('git', ['clone', url, dir], { stdio: 'inherit' });
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

  const root = dir ?? repoRoot();
  console.log(`repo: ${root}`);

  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    console.log(`commit: ${commit}`);
  } catch {
    console.log('commit: unknown (not a git checkout)');
  }

  // Record where the repo lives so later runs work from any directory.
  const lock = readLock();
  lock.repo = root;
  writeLock(lock);

  // Configuration first, so a conflict is decided before any installer runs.
  // The target is put back explicitly — the filter keeps setup's own flags out
  // of apply, and would otherwise drop it and reconcile both agents on a
  // `setup --target codex`.
  const forwarded = ['--target', target, ...args.filter((a) => a.startsWith('--take-'))];
  const applied = await applyRun(forwarded);
  if (applied !== 0) return applied;

  // setup always offers the full workflow: a bare machine is exactly when
  // integrations and skills are wanted. Re-running it is idempotent, because
  // everything already in place is offered as satisfied and never reinstalled.
  const installed = await installFor(target, args, {
    takeRepo: args.includes('--take-repo'),
    deps,
  });
  if (installed !== 0) return installed;

  console.log('\n--- status ---');
  return await statusRun(['--target', target], deps);
}
