import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { run as applyRun } from './apply.mjs';

// A thin wrapper: bring the repo up to date, then let apply reconcile the
// machine against it. --ff-only refuses to invent a merge -- a divergent
// remote is reported and left for the owner to resolve in the repo, exactly
// like every other place this CLI refuses rather than guesses.
export async function run(args = []) {
  try {
    execFileSync('git', ['-C', repoRoot(), 'pull', '--ff-only'], { stdio: 'inherit' });
  } catch {
    console.error('\nnortuscc: git pull --ff-only failed.');
    console.error('The remote has diverged; resolve it in the repo before applying.');
    return 1;
  }
  return await applyRun(args);
}
