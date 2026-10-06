import { Effect } from 'effect';
import { parseConfigMode, resolveConfigMode } from '../config-mode.ts';
import { runGit } from '../git.ts';
import { openMachine, refuseInvalidOverrides, runCommand } from '../machine.ts';
import { parseTarget, selectedTargets } from '../targets.ts';
import { capture } from './capture.ts';

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

// `nortuscc push -m MSG`: capture the machine's changes into the repo, then commit and push exactly
// what capture wrote and changed. Never invents a message and never stages anything capture did not write.
export async function run(args: string[] = []): Promise<number> {
  const mode = parseConfigMode(args);
  const { target, rest, error } = parseTarget(mode.rest);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const message = flag(rest, '-m') ?? flag(rest, '--message');
  if (!message) {
    console.error('nortuscc: push requires an explicit message: nortuscc push -m "rules: ..."');
    return 2;
  }
  const takeLocal = rest.includes('--take-local');
  if (rest.includes('--take-repo')) {
    console.error(
      "nortuscc: --take-repo has no effect on capture (capture is machine -> repo).\n" +
        "Use 'nortuscc apply --take-repo' to discard the local version instead.",
    );
    return 2;
  }

  return runCommand((signal) => Effect.gen(function* () {
    const opened = yield* openMachine({ mode });
    if (refuseInvalidOverrides(opened.overrides)) return 1;
    const { manageConfig } = resolveConfigMode(mode, opened.overrides.value);
    const repo = opened.paths.repo;

    const result = yield* capture(opened, { targets: selectedTargets(target), takeLocal, allowShrink: false, manageConfig, signal })
      .pipe(Effect.provide(opened.layer));
    if (result.code !== 0) return result.code;

    // In the terminal's foreground, so `git push` can prompt for credentials.
    const git = (output: 'inherit' | 'capture', ...gitArgs: string[]) => runGit(repo, gitArgs, output);
    const failed = () => {
      console.error('\nnortuscc: git add/commit/push failed.');
      console.error('Resolve the git error above, then try again.');
      return 1;
    };
    const paths = result.captured;
    if (paths.length > 0 && git('inherit', 'add', '--', ...paths).code !== 0) return failed();
    // capture can rewrite a file without changing it (the manifest is regenerated every run), and
    // such a file stages nothing to commit. `diff --quiet` exits 0 only when nothing differs.
    const staged = paths.length > 0 && git('capture', 'diff', '--cached', '--quiet', '--', ...paths).code !== 0;

    // No upstream (rev-list fails) means "ahead" is not a meaningful question. Real git state decides
    // the no-op: a commit left unpushed by an earlier rejected push must be retried, not forgotten.
    const counted = git('capture', 'rev-list', '--count', '@{u}..HEAD');
    const ahead = counted.code === 0 ? Number.parseInt(counted.stdout.trim(), 10) : 0;
    if (!staged && !(ahead > 0)) {
      console.log('\nnothing captured; nothing to push');
      return 0;
    }

    const steps: Array<[string, ...string[]]> = [];
    if (staged) steps.push(['diff', '--cached', '--stat'], ['commit', '-m', message]);
    steps.push(['push']);
    for (const step of steps) {
      if (step[0] === 'diff') console.log('\nstaged:');
      if (git('inherit', ...step).code !== 0) return failed();
    }
    return 0;
  }));
}
