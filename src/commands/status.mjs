import { SYNC } from '../manifest.mjs';
import { resolveEntry } from '../resolve.mjs';
import { readLock } from '../lock.mjs';
import { inspectLink } from '../link.mjs';
import { inspectCopy } from '../copy.mjs';
import { NEEDS_APPLY, NEEDS_CAPTURE, BLOCKED } from '../state.mjs';
import { formatRow, section } from '../report.mjs';
import { loadPluginState, pluginReport } from '../plugins.mjs';

// Read-only by construction: nothing here writes, including the lockfile.
export function configReport(entries = SYNC) {
  const lock = readLock();
  return entries.map((entry) => {
    const { src, dest, mode } = resolveEntry(entry);
    if (mode === 'link') {
      return { dest: entry.dest, mode, state: inspectLink(dest, src).state };
    } else if (mode === 'copy') {
      const baseline = lock.files[entry.dest]?.hash;
      return { dest: entry.dest, mode, state: inspectCopy(src, dest, baseline).state };
    } else {
      // Unknown mode: surface as a visible error rather than silently misdispatching
      return { dest: entry.dest, mode, state: 'unknown-mode' };
    }
  });
}

export async function run() {
  const rows = configReport();
  const lines = rows.map((r) => formatRow(r.dest, r.state, noteFor(r)));
  process.stdout.write('\n' + section('config', lines));

  const { settings, installed, marketplaces } = loadPluginState();
  const plugins = pluginReport(settings, installed, marketplaces);
  const pluginLines =
    plugins.commands.length === 0
      ? [formatRow('all enabled', 'installed', '')]
      : [
          ...plugins.missingMarketplaces.map((m) => formatRow(m, 'no marketplace', '')),
          ...plugins.missingPlugins.map((p) => formatRow(p, 'not installed', '')),
          '',
          ...plugins.commands.map((c) => `  ${c}`),
        ];
  process.stdout.write(section('plugins', pluginLines));

  const actionable = rows.filter(
    (r) => NEEDS_APPLY.has(r.state) || NEEDS_CAPTURE.has(r.state) || BLOCKED.has(r.state),
  );

  if (actionable.length === 0 && plugins.commands.length === 0) {
    process.stdout.write('\neverything is in agreement\n');
    return 0;
  }

  process.stdout.write('\n' + suggestions(actionable) + '\n');
  return 1;
}

function noteFor(row) {
  switch (row.state) {
    case 'clobbered': return 'a real path sits where a link belongs';
    case 'wrong-target': return 'link points somewhere else';
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
    out.push('  conflicts need a decision: nortuscc apply --take-repo | --take-local');
  }
  return out.join('\n');
}
