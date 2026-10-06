import { spawnSync } from 'node:child_process';

// Runs `git -C <repo> ...args` (argv only) in this terminal's foreground process group, so git
// can still prompt for credentials or a passphrase. 'capture' collects stdout; stderr is inherited.
// A launch failure reads as exit code 1.
export function runGit(repo: string, args: ReadonlyArray<string>, output: 'inherit' | 'capture' = 'inherit'): { code: number; stdout: string } {
  const result = spawnSync('git', ['-C', repo, ...args], {
    stdio: output === 'capture' ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  return { code: result.error ? 1 : (result.status ?? 1), stdout: result.stdout ?? '' };
}
