// Drafts the changelog Publish shows, from the watcher's reports. Pure: no git, network or LLM.
import type { Revision, SkillChange, SourceReport } from './model.ts';
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

const MERGE_NOISE = /^Merge (?:pull request|branch|remote-tracking branch)\b/;

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

// The source's list: updated skills with their subjects, then added, removed and ignored ones.
function items(report: SourceReport, choice: AcceptedSource): string[] {
  const ignored = new Set(choice.ignored ?? []);
  const kept = new Set(choice.added ?? []);
  const subjects = new Map(report.commits.map((commit) => [commit.sha, commit.subject]));
  const shown = (status: SkillChange['status']) =>
    report.skills.filter((skill) => skill.status === status && !ignored.has(skill.name));

  const lines: string[] = [];
  for (const skill of shown('changed')) {
    lines.push(`- Updated \`${skill.name}\``);
    const seen = new Set<string>();
    for (const sha of skill.commits) {
      const subject = redact(subjects.get(sha) ?? '').trim();
      if (subject === '' || MERGE_NOISE.test(subject) || seen.has(subject)) continue;
      seen.add(subject);
      lines.push(`  - ${subject}`);
    }
  }
  for (const name of report.added) if (kept.has(name)) lines.push(`- Added \`${name}\``);
  for (const skill of shown('removed')) lines.push(`- Removed \`${skill.name}\``);
  const quiet = report.skills.filter(
    (skill) => ignored.has(skill.name) && (skill.status === 'changed' || skill.status === 'removed'),
  );
  if (quiet.length > 0) lines.push(`- Also updated: ${quiet.map((skill) => `\`${skill.name}\``).join(', ')}`);
  return lines.length > 0 ? lines : ["- No changes to this setup's skills."];
}
