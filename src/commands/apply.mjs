import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { ensureLink, inspectLink } from '../link.mjs';
import { applyCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from '../skills.mjs';
import { installGroups } from '../skills-cli.mjs';

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
export async function run(args = [], entries = SYNC) {
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
  let linksUnresolved = 0;
  // Tracks whether this run actually wrote anything to ~/.claude, so the
  // restart reminder below only fires when it is true and stays silent on a
  // clean, idempotent no-op run.
  let changed = false;

  for (const entry of entries) {
    const { src, dest, mode } = resolveEntry(entry);

    if (mode === 'link') {
      // Read the state before ensureLink fixes it — ensureLink always reports
      // 'linked' on success, whether or not it had to do anything, so the
      // pre-state is the only way to tell a repair from a no-op.
      const { state: preState } = inspectLink(dest, src);
      const res = ensureLink(dest, src, entry.dest);
      if (preState !== 'linked') changed = true;
      // ensureLink reports the post-state honestly, so a link it rebuilt over a
      // repo path that is simply not there stays visible instead of being
      // reported as a success apply did not achieve.
      if (res.state !== 'linked') linksUnresolved += 1;
      lines.push(formatRow(entry.dest, res.state, noteForLink(res, src)));
      continue;
    }

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
    const res = applyCopy(src, dest, entry.dest, lock, { force: takeRepo });
    if (res.action === 'refused') refused += 1;
    if (res.action === 'copied') changed = true;
    lines.push(formatRow(entry.dest, res.action, noteFor(res)));
  }

  if (args.includes('--skills')) {
    const skills = reconcile({
      groups: readSkillsManifest(),
      lock: readSkillLock(),
      installedNames: installedSkillNames(),
    });
    if (skills.missing.length === 0) {
      lines.push(formatRow('skills', 'satisfied', ''));
    } else {
      const results = await installGroups(installArgs(skills.missing));
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

  // settings.json and CLAUDE.md are only read by Claude Code at startup, so a
  // successful apply that changed anything has no visible effect until the
  // user restarts — bootstrap.sh printed this reminder unconditionally on
  // every run; here it is conditioned on actually having changed something,
  // so a clean re-run stays silent.
  if (changed) {
    process.stdout.write('\nRestart Claude Code to load the synced settings.\n');
  }

  if (refused > 0) {
    process.stdout.write(
      `\n${refused} conflict(s) refused. Resolve with:\n` +
        '  nortuscc apply --take-repo    discard the local version\n' +
        '  nortuscc capture --take-local keep the local version\n',
    );
    return 1;
  }

  if (linksUnresolved > 0) {
    process.stdout.write(
      `\n${linksUnresolved} link(s) still lead nowhere: the repo path they need is missing.\n` +
        '  Check that the repo recorded in ~/.claude/.nortuscc-lock.json still exists,\n' +
        '  then re-run: nortuscc apply\n',
    );
    return 1;
  }

  if (skillsFailed > 0) {
    process.stdout.write(`\n${skillsFailed} skill(s) failed to install. See output above for details.\n`);
    return 1;
  }

  return 0;
}

function noteForLink(res, src) {
  if (res.state !== 'linked') return `target missing in the repo: ${src}`;
  return res.backedUp ? `backed up -> ${res.backedUp}` : '';
}

function noteFor(res) {
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
