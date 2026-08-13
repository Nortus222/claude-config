import { SYNC } from '../manifest.mjs';
import { parseTarget, entriesForTarget } from '../targets.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { applyCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from '../skills.mjs';
import { installGroups, installAgentIdsFor } from '../skills-cli.mjs';
import { parseInstallFlags } from '../install-plan.mjs';
import { defaultInstallDeps } from '../install-sections.mjs';
import { runInstall } from './install.mjs';

// Turns installGroups' per-source {source, ok} results into report lines and
// a failure count, kept separate from installGroups itself so the mapping
// from source back to skill name — and the "some sources failed, some
// didn't" case — is testable without spawning anything.
export function summarizeSkillsInstall(missing, results) {
  const okSources = new Set(results.filter((r) => r.ok).map((r) => r.source));
  const installedNames = missing.filter((m) => okSources.has(m.source)).map((m) => m.name);
  const failedNames = missing.filter((m) => !okSources.has(m.source)).map((m) => m.name);

  const lines = [];
  // A partial failure gets both rows, never collapsed into total success or
  // total failure.
  if (installedNames.length > 0) lines.push(formatRow('skills', 'installed', installedNames.join(', ')));
  if (failedNames.length > 0) lines.push(formatRow('skills', 'failed', failedNames.join(', ')));

  return { lines, failed: failedNames.length };
}

// entries defaults to SYNC; the parameter exists so tests can inject a bogus
// manifest entry to exercise the unknown-mode path, the same pattern
// configReport uses in status.mjs.
export async function run(allArgs = [], entries = SYNC, deps = {}) {
  // Target first, before any other flag parsing: --target and its value must
  // never reach a parser that would read them as something else, and an
  // invalid target has to exit 2 before a single file is written.
  const { target, rest: args, error } = parseTarget(allArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  const selected = entriesForTarget(entries, target);

  const takeRepo = args.includes('--take-repo');
  const takeLocal = args.includes('--take-local');

  if (takeRepo && takeLocal) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }

  // apply only ever moves repo -> machine, so "keep the local version" is not
  // a resolution apply can perform — marking the baseline local without
  // copying would record repo and local as reconciled while they still
  // differ, and the next apply would then overwrite the very file the user
  // asked to keep. Refuse rather than guess; capture is the command that
  // actually moves in that direction.
  if (takeLocal) {
    console.error(
      "nortuscc: --take-local has no effect on apply (apply is repo -> machine).\n" +
        "Use 'nortuscc capture --take-local' to keep the local version instead.",
    );
    return 2;
  }

  const lock = readLock();
  const before = JSON.stringify(lock);
  const lines = [];
  let refused = 0;
  let skillsFailed = 0;
  // Tracks whether this run actually wrote anything to an agent directory, so
  // the restart reminder below only fires when it is true and stays silent on
  // a clean, idempotent no-op run.
  let changed = false;

  for (const entry of selected) {
    const { src, dest, mode } = resolveEntry(entry);

    if (mode !== 'copy') {
      // Unknown mode: apply has no idea how to remediate this entry, so it is
      // reported and left alone rather than guessed at — the same treatment
      // as missing-repo and conflict, which are also BLOCKED states.
      lines.push(formatRow(entry.dest, 'unknown-mode', 'manifest entry has an unrecognized mode'));
      continue;
    }

    // --take-local is refused above before this loop ever runs, so the only
    // force this command ever applies is --take-repo, discarding the local
    // side of a conflict.
    const res = applyCopy(src, dest, `${entry.target}:${entry.dest}`, lock, {
      force: takeRepo,
      relative: entry.dest,
      agent: entry.target,
    });
    if (res.action === 'refused') refused += 1;
    if (res.action === 'copied') changed = true;
    lines.push(formatRow(entry.dest, res.action, noteFor(res)));
  }

  // --skills is the compatibility alias: it installs missing skills and
  // nothing else, which is what it always did. --install is the full workflow.
  const skillsAlias = args.includes('--skills');
  if (skillsAlias && !args.includes('--install')) {
    process.stdout.write(
      "\nnortuscc: --skills is deprecated; use 'nortuscc apply --install --no-hooks --no-mcp --no-plugins'\n",
    );

    const skills = reconcile({
      groups: readSkillsManifest(),
      lock: readSkillLock(),
      installedNames: installedSkillNames(),
    });
    if (skills.missing.length === 0) {
      lines.push(formatRow('skills', 'satisfied', ''));
    } else {
      const results = await installGroups(installArgs(skills.missing), { agents: installAgentIdsFor(target) });
      const summary = summarizeSkillsInstall(skills.missing, results);
      lines.push(...summary.lines);
      skillsFailed = summary.failed;
    }
  }

  // Only rewrite the lockfile when something in it actually changed. applyCopy
  // already refuses to restamp a baseline that is merely stale-but-converged;
  // this guard extends that idempotency to the file write itself, so a clean
  // machine's lockfile mtime — and an otherwise-empty backup directory — never
  // move on a no-op run.
  if (JSON.stringify(lock) !== before) writeLock(lock);

  process.stdout.write('\n' + section('apply', lines));

  // Instruction files are only read by an agent at startup, so a successful
  // apply that changed anything has no visible effect until the user restarts
  // — bootstrap.sh printed this reminder unconditionally on every run; here it
  // is conditioned on actually having changed something, so a clean re-run
  // stays silent. It no longer names settings.json: that file is user-owned
  // and this command does not write it.
  if (changed) {
    process.stdout.write('\nRestart the affected agent to load the synced instructions.\n');
  }

  // A configuration conflict stops the run before installation. Installing on
  // top of an unresolved conflict would bury the one thing the user has to
  // decide under a wall of installer output.
  if (refused > 0) {
    process.stdout.write(
      `\n${refused} conflict(s) refused. Resolve with:\n` +
        '  nortuscc apply --take-repo    discard the local version\n' +
        '  nortuscc capture --take-local keep the local version\n',
    );
    return 1;
  }

  if (skillsFailed > 0) {
    process.stdout.write(`\n${skillsFailed} skill(s) failed to install. See output above for details.\n`);
    return 1;
  }

  if (args.includes('--install')) {
    // --skills alongside --install narrows the workflow to skills alone,
    // which is what --skills has always meant.
    const aliasOptOuts = skillsAlias ? ['--no-hooks', '--no-mcp', '--no-plugins'] : [];
    return await installFor(target, [...args, ...aliasOptOuts], { takeRepo, deps });
  }

  return 0;
}

// Shared by apply --install and by setup, so both offer exactly the same rows
// in the same order.
export async function installFor(target, args, { takeRepo = false, deps = {} } = {}) {
  const flags = parseInstallFlags(args.filter((a) => a === '--yes' || a.startsWith('--no-')));
  const wiring = deps.sections
    ? deps
    : await defaultInstallDeps(target, { force: takeRepo, codexState: deps.codexState });

  if (wiring.integrationErrors?.length) {
    for (const message of wiring.integrationErrors) console.error(`nortuscc: ${message}`);
    console.error('nortuscc: integrations.json is invalid; nothing was installed.');
    return 2;
  }

  return await runInstall({
    target,
    flags,
    deps: { ...wiring, isTTY: deps.isTTY, select: deps.select, confirm: deps.confirm },
  });
}

function noteFor(res) {
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
