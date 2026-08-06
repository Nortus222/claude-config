import { writeFileSync } from 'node:fs';
import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { captureCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';
import { installedGroups, emitManifest, readSkillLock, manifestPath, readSkillsManifest, installedSkillNames } from '../skills.mjs';

let lastCaptured = [];

// The repo-relative paths the most recent capture actually wrote. push stages
// exactly these, so nothing outside the manifest is ever committed.
export function capturedPaths() {
  return [...lastCaptured];
}

export async function run(args = [], entries = SYNC) {
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

  for (const entry of entries) {
    // Linked directories need no capture: the repo IS the live copy.
    if (entry.mode === 'link') continue;

    if (entry.mode !== 'copy') {
      // Unknown mode: capture has no idea how to remediate this entry, so it is
      // reported and left alone rather than guessed at — the same treatment
      // as missing-repo and conflict, which are also BLOCKED states.
      lines.push(formatRow(entry.dest, 'unknown-mode', 'manifest entry has an unrecognized mode'));
      continue;
    }

    const { src, dest } = resolveEntry(entry);
    const res = captureCopy(src, dest, entry.dest, lock, { force: takeLocal });

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
  const groups = installedGroups(readSkillLock(), installedSkillNames());
  const manifestBefore = readSkillsManifest();
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

  if (refused > 0) {
    process.stdout.write(`\n${refused} conflict(s) refused. Use --take-local to keep the local version.\n`);
    return 1;
  }
  return 0;
}

function noteFor(res) {
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
