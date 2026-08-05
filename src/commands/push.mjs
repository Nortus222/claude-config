import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { run as captureRun, capturedPaths } from './capture.mjs';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// A thin wrapper: capture the machine's changes into the repo, then commit
// and push exactly what capture wrote. Never invents a commit message, and
// never stages anything beyond capture's own output -- the repo may hold
// unrelated work in progress that is none of this tool's business.
export async function run(args = []) {
  const message = flag(args, '-m') ?? flag(args, '--message');
  if (!message) {
    console.error('nortuscc: push requires an explicit message: nortuscc push -m "rules: ..."');
    return 2;
  }

  const captured = await captureRun(args.filter((a) => a.startsWith('--take-')));
  if (captured !== 0) return captured;

  const paths = capturedPaths();
  if (paths.length === 0) {
    console.log('\nnothing captured; nothing to push');
    return 0;
  }

  const root = repoRoot();
  try {
    // Stage only what capture wrote. Never `git add -A` -- the repo may hold
    // unrelated in-flight work that is not ours to commit.
    execFileSync('git', ['-C', root, 'add', '--', ...paths], { stdio: 'inherit' });

    console.log('\nstaged:');
    execFileSync('git', ['-C', root, 'diff', '--cached', '--stat'], { stdio: 'inherit' });

    execFileSync('git', ['-C', root, 'commit', '-m', message], { stdio: 'inherit' });
    execFileSync('git', ['-C', root, 'push'], { stdio: 'inherit' });
  } catch {
    console.error('\nnortuscc: git add/commit/push failed.');
    console.error('Resolve the git error above, then try again.');
    return 1;
  }
  return 0;
}
