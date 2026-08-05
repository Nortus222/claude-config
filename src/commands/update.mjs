import { join } from 'node:path';
import { planUpdates, updatableSkills, sourcesOf } from '../skill-updates.mjs';
import { resolveTrees as realResolveTrees } from '../git-trees.mjs';
import { confirm as realConfirm } from '../prompt.mjs';
import { preserveCopy } from '../backup.mjs';
import { runUpdate as realRunUpdate } from '../skills-cli.mjs';
import { readSkillLock, installedSkillNames } from '../skills.mjs';
import { agentsSkillsDir } from '../resolve.mjs';
import { formatRow, section } from '../report.mjs';

const short = (sha) => (sha ? sha.slice(0, 7) : 'unknown');

// `local` is informational — a hand-authored skill is not a problem to fix.
// `gone` and `unknown` both need a decision, so they exit non-zero the way
// `status` does when anything needs attention.
//
// Declining is deliberately not an input here: a declined update is not a
// failure, so it returns whatever the plan alone says. That still leaves a
// `gone` skill exiting 1 even when the user said no to updating.
export function exitCode({ plan, updateFailed }) {
  if (updateFailed) return 1;
  if (plan.gone.length > 0 || plan.unknown.length > 0) return 1;
  return 0;
}

// Counts first, in the aggregate style status.mjs uses, then a detail line per
// outdated skill — listing 24 up-to-date skills individually would bury the
// two that matter.
export function reportLines(plan) {
  const lines = [];
  if (plan.current.length) lines.push(formatRow('current', String(plan.current.length), ''));
  if (plan.outdated.length) {
    lines.push(formatRow('outdated', String(plan.outdated.length), plan.outdated.map((o) => o.name).join(', ')));
  }
  if (plan.gone.length) {
    lines.push(formatRow('gone', String(plan.gone.length), plan.gone.map((g) => g.name).join(', ')));
  }
  if (plan.unknown.length) {
    lines.push(formatRow('unreachable', String(plan.unknown.length), plan.unknown.map((u) => u.name).join(', ')));
  }
  if (plan.local.length) {
    lines.push(formatRow('local', String(plan.local.length), plan.local.join(', ')));
  }
  if (!lines.length) lines.push(formatRow('skills', 'none', 'nothing installed to check'));

  if (plan.outdated.length) {
    lines.push('');
    for (const o of plan.outdated) {
      lines.push(formatRow(o.name, 'outdated', `${short(o.from)} -> ${short(o.to)}  ${o.source}`));
    }
  }
  return lines;
}

export async function run(args = [], deps = {}) {
  const {
    resolveTrees = realResolveTrees,
    confirm = realConfirm,
    runUpdate = realRunUpdate,
    preserve = preserveCopy,
    readLock = readSkillLock,
    installed = installedSkillNames,
  } = deps;

  const check = args.includes('--check');
  const yes = args.includes('--yes');

  // --check never prompts, so --yes has nothing to skip. Refusing beats
  // silently ignoring one of them, the same call apply makes on
  // --take-repo --take-local.
  if (check && yes) {
    console.error('nortuscc: --check and --yes are mutually exclusive (--check never prompts)');
    return 2;
  }

  const lock = readLock();
  const installedNames = installed();
  const entries = updatableSkills(lock, installedNames);

  // One clone per source, not per skill. A source that fails to clone is left
  // out of remoteTrees entirely, which is how planUpdates learns to mark just
  // that source's skills unknown while the others still get a real answer.
  const remoteTrees = new Map();
  for (const { sourceUrl, paths } of sourcesOf(entries)) {
    const trees = await resolveTrees(sourceUrl, paths);
    if (trees) remoteTrees.set(sourceUrl, trees);
  }

  const plan = planUpdates({ lock, installedNames, remoteTrees });
  process.stdout.write('\n' + section('update', reportLines(plan)));

  if (check) {
    if (plan.outdated.length) {
      process.stdout.write('\nRun: nortuscc update\n');
      return 1;
    }
    return exitCode({ plan, updateFailed: false });
  }

  if (plan.outdated.length === 0) {
    return exitCode({ plan, updateFailed: false });
  }

  if (!yes) {
    const answer = await confirm(`\nUpdate ${plan.outdated.length} skill(s)?`);
    if (answer === null) {
      console.error(
        '\nnortuscc: no terminal to confirm on. Re-run with --yes to update without asking,\n' +
          '  or with --check to report only.',
      );
      return 2;
    }
    if (!answer) {
      process.stdout.write('nothing updated\n');
      return exitCode({ plan, updateFailed: false });
    }
  }

  // Backups before the updater, never after: once it has overwritten a skill
  // folder in place the previous version is gone, and this copy is the only
  // way back.
  const names = plan.outdated.map((o) => o.name);
  let backupLocation = null;
  for (const name of names) {
    backupLocation = preserve(join(agentsSkillsDir(), name), join('skills', name)) || backupLocation;
  }
  if (backupLocation) process.stdout.write(`\nbacked up -> ${backupLocation}\n`);

  const ok = await runUpdate(names);

  // Re-read the lock rather than assuming the update did what was asked, so
  // the closing report describes what was observed.
  const after = readLock();
  const moved = plan.outdated.filter((o) => after.skills?.[o.name]?.skillFolderHash !== o.from);
  process.stdout.write(
    '\n' + section('updated', moved.length
      ? moved.map((o) => formatRow(o.name, 'updated', `${short(o.from)} -> ${short(after.skills[o.name]?.skillFolderHash)}`))
      : [formatRow('skills', 'unchanged', 'the updater reported no change')]),
  );

  if (!ok) {
    process.stdout.write('\nThe updater failed. See the output above; the backup is listed at the top.\n');
  }

  return exitCode({ plan, updateFailed: !ok });
}
