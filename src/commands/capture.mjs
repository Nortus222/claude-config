import { writeFileSync } from 'node:fs';
import { SYNC } from '../manifest.mjs';
import { parseTarget, entriesForTarget } from '../targets.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { captureCopy } from '../copy.mjs';
import { captureMerge } from '../merge-keys.mjs';
import { formatRow, section } from '../report.mjs';
import { installedGroups, emitManifest, readSkillLock, manifestPath, readSkillsManifest, installedSkillNames } from '../skills.mjs';
import { parseConfigMode, SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE } from '../config-mode.mjs';

let lastCaptured = [];

// The repo-relative paths the most recent capture actually wrote. push stages
// exactly these, so nothing outside the manifest is ever committed.
export function capturedPaths() {
  return [...lastCaptured];
}

export async function run(allArgs = [], entries = SYNC) {
  const { rest: modeArgs, manageConfig } = parseConfigMode(allArgs);

  const { target, rest: args, error } = parseTarget(modeArgs);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }
  // Skills-only cuts both directions. A machine whose instruction files are its
  // own must not push them into the repo either, or the first `push` would
  // publish the user's private rules to someone else's config repo.
  const selected = manageConfig ? entriesForTarget(entries, target) : [];

  const takeLocal = args.includes('--take-local');
  const takeRepo = args.includes('--take-repo');

  if (takeRepo && takeLocal) {
    console.error('nortuscc: --take-repo and --take-local are mutually exclusive');
    return 2;
  }

  // capture only ever moves machine -> repo, so "keep the repo version" is
  // not a resolution capture can perform — marking the baseline repo without
  // copying would record repo and local as reconciled while they still
  // differ, and the next capture would then overwrite the very local edit the
  // user asked to keep. Refuse rather than guess; apply is the command that
  // actually moves in that direction.
  if (takeRepo) {
    console.error(
      "nortuscc: --take-repo has no effect on capture (capture is machine -> repo).\n" +
        "Use 'nortuscc apply --take-repo' to discard the local version instead.",
    );
    return 2;
  }

  const lock = readLock();
  const before = JSON.stringify(lock);
  const lines = [];
  const captured = [];
  let refused = 0;
  // A settings file that fails to parse as JSON — separate from a conflict,
  // since neither --take-repo nor --take-local can fix invalid JSON.
  let unreadable = 0;
  // A local value validateOwnedKeys refused to write into the repo — separate
  // from both, since the fix is editing the local value, not a flag.
  let invalidValue = 0;

  if (!manageConfig) lines.push(formatRow(SKIPPED_LABEL, SKIPPED_STATE, SKIPPED_NOTE));

  for (const entry of selected) {
    const { src, dest } = resolveEntry(entry);

    if (entry.mode === 'merge-keys') {
      const res = captureMerge(src, dest, `${entry.target}:${entry.dest}`, lock, {
        force: takeLocal,
        relative: entry.dest,
        agent: entry.target,
      });
      // An unparseable local file is not a conflict --take-local can
      // resolve — it is counted apart, so the trailer below never offers a
      // flag that cannot fix invalid JSON. Same for a value validateOwnedKeys
      // refused: no flag on this command can force a credential into the repo.
      if (res.action === 'refused') {
        if (res.reason === 'unparseable-local') unreadable += 1;
        else if (res.reason === 'invalid-capture') invalidValue += 1;
        else refused += 1;
      }
      if (res.action === 'copied') captured.push(entry.src);
      lines.push(formatRow(entry.dest, res.action, noteFor(res)));
      continue;
    }

    if (entry.mode !== 'copy') {
      // Unknown mode: capture has no idea how to remediate this entry, so it is
      // reported and left alone rather than guessed at — the same treatment
      // as missing-repo and conflict, which are also BLOCKED states.
      lines.push(formatRow(entry.dest, 'unknown-mode', 'manifest entry has an unrecognized mode'));
      continue;
    }

    const res = captureCopy(src, dest, `${entry.target}:${entry.dest}`, lock, {
      force: takeLocal,
      relative: entry.dest,
      agent: entry.target,
    });

    if (res.action === 'refused') refused += 1;
    if (res.action === 'copied') captured.push(entry.src);
    // Surface backedUp exactly as apply does: capture overwrites the repo's
    // working tree, which git cannot recover if the edit was never committed,
    // so the path the old content went to must not be printed only by apply.
    lines.push(formatRow(entry.dest, res.action, noteFor(res)));
  }

  // Regenerate the skills manifest from what is actually installed. Capture is
  // the only command that writes it, so an install done the normal way is shared
  // by running capture afterwards.
  //
  // Gated on what is on disk, not on the lock alone: the lock outlives the
  // folder, so a skill removed by `npx skills remove` — or by `update --prune`
  // — leaves its entry behind. Regenerating from the lock would re-add it,
  // handing every other machine a skill this one deliberately removed. It also
  // keeps the shrink guard below honest: a lingering entry would pad the count
  // and let a genuine shrink through unnoticed.
  const manifestBefore = readSkillsManifest();
  const groups = installedGroups(readSkillLock(), installedSkillNames(), manifestBefore);
  const beforeCount = manifestBefore.reduce((n, g) => n + g.skills.length, 0);
  const afterCount = groups.reduce((n, g) => n + g.skills.length, 0);

  if (afterCount < beforeCount && !args.includes('--allow-shrink')) {
    lines.push(formatRow('skills-manifest', 'refused', `would drop ${beforeCount - afterCount} entr(ies); pass --allow-shrink`));
  } else if (groups.length > 0) {
    writeFileSync(manifestPath(), emitManifest(groups), 'utf8');
    captured.push('skills-manifest.txt');
    lines.push(formatRow('skills-manifest', 'written', `${afterCount} skill(s)`));
  }

  // Only rewrite the lockfile when something in it actually changed. captureCopy
  // already refuses to restamp a baseline that is merely stale-but-converged;
  // this guard extends that idempotency to the file write itself, so a clean
  // machine's lockfile mtime — and an otherwise-empty backup directory — never
  // move on a no-op run.
  if (JSON.stringify(lock) !== before) writeLock(lock);
  lastCaptured = captured;
  process.stdout.write('\n' + section('capture', lines));

  // An unparseable local file gets its own message: --take-local is a
  // conflict remedy, and it cannot fix invalid JSON.
  if (unreadable > 0) {
    process.stdout.write(
      `\n${unreadable} settings file(s) could not be parsed and were left untouched.\n` +
        '  fix the JSON by hand, then re-run capture\n',
    );
  }
  if (invalidValue > 0) {
    process.stdout.write(
      `\n${invalidValue} key(s) held a value that looks like a credential and were left uncaptured.\n` +
        '  this file is committed; fix the local value, then re-run capture\n',
    );
  }
  if (refused > 0) {
    process.stdout.write(`\n${refused} conflict(s) refused. Use --take-local to keep the local version.\n`);
  }
  if (refused > 0 || unreadable > 0 || invalidValue > 0) return 1;
  return 0;
}

function noteFor(res) {
  if (res.action === 'refused' && res.reason === 'unparseable-local') {
    return 'could not be parsed as JSON — fix it by hand, then re-run';
  }
  if (res.action === 'refused' && res.reason === 'invalid-capture') {
    return 'looks like a credential — nothing captured';
  }
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
