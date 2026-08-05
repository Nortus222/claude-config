import { join } from 'node:path';
import { planUpdates, updatableSkills, sourcesOf } from '../skill-updates.mjs';
import { inspectSource as realInspectSource } from '../git-trees.mjs';
import { confirm as realConfirm } from '../prompt.mjs';
import { preserveCopy, backupDir } from '../backup.mjs';
import { runUpdate as realRunUpdate } from '../skills-cli.mjs';
import { readSkillLock, installedSkillNames } from '../skills.mjs';
import { agentsSkillsDir } from '../resolve.mjs';
import { formatRow, section, labelWidth } from '../report.mjs';

const FLAGS = new Set(['--check', '--yes']);

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
    // Skill names are arbitrary, so the column has to be sized to the batch —
    // `setup-matt-pocock-skills` is 24 characters and would otherwise push its
    // own state column eight past everyone else's.
    const width = labelWidth(plan.outdated.map((o) => o.name));
    for (const o of plan.outdated) {
      lines.push(formatRow(o.name, 'outdated', `${short(o.from)} -> ${short(o.to)}  ${o.source}`, width));
    }
  }
  // Mirrors status.mjs's broken-links footer: a count row alone leaves a
  // `gone` skill with no next step, and the one suggestion `update` prints
  // elsewhere (`Run: nortuscc update`) excludes `gone` skills by construction
  // — following it in a loop just reprints the same three rows forever.
  //
  // The footer names its skills rather than saying "them". It prints directly
  // below the outdated detail rows, so a pronoun reads as referring to those,
  // which is the opposite of what it means. And "re-add upstream" was never
  // advice the reader could act on — the folder is gone from someone else's
  // repo. What they can actually do is drop it locally.
  if (plan.gone.length) {
    lines.push(
      '',
      `  gone upstream: ${plan.gone.map((g) => g.name).join(', ')}`,
      '  nothing can update these. Remove with: npx skills remove <name> --global',
      '  then run: nortuscc capture   to drop them from the manifest',
    );
  }
  return lines;
}

export async function run(args = [], deps = {}) {
  const {
    inspectSource = realInspectSource,
    confirm = realConfirm,
    runUpdate = realRunUpdate,
    preserve = preserveCopy,
    readLock = readSkillLock,
    installed = installedSkillNames,
  } = deps;

  // Unlike apply, which merely ignores what it does not recognise, update's
  // default action writes. `--chek` is a plausible slip when reaching for the
  // refused `--check --yes`, and ignoring it would turn a typo into an
  // unprompted full update. Refuse before reading anything.
  const unknown = args.filter((a) => !FLAGS.has(a));
  if (unknown.length) {
    console.error(`nortuscc: unknown option(s) for update: ${unknown.join(', ')}`);
    console.error('Usage: nortuscc update [--check] [--yes]');
    return 2;
  }

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
    const found = await inspectSource(sourceUrl, paths);
    if (found) remoteTrees.set(sourceUrl, found.trees);
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
  // Print the shared directory, not the last per-skill path preserve() returns
  // — a multi-skill batch lands together under one backupDir(), and naming
  // only the last skill's path would read as if the others were never saved.
  let anyBackedUp = false;
  // preserveCopy returns null when existsSync sees nothing at the path —
  // which includes a broken symlink, since existsSync follows links while
  // installedSkillNames (deliberately) counts them. That skill still goes to
  // the updater unmodified — a broken link is exactly what an update should
  // repair — but it must be named here rather than passing through silently,
  // since it is the one case where CLAUDE.md's "backup before anything
  // destructive" rule would otherwise be quietly untrue.
  const unprotected = [];
  for (const name of names) {
    if (preserve(join(agentsSkillsDir(), name), join('skills', name))) anyBackedUp = true;
    else unprotected.push(name);
  }
  if (anyBackedUp) process.stdout.write(`\nbacked up -> ${backupDir()}\n`);
  if (unprotected.length) {
    process.stdout.write(`\nno backup exists for: ${unprotected.join(', ')} (nothing was there to copy) — updating without a backup\n`);
  }

  const ok = await runUpdate(names);

  // Re-read the lock rather than assuming the update did what was asked, so
  // the closing report describes what was observed. A skill only counts as
  // moved when both the recorded and re-read hashes are known — an entry
  // with `from: null` (no hash was ever recorded) or one the updater's lock
  // no longer mentions must not read as "unknown -> unknown".
  const after = readLock();
  const movedInfo = plan.outdated
    .map((o) => ({ o, to: after.skills?.[o.name]?.skillFolderHash ?? null }))
    .filter(({ o, to }) => o.from != null && to != null && to !== o.from);
  process.stdout.write(
    '\n' + section('updated', movedInfo.length
      ? movedInfo.map(({ o, to }) =>
          formatRow(o.name, 'updated', `${short(o.from)} -> ${short(to)}`, labelWidth(movedInfo.map(({ o: m }) => m.name))))
      : [formatRow('skills', 'unchanged', 'the updater reported no change')]),
  );

  if (!ok) {
    process.stdout.write(
      anyBackedUp
        ? '\nThe updater failed. See the output above; the backup is listed at the top.\n'
        : '\nThe updater failed. No backup was made — nothing existed to preserve.\n',
    );
  }

  return exitCode({ plan, updateFailed: !ok });
}
