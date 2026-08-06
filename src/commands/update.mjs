import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { planUpdates, updatableSkills, sourcesOf, upstreamSkills, availableSkills } from '../skill-updates.mjs';
import { inspectSource as realInspectSource } from '../git-trees.mjs';
import { select as realSelect } from '../select.mjs';
import { choices, actionsFrom, seedKeys } from '../skill-actions.mjs';
import { preserveCopy, backupDir } from '../backup.mjs';
import { runUpdate as realRunUpdate, runRemove as realRunRemove, installGroups as realInstallGroups } from '../skills-cli.mjs';
import { readSkillLock, installedSkillNames, installedGroups, emitManifest, manifestPath, readSkillsManifest, installArgs } from '../skills.mjs';
import { agentsSkillsDir } from '../resolve.mjs';
import { formatRow, section, labelWidth, short } from '../report.mjs';

const NEEDS_NAMES = '--add needs a comma-separated list of skill names';

export function parseFlags(args) {
  const out = { check: false, yes: false, prune: false, add: [], error: null };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--check') { out.check = true; continue; }
    if (arg === '--yes') { out.yes = true; continue; }
    if (arg === '--prune') { out.prune = true; continue; }

    // No bare --add: adopting a whole repo is exactly what a curated skill set
    // is not, so the names have to be said out loud. Both spellings funnel
    // through one place so neither can grow its own rule.
    let names = null;
    if (arg.startsWith('--add=')) {
      names = arg.slice('--add='.length);
    } else if (arg === '--add') {
      const next = args[i + 1];
      // A following flag is not a name list — `--add --prune` is a missing
      // argument, not an adoption of a skill called "--prune".
      if (next && !next.startsWith('-')) { names = next; i += 1; }
    } else {
      // --check/--yes/--prune already `continue`d above, so anything reaching
      // here is neither one of those nor an --add spelling: an unknown flag.
      out.error = `unknown option(s) for update: ${arg}`;
      return out;
    }

    out.add = (names ?? '').split(',').filter(Boolean);
    if (out.add.length === 0) { out.error = NEEDS_NAMES; return out; }
  }

  if (out.check && (out.yes || out.prune || out.add.length)) {
    out.error = '--check is mutually exclusive with --yes, --add and --prune (it reports only)';
  }
  return out;
}

// A count-based shrink guard (before - after) is fooled the moment an adopt
// and a miss cancel out: `--add wizard` on a machine that is also missing a
// manifest entry leaves the totals equal, so a subtraction sees no shrink at
// all and writes — silently dropping the missing entry from the shared
// manifest on the next push. The guard has to compare *sets*: every name the
// current manifest lists that neither survives into the new groups nor was
// actually pruned is a name this machine is simply missing, not one that was
// dealt with.
export function manifestOutcome({ before, groups, prunedNames = [] }) {
  const afterCount = groups.reduce((n, g) => n + g.skills.length, 0);
  // Mirrors capture.mjs's refusal to write a manifest with nothing in it:
  // pruning every entry a machine has is not the same as the shared manifest
  // itself having nothing left to list.
  if (afterCount === 0) {
    return { write: false, reason: 'would leave the manifest empty; nothing was written' };
  }

  const beforeNames = before.flatMap((g) => g.skills);
  const afterNames = new Set(groups.flatMap((g) => g.skills));
  const pruned = new Set(prunedNames);
  const missing = beforeNames.filter((n) => !afterNames.has(n) && !pruned.has(n));

  if (missing.length) {
    return {
      write: false,
      reason:
        `would drop ${missing.length} entr(ies) (${missing.join(', ')}) not accounted for by the` +
        ` prune; run 'nortuscc capture --allow-shrink' if that is intended`,
    };
  }
  return { write: true, reason: `${afterCount} skill(s)` };
}

