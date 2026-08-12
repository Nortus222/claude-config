import { execFileSync } from 'node:child_process';
import { repoRoot } from '../resolve.mjs';
import { parseTarget } from '../targets.mjs';
import { readIntegrations } from '../integrations/manifest.mjs';
import { integrationPlan } from '../integrations/runner.mjs';
import { defaultAdapters } from '../integrations/adapters.mjs';
import { formatRow, section } from '../report.mjs';
import { run as applyRun } from './apply.mjs';

// A thin wrapper: bring the repo up to date, then let apply reconcile the
// machine against it. --ff-only refuses to invent a merge -- a divergent
// remote is reported and left for the owner to resolve in the repo, exactly
// like every other place this CLI refuses rather than guesses.
export async function run(allArgs = []) {
  // Validated here rather than left to apply: an invalid target must exit 2
  // before the pull runs, not after the repo has already moved.
  const { target, rest, error } = parseTarget(allArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  // Rebuilt explicitly instead of forwarding allArgs, so the target survives
  // even when a later change starts filtering what pull passes on.
  const args = ['--target', target, ...rest];

  try {
    execFileSync('git', ['-C', repoRoot(), 'pull', '--ff-only'], { stdio: 'inherit' });
  } catch {
    console.error('\nnortuscc: git pull --ff-only failed.');
    console.error('The remote has diverged; resolve it in the repo before applying.');
    return 1;
  }
  const applied = await applyRun(args);
  if (applied !== 0) return applied;

  // A pull can bring down a newly declared integration. It is reported, not
  // installed: turning a routine `pull` into an unattended run of third-party
  // installers is not something a fast-forward should ever do. `--install`
  // already ran the workflow inside apply, so there is nothing left to say.
  if (!args.includes('--install')) {
    const { integrations, errors } = readIntegrations();
    if (errors.length) {
      process.stdout.write('\n' + section('integrations', errors.map((m) => formatRow('manifest', 'invalid', m))));
      return applied;
    }

    const pending = integrationPlan({ integrations, target, adapters: defaultAdapters() })
      .filter((item) => item.state !== 'installed');

    if (pending.length) {
      process.stdout.write(
        '\n' +
          section('integrations', [
            ...pending.map((item) => formatRow(item.label, item.state, item.note)),
            '',
            '  nortuscc apply --install',
          ]),
      );
    }
  }

  return applied;
}
