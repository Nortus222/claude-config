// Drafts the changelog Publish shows, from the watcher's reports. Pure: no git, network or LLM.
import type { Revision, SourceReport } from './model.ts';
import { redact } from './redact.ts';

// A source the author brought into Contents, at the revision they reviewed.
export type AcceptedSource = {
  readonly source: string;
  readonly revision: string; // full sha; must equal the report's latest
  readonly ignored?: ReadonlyArray<string>; // changed or removed skills to name without detail
  readonly added?: ReadonlyArray<string>; // names from the report's `added` now in the setup
};

export type SkippedSource = { readonly source: string; readonly reason: 'not-watched' | 'stale' | 'no-data' };

export type ChangelogDraft = {
  readonly markdown: string; // '' when there is nothing to say
  readonly skipped: ReadonlyArray<SkippedSource>; // in accepted order; never part of the Markdown
};

// One editable Markdown section per accepted source that moved, in report order.
export function draftChangelog(
  reports: ReadonlyArray<SourceReport>,
  accepted: ReadonlyArray<AcceptedSource>,
): ChangelogDraft {
  const skipped: SkippedSource[] = [];
  const chosen = new Map<string, AcceptedSource>();
  for (const choice of accepted) {
    const report = reports.find((candidate) => candidate.source === choice.source);
    const reason: SkippedSource['reason'] | undefined = !report
      ? 'not-watched'
      : report.status === 'unreachable' || report.status === 'baseline-missing'
        ? 'no-data'
        : report.latest?.sha !== choice.revision
          ? 'stale'
          : undefined;
    if (reason) skipped.push({ source: redact(choice.source), reason });
    else chosen.set(choice.source, choice);
  }

  const drafted = new Set<string>();
  const sections: string[] = [];
  for (const report of reports) {
    const choice = chosen.get(report.source);
    if (!choice || report.status === 'up-to-date' || drafted.has(report.source)) continue;
    drafted.add(report.source);
    sections.push(section(report, choice));
  }
  return { markdown: sections.length > 0 ? `${sections.join('\n\n')}\n` : '', skipped };
}

function section(report: SourceReport, choice: AcceptedSource): string {
  const source = redact(report.source);
  const to = label(report.latest!);
  const heading = report.status === 'unpinned' || !report.baseline
    ? `## ${source} pinned at ${to}`
    : `## ${source} ${label(report.baseline)} → ${to}`;
  return [heading, '', ...items(report, choice)].join('\n');
}

// A revision's name: its highest version-like tag, else its first tag, else a short sha.
function label(revision: Revision): string {
  const versions = revision.tags.filter((tag) => /\d/.test(tag));
  if (versions.length > 0) {
    return versions.reduce((best, tag) => (tag.localeCompare(best, 'en', { numeric: true }) > 0 ? tag : best));
  }
  return revision.tags[0] ?? revision.sha.slice(0, 7);
}

function items(_report: SourceReport, _choice: AcceptedSource): string[] {
  return ["- No changes to this setup's skills."];
}
