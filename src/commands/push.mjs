import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { parseTarget } from '../targets.mjs';
import { run as captureRun, capturedPaths } from './capture.mjs';

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

// How many local commits sit ahead of the upstream branch, or null when no
// upstream is configured at all. A fresh branch that has never been pushed
// is a legitimate state -- the underlying `git rev-list @{u}..HEAD` throws
// "no upstream configured" in that case, and that failure must not surface
// as a crash; it just means "ahead" isn't a meaningful question yet.
function commitsAheadOfUpstream(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-list', '--count', '@{u}..HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number.parseInt(out.toString().trim(), 10);
  } catch {
    return null;
  }
}

// A thin wrapper: capture the machine's changes into the repo, then commit
// and push exactly what capture wrote. Never invents a commit message, and
// never stages anything beyond capture's own output -- the repo may hold
// unrelated work in progress that is none of this tool's business.
export async function run(allArgs = []) {
  const { target, rest: args, error } = parseTarget(allArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  const message = flag(args, '-m') ?? flag(args, '--message');
  if (!message) {
    console.error('nortuscc: push requires an explicit message: nortuscc push -m "rules: ..."');
    return 2;
  }

  // push hands capture only the flags capture understands, so the target has
  // to be put back explicitly — the filter below would otherwise drop it and
  // silently capture both agents on a `push --target codex`.
  const captured = await captureRun([
    '--target',
    target,
    ...args.filter((a) => a.startsWith('--take-')),
  ]);
  if (captured !== 0) return captured;

  const root = repoRoot();
  const paths = capturedPaths();
  const ahead = commitsAheadOfUpstream(root);

  // "Nothing to push" has to be decided from real git state, not only from
  // what capture wrote this run. A prior attempt may have already committed
  // locally and then failed to push (e.g. a non-fast-forward rejection) --
  // retrying that must attempt the push again, not silently report success
  // while the commit sits unpushed. Nothing captured AND nothing ahead of
  // upstream (or no upstream at all) is the only genuine no-op.
  if (paths.length === 0 && !(ahead > 0)) {
    console.log('\nnothing captured; nothing to push');
    return 0;
  }

  try {
    if (paths.length > 0) {
      // Stage only what capture wrote. Never `git add -A` -- the repo may
      // hold unrelated in-flight work that is not ours to commit.
      execFileSync('git', ['-C', root, 'add', '--', ...paths], { stdio: 'inherit' });

      console.log('\nstaged:');
      execFileSync('git', ['-C', root, 'diff', '--cached', '--stat'], { stdio: 'inherit' });

      execFileSync('git', ['-C', root, 'commit', '-m', message], { stdio: 'inherit' });
    }

    execFileSync('git', ['-C', root, 'push'], { stdio: 'inherit' });
  } catch {
    console.error('\nnortuscc: git add/commit/push failed.');
    console.error('Resolve the git error above, then try again.');
    return 1;
  }
  return 0;
}