export function exitCode({ plan, failed, prunedNames = [] }) {
  if (failed) return 1;
  const pruned = new Set(prunedNames);
  const goneLeft = plan.gone.filter((g) => !pruned.has(g.name));
  if (goneLeft.length > 0 || plan.unknown.length > 0) return 1;
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
  if (plan.available?.length) {
    lines.push(formatRow('available', String(plan.available.length), plan.available.map((a) => a.name).join(', ')));
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
  // which is the opposite of what it means.
  //
  // It points at `update --prune`, not a manual `npx skills remove` followed
  // by `nortuscc capture`: the interactive picker below (when one opens)
  // offers exactly this as its `remove` group, with a backup the manual route
  // never takes, and `capture` regenerates the whole manifest from the lock —
  // its own shrink guard would refuse a multi-entry drop with "pass
  // --allow-shrink", leaving a `--check`-mode reader who followed the old
  // advice stuck with a refusal and no explanation. `--check` mode still
  // needs this footer, since no picker opens there to show the same route.
  if (plan.gone.length) {
    lines.push(
      '',
      `  gone upstream: ${plan.gone.map((g) => g.name).join(', ')}`,
      '  nothing can update these. Run: nortuscc update --prune   to remove them (with a backup)',
    );
  }
  return lines;
}

export async function run(args = [], deps = {}) {
  const {
    inspectSource = realInspectSource,
    select = realSelect,
    runUpdate = realRunUpdate,
    runRemove = realRunRemove,
    installGroups = realInstallGroups,
    preserve = preserveCopy,
    readLock = readSkillLock,
    installed = installedSkillNames,
    writeManifest = (text) => writeFileSync(manifestPath(), text, 'utf8'),
    isTTY = process.stdin.isTTY,
  } = deps;

  const flags = parseFlags(args);
  if (flags.error) {
    console.error(`nortuscc: ${flags.error}`);
    console.error('Usage: nortuscc update [--check] [--yes] [--add <names>] [--prune]');
    return 2;
  }

  const lock = readLock();
  const installedNames = installed();
  const entries = updatableSkills(lock, installedNames);

  // One clone per source yields both the tree SHAs and the repo's full skill
  // list, so discovering what is available costs no extra network.
  const remoteTrees = new Map();
  const upstreamBySource = new Map();
  for (const { source, sourceUrl, paths } of sourcesOf(entries)) {
    const found = await inspectSource(sourceUrl, paths);
    if (!found) continue;
    remoteTrees.set(sourceUrl, found.trees);
    upstreamBySource.set(source, upstreamSkills(found.skillPaths));
  }

  const plan = {
    ...planUpdates({ lock, installedNames, remoteTrees }),
    available: availableSkills({ upstreamBySource, installedNames }),
  };
  process.stdout.write('\n' + section('update', reportLines(plan)));

  // seedKeys silently drops an --add name it cannot match against
  // plan.available (a typo, a name already installed, a name from a
  // different repo) — the right call for the picker, where an unmatched name
  // simply pre-ticks nothing, but left unreported it makes a scripted
  // adoption that did nothing look identical to one that worked. Named once,
  // here, so every path below (including "nothing to pick" and "cancelled")
  // reports it the same way.
  const unmatchedAdd = flags.add.filter((name) => !plan.available.some((a) => a.name === name));
  if (unmatchedAdd.length) {
    // A name can also go unmatched because the source that would have
    // offered it could never be reached at all — plan.unknown already names
    // exactly those sources, so say so instead of only ever guessing at a typo.
    const unreachableSources = [...new Set(plan.unknown.map((u) => u.source))];
    const reason = unreachableSources.length
      ? `already installed, misspelled, not offered by a known source, or from a source that could not` +
        ` be reached (${unreachableSources.join(', ')})`
      : 'already installed, misspelled, or not offered by a known source';
    process.stdout.write(`\n--add named skill(s) not found upstream (${reason}): ${unmatchedAdd.join(', ')}\n`);
  }
  // A scripted run that named a skill and adopted none of what it asked for
  // is not a success just because nothing else went wrong — the same
  // standard `gone`/`unknown` already hold the rest of the plan to.
  const addFailed = unmatchedAdd.length > 0;

  if (flags.check) {
    if (plan.outdated.length) process.stdout.write('\nRun: nortuscc update\n');
    return exitCode({ plan, failed: false });
  }

  const seeded = seedKeys(plan, { add: flags.add, prune: flags.prune });
  const rows = choices(plan, { seeded });
  if (rows.length === 0) return exitCode({ plan, failed: addFailed });

  let keys;
  if (flags.yes) {
    // Scripted: take the defaults the picker would have shown, which is every
    // outdated skill plus whatever the flags seeded.
    keys = rows.filter((r) => r.checked).map((r) => r.key);
  } else {
    keys = await select(rows, { title: 'choose what to adopt, refresh and prune', isTTY });
    if (keys === null) {
      if (!isTTY) {
        console.error('\nnortuscc: no terminal to choose on. Re-run with --yes to take the defaults,\n  or with --check to report only.');
        return 2;
      }
      process.stdout.write('nothing selected\n');
      return exitCode({ plan, failed: addFailed });
    }
  }

  const actions = actionsFrom(plan, keys);
  if (!actions.update.length && !actions.remove.length && !actions.add.length) {
    process.stdout.write('nothing selected\n');
    return exitCode({ plan, failed: addFailed });
  }

  // Back up everything about to be removed or overwritten, before either
  // happens. --prune deletes outright, so this is the only copy.
  const touched = [...actions.remove, ...actions.update];
  let anyBackedUp = false;
  const unprotected = [];
  for (const name of touched) {
    if (preserve(join(agentsSkillsDir(), name), join('skills', name))) anyBackedUp = true;
    else unprotected.push(name);
  }
  if (anyBackedUp) process.stdout.write(`\nbacked up -> ${backupDir()}\n`);
  if (unprotected.length) {
    process.stdout.write(`\nno backup exists for: ${unprotected.join(', ')} (nothing was there to copy)\n`);
  }

  // Most destructive first, so a failure partway leaves the least to undo.
  // The two booleans below are kept, not discarded, because the closing
  // report has to describe what was observed — the same reason movedInfo
  // re-reads the lock rather than trusting actions.update wholesale.
  let failed = false;
  const removeOk = actions.remove.length ? await runRemove(actions.remove) : true;
  if (!removeOk) failed = true;
  if (actions.update.length && !(await runUpdate(actions.update))) failed = true;
  // The single source of truth for "did an add fail": every other place that
  // needs to know (the `failed` flag below and the added/failed report split
  // further down) reads this same set, so a source installGroups never
  // returned a result for cannot read as ok in one place and failed in the
  // other.
  let okAddSources = new Set();
  if (actions.add.length) {
    const groups = installArgs(actions.add);
    const installResults = await installGroups(groups);
    okAddSources = new Set(installResults.filter((r) => r.ok).map((r) => r.source));
    if (groups.some((g) => !okAddSources.has(g.source))) failed = true;
  }

  // The manifest is a statement about the machine, so it is rebuilt from the
  // machine — re-reading both the lock and the directory after the executors
  // ran, rather than diffing what we intended to do.
  if (actions.add.length || actions.remove.length) {
    const before = readSkillsManifest();
    const groups = installedGroups(readLock(), installed());
    const outcome = manifestOutcome({ before, groups, prunedNames: removeOk ? actions.remove : [] });
    if (outcome.write) {
      writeManifest(emitManifest(groups));
      process.stdout.write(`\nskills-manifest.txt written — ${outcome.reason}\n`);
      process.stdout.write('Run: nortuscc push -m "..."   to share it\n');
    } else {
      process.stdout.write(`\nskills-manifest.txt left alone — ${outcome.reason}\n`);
    }
  }

  const after = readLock();
  const movedInfo = plan.outdated
    .filter((o) => actions.update.includes(o.name))
    .map((o) => ({ o, to: after.skills?.[o.name]?.skillFolderHash ?? null }))
    .filter(({ o, to }) => o.from != null && to != null && to !== o.from);
  const width = labelWidth(movedInfo.map(({ o }) => o.name));
  // An update was requested but the re-read lock shows no verifiable move —
  // either because nothing actually changed, or because a hash was never
  // recorded to compare against. Either way, silence here would read as if
  // the requested update never happened at all.
  const unmovedUpdate = actions.update.length > 0 && movedInfo.length === 0;

  // runRemove answers for the whole batch in one shot (it is a single `skills
  // remove a b c` invocation), so there is no finer-grained result to report
  // than "all of these failed together". installGroups answers per source, so
  // an add is only marked failed for the source that actually failed — the
  // same split apply.mjs's summarizeSkillsInstall makes ("A partial failure
  // gets both rows, never collapsed into total success or total failure").
  const addedOk = actions.add.filter((a) => okAddSources.has(a.source));
  const addedFailed = actions.add.filter((a) => !okAddSources.has(a.source));

  process.stdout.write(
    '\n' + section('done', [
      ...movedInfo.map(({ o, to }) => formatRow(o.name, 'updated', `${short(o.from)} -> ${short(to)}`, width)),
      ...(unmovedUpdate ? [formatRow('skills', 'unchanged', 'the updater reported no change')] : []),
      ...actions.remove.map((n) => formatRow(n, removeOk ? 'removed' : 'failed', removeOk ? '' : 'remove failed — see output above')),
      ...addedOk.map((a) => formatRow(a.name, 'added', a.source)),
      ...addedFailed.map((a) => formatRow(a.name, 'failed', `${a.source} — install failed, see output above`)),
    ]),
  );

  if (failed) {
    process.stdout.write(
      anyBackedUp
        ? '\nSomething failed above. The backup is listed at the top.\n'
        : '\nSomething failed above. No backup was made — nothing existed to preserve.\n',
    );
  }

  return exitCode({ plan, failed: failed || addFailed, prunedNames: removeOk ? actions.remove : [] });
}
