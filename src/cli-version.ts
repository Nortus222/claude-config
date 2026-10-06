import { execFileSync } from 'node:child_process';
import { isGitCheckout } from '@nortuscc/machine';

// Whether the checkout this CLI runs from is missing commits the remote has.
//
// Asked with `ls-remote` rather than `fetch`: a fetch writes refs into .git, and status must not
// change the repo it is reporting on. One network round trip, nothing written.
//
// The test is "do we already have the remote's tip?" rather than a commit count, because counting
// commits requires the objects being counted, which a behind checkout lacks. A tip we already have
// means current or ahead, and neither needs a pull: the integration checkout is routinely ahead by
// unpushed commits, and calling that "behind" would send the owner to pull away their own work.

export type CliVersion =
  | { state: 'current' }
  | { state: 'behind'; sha: string; branch: string; remote: string }
  // No checkout, no remote, a detached HEAD or an unpublished branch: nothing to update, and silent.
  | { state: 'unmanaged' }
  // The remote could not be reached; never claimed as current.
  | { state: 'unknown'; note: string };

// Runs git with the given args and returns trimmed stdout; throws on a non-zero exit.
export type GitRun = (args: string[]) => string;

const git: GitRun = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function firstLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | undefined;
  const text = String(e?.stderr || e?.message || '').trim();
  return text.split('\n')[0] || 'could not reach the remote';
}

export function cliVersion({ root, run = git }: { root: string; run?: GitRun }): CliVersion {
  if (!isGitCheckout(root)) return { state: 'unmanaged' };

  let branch: string;
  let remote: string;
  try {
    branch = run(['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') return { state: 'unmanaged' };
    remote = run(['-C', root, 'remote']).split('\n')[0] ?? '';
    if (!remote) return { state: 'unmanaged' };
  } catch {
    return { state: 'unmanaged' };
  }

  let tip: string;
  try {
    // ls-remote prints "<sha>\t<ref>"; the SHA is all this needs.
    const line = run(['-C', root, 'ls-remote', remote, branch]).split('\n')[0];
    tip = line ? line.split(/\s/)[0] ?? '' : '';
    if (!tip) return { state: 'unmanaged' };
  } catch (err) {
    return { state: 'unknown', note: firstLine(err) };
  }

  try {
    run(['-C', root, 'cat-file', '-e', `${tip}^{commit}`]);
    return { state: 'current' };
  } catch {
    return { state: 'behind', sha: tip.slice(0, 7), branch, remote };
  }
}
