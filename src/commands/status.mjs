import { SYNC } from '../manifest.mjs';
import { parseTarget, entriesForTarget } from '../targets.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock } from '../lock.mjs';
import { inspectCopy } from '../copy.mjs';
import { NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../state.mjs';
import { formatRow, section } from '../report.mjs';
import { readIntegrations } from '../integrations/manifest.mjs';
import { integrationPlan } from '../integrations/runner.mjs';
import { defaultAdapters } from '../integrations/adapters.mjs';
import {
  readSkillsManifest,
  readSkillLock,
  installedSkillNames,
  reconcile,
  brokenSkillLinks,
  claudeSkillsDir,
} from '../skills.mjs';

// Read-only by construction: nothing here writes, including the lockfile.
export function configReport(entries = SYNC) {
  const lock = readLock();
  return entries.map((entry) => {
    const { src, dest, mode } = resolveEntry(entry);
    if (mode === 'copy') {
      // Keyed by target so Claude's CLAUDE.md and Codex's AGENTS.md can never
      // share one baseline; entry.dest stays the display name.
      const baseline = lock.files[`${entry.target}:${entry.dest}`]?.hash;
      return { dest: entry.dest, mode, state: inspectCopy(src, dest, baseline).state };
    } else {
      // Unknown mode: surface as a visible error rather than silently misdispatching
      return { dest: entry.dest, mode, state: 'unknown-mode' };
    }
  });
}

export async function run(args = []) {
  const { target, error } = parseTarget(args);
  if (error) {
    console.error(`nortuscc: ${error}`);
    return 2;
  }

  const rows = configReport(entriesForTarget(SYNC, target));
  const lines = rows.map((r) => formatRow(r.dest, r.state, noteFor(r)));
  process.stdout.write('\n' + section('config', lines));

  // Read-only: integrationPlan inspects, it never installs. `nortuscc setup`
  // and `apply --install` are the only paths that act on this.
  const { integrations, errors } = readIntegrations();
  const adapters = defaultAdapters();
  const planned = errors.length ? [] : integrationPlan({ integrations, target, adapters });
  const pending = planned.filter((item) => item.state !== 'installed');

  const integrationLines = errors.length
    ? errors.map((message) => formatRow('manifest', 'invalid', message))
    : planned.length === 0
      ? [formatRow('none declared', 'satisfied', '')]
      : pending.length === 0
        ? [formatRow('all declared', 'installed', '')]
        : [
            ...pending.map((item) => formatRow(item.label, item.state, item.note)),
            '',
            '  nortuscc apply --install',
          ];
  process.stdout.write(section('integrations', integrationLines));

  const skills = reconcile({
    groups: readSkillsManifest(),
    lock: readSkillLock(),
    installedNames: installedSkillNames(),
  });
  const skillLines = [];
  if (skills.missing.length) {
    skillLines.push(formatRow('missing', String(skills.missing.length), skills.missing.map((m) => m.name).join(', ')));
  }
  if (skills.extra.length) {
    skillLines.push(formatRow('extra', String(skills.extra.length), skills.extra.join(', ')));
  }
  if (skills.local.length) {
    skillLines.push(formatRow('local', String(skills.local.length), skills.local.join(', ')));
  }
  const broken = brokenSkillLinks();
  if (broken.length) {
    skillLines.push(formatRow('broken links', String(broken.length), broken.join(', ')));
  }
  if (!skillLines.length) skillLines.push(formatRow('manifest', 'satisfied', ''));
  if (skills.missing.length) skillLines.push('', '  nortuscc apply --skills');
  if (broken.length) {
    skillLines.push('', `  remove stale links under ${claudeSkillsDir()} after confirming`);
  }
  process.stdout.write(section('skills', skillLines));

  const actionable = rows.filter(
    (r) => NEEDS_APPLY.has(r.state) || NEEDS_CAPTURE.has(r.state) || BLOCKED.has(r.state),
  );

  // A selected integration that is missing or blocked is as actionable as a
  // drifted file: the machine is not in agreement with what the repo declares.
  if (
    actionable.length === 0 &&
    errors.length === 0 &&
    pending.length === 0 &&
    skills.missing.length === 0 &&
    broken.length === 0
  ) {
    process.stdout.write('\neverything is in agreement\n');
    return 0;
  }

  process.stdout.write('\n' + suggestions(actionable) + '\n');
  return 1;
}

function noteFor(row) {
  switch (row.state) {
    case 'conflict': return 'changed in the repo AND here';
    case 'local-ahead': return 'local edits not in the repo';
    case 'repo-ahead': return 'repo has newer content';
    case 'unmanaged': return 'never synced on this machine';
    case 'missing-repo': return 'listed in the manifest but absent from the repo';
    case 'unknown-mode': return 'manifest entry has an unrecognized mode';
    default: return '';
  }
}

function suggestions(rows) {
  const out = [];
  if (rows.some((r) => NEEDS_APPLY.has(r.state))) out.push('  nortuscc apply     bring this machine up to date');
  if (rows.some((r) => NEEDS_CAPTURE.has(r.state))) out.push('  nortuscc push -m   share local edits');
  if (rows.some((r) => r.state === 'conflict')) {
    // Each command only understands the flag that matches its own direction —
    // `apply --take-local` is refused outright — so the suggestion has to name
    // the command that can actually perform each resolution.
    out.push('  conflicts need a decision:');
    out.push('    nortuscc apply --take-repo    discard the local version');
    out.push('    nortuscc capture --take-local keep the local version');
  }
  return out.join('\n');
}
