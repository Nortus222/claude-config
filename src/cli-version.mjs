import { execFileSync } from 'node:child_process';
import { repoRoot, isGitCheckout } from './resolve.mjs';

// Whether the checkout this CLI runs from is missing commits the remote has.
//
// Asked with `ls-remote` rather than `fetch`: a fetch writes refs into .git,
// and status must not change the repo it is reporting on. One network round
// trip, nothing written.
//
// The test is "do we already have the remote's tip?" rather than a commit
// count, because counting commits requires having the objects being counted —
// which is exactly what a behind checkout lacks. A tip we already have means
// this checkout is current or ahead of the remote, and neither needs a pull.
// That asymmetry matters here: the integration checkout is routinely ahead by
// commits that have not been pushed, and reporting those as "behind" would send
// the owner to pull away their own work.

function git(args, { cwd } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Returns one of:
//   { state: 'current' }      the remote tip is already here
//   { state: 'behind', sha }  the remote has something this checkout does not
//   { state: 'unmanaged' }    no checkout, no remote, or a detached HEAD
//   { state: 'unknown', note} the remote could not be reached
//
// 'unmanaged' is the npx-from-GitHub case and is deliberately silent: there is
// no checkout to update, because each invocation resolves the repo itself.
export function cliVersion({ root = repoRoot(), run = git } = {}) {
  if (!isGitCheckout(root)) return { state: 'unmanaged' };

  let branch;
  let remote;
  try {
    branch = run(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
    // A detached HEAD has no branch to compare, and no upstream to compare it
    // against. Nothing to say rather than something invented.
    if (!branch || branch === 'HEAD') return { state: 'unmanaged' };
    remote = run(['-C', root, 'remote']).split('\n')[0];
    if (!remote) return { state: 'unmanaged' };
  } catch {
    return { state: 'unmanaged' };
  }

  let tip;
  try {
    // ls-remote prints "<sha>\t<ref>"; the SHA is all this needs.
    const line = run(['-C', root, 'ls-remote', remote, branch]).split('\n')[0];
    tip = line ? line.split(/\s/)[0] : '';
    // A branch the remote does not publish is not a branch this can judge.
    if (!tip) return { state: 'unmanaged' };
  } catch (err) {
    // Offline, or no credentials. Saying "current" here would be a claim we did
    // not verify, so it gets its own state — the same treatment planUpdates
    // gives a source it could not reach.
    return { state: 'unknown', note: firstLine(err) };
  }

  try {
    run(['-C', root, 'cat-file', '-e', `${tip}^{commit}`]);
    return { state: 'current' };
  } catch {
    return { state: 'behind', sha: tip.slice(0, 7), branch, remote };
  }
}

function firstLine(err) {
  const text = (err?.stderr || err?.message || '').toString().trim();
  return text.split('\n')[0] || 'could not reach the remote';
}
