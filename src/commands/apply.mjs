import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock, writeLock } from '../lock.mjs';
import { ensureLink } from '../link.mjs';
import { applyCopy } from '../copy.mjs';
import { formatRow, section } from '../report.mjs';
import { readSkillsManifest, readSkillLock, installedSkillNames, reconcile, installArgs } from '../skills.mjs';
import { installGroups } from '../skills-cli.mjs';

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

  const lock = readLock();
  const before = JSON.stringify(lock);
  const lines = [];
  let refused = 0;

  for (const entry of entries) {
    const { src, dest, mode } = resolveEntry(entry);

    if (mode === 'link') {
      const res = ensureLink(dest, src, entry.dest);
      lines.push(formatRow(entry.dest, res.state, res.backedUp ? `backed up -> ${res.backedUp}` : ''));
      continue;
    }

    if (mode !== 'copy') {
      // Unknown mode: apply has no idea how to remediate this entry, so it is
      // reported and left alone rather than guessed at — the same treatment
      // as missing-repo and conflict, which are also BLOCKED states.
      lines.push(formatRow(entry.dest, 'unknown-mode', 'manifest entry has an unrecognized mode'));
      continue;
    }

    // --take-local is a capture-side resolution; here it means "leave the local
    // file alone", which apply already does for anything but a conflict. Passing
    // force only for --take-repo keeps a conflict refused under --take-local.
    const res = applyCopy(src, dest, entry.dest, lock, { force: takeRepo });
    if (res.action === 'refused') refused += 1;
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
      await installGroups(installArgs(skills.missing));
      lines.push(formatRow('skills', 'installed', skills.missing.map((m) => m.name).join(', ')));
    }
  }

  // Only rewrite the lockfile when something in it actually changed. applyCopy
  // already refuses to restamp a baseline that is merely stale-but-converged;
  // this guard extends that idempotency to the file write itself, so a clean
  // machine's lockfile mtime — and an otherwise-empty backup directory — never
  // move on a no-op run.
  if (JSON.stringify(lock) !== before) writeLock(lock);

  process.stdout.write('\n' + section('apply', lines));

  if (refused > 0) {
    process.stdout.write(
      `\n${refused} conflict(s) refused. Resolve with:\n` +
        '  nortuscc apply --take-repo    discard the local version\n' +
        '  nortuscc capture --take-local keep the local version\n',
    );
    return 1;
  }
  return 0;
}

function noteFor(res) {
  if (res.action === 'refused') return 'conflict — nothing changed';
  if (res.backedUp) return `backed up -> ${res.backedUp}`;
  return '';
}
