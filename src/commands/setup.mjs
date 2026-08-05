import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readLock, writeLock } from '../lock.mjs';
import { repoRoot, isGitCheckout } from '../resolve.mjs';
import { run as applyRun } from './apply.mjs';
import { run as statusRun } from './status.mjs';

const DEFAULT_REPO = 'https://github.com/Nortus222/claude-config.git';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

export async function run(args = []) {
  const dir = flag(args, '--dir');
  const url = flag(args, '--repo') ?? DEFAULT_REPO;

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

  // setup always installs skills: a bare machine is exactly when they are wanted.
  const applied = await applyRun(['--skills', ...args.filter((a) => a.startsWith('--take-'))]);
  if (applied !== 0) return applied;

  console.log('\n--- status ---');
  return await statusRun();
}
