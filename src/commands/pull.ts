import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { pathsFromEnvironment } from '@nortuscc/machine';
import { installRuntime, RUNTIME_INSTALL } from '../../bin/launcher.mjs';
import { runGit } from '../git.ts';
import { CHECKOUT, openMachine, runCommand } from '../machine.ts';
import { formatRow, section } from '../report.ts';
import { parseTarget, selectedTargets } from '../targets.ts';
import { inspectIntegrations } from './status.ts';

// The lockfile's content hash, or null when there is none.
function lockfileHash(repo: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(join(repo, 'package-lock.json'))).digest('hex');
  } catch {
    return null;
  }
}

// `nortuscc pull`: fast-forward the repo, reinstall the runtime when the lockfile moved, then apply.
// --ff-only refuses to invent a merge: a diverged remote is reported and left to the owner.
export async function run(args: string[] = []): Promise<number> {
  // Validated before the pull: an invalid target must exit 2 before the repo has moved.
  const { target, rest, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  return runCommand(() => Effect.gen(function* () {
    const paths = yield* pathsFromEnvironment({
      env: process.env, home: homedir(), platform: process.platform, fallbackRepo: CHECKOUT, warn: (m) => console.error(m),
    });
    const repo = paths.repo;

    const before = lockfileHash(repo);
    if (runGit(repo, ['pull', '--ff-only']).code !== 0) {
      console.error('\nnortuscc: git pull --ff-only failed.');
      console.error('The remote has diverged; resolve it in the repo before applying.');
      return 1;
    }

    if (lockfileHash(repo) !== before) {
      // In the tree whose lockfile changed; in normal use the recorded repo is this checkout.
      console.error('nortuscc: package-lock.json changed; reinstalling runtime dependencies');
      const failure = installRuntime(repo);
      if (failure) {
        console.error(`nortuscc: could not install dependencies (${failure}); run 'npm ${RUNTIME_INSTALL.join(' ')}' in ${repo}`);
        return 1;
      }
    }

    // A child process, because the modules this process loaded are the pre-pull ones: a fresh
    // process reads the pulled code (and dependencies) from disk.
    const applied = spawnSync(process.execPath, [join(CHECKOUT, 'bin', 'nortuscc.mjs'), 'apply', '--target', target, ...rest], {
      stdio: 'inherit', env: process.env,
    });
    if (applied.error) {
      console.error(`nortuscc: could not run apply: ${applied.error.message}`);
      return 1;
    }
    const code = applied.status ?? 128 + (applied.signal ? constants.signals[applied.signal] : 0);
    if (code !== 0) return code;

    // A pull can bring down a newly declared integration. It is reported, never installed: a
    // fast-forward must not turn into an unattended run of third-party installers. With --install,
    // apply already ran the install workflow.
    if (rest.includes('--install')) return 0;
    const opened = yield* openMachine();
    const { manifestErrors, planned } = yield* inspectIntegrations(opened, selectedTargets(target)).pipe(Effect.provide(opened.layer));
    if (manifestErrors.length) {
      process.stdout.write('\n' + section('integrations', manifestErrors.map((m) => formatRow('manifest', 'invalid', m))));
      return 0;
    }
    const unresolved = planned.filter((i) => i.state !== 'installed');
    if (unresolved.length) {
      process.stdout.write('\n' + section('integrations', [
        ...unresolved.map((i) => formatRow(i.label, i.state, i.note ?? '')),
        // Unknown means the agent's CLI could not answer; installing cannot fix that.
        ...(unresolved.some((i) => i.state !== 'unknown') ? ['', '  nortuscc apply --install'] : []),
      ]));
    }
    return 0;
  }));
}
