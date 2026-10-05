import { Effect } from 'effect';
import { DocumentInvalid, readEntries, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';
import type { SourceReport } from './model.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type Ignores = Readonly<Record<string, string>>; // source → ignored sha

// The ignored revisions in source-ignores.json. Lenient like the engine's pin reader: an absent
// or invalid file ignores nothing, and an invalid one says why.
export function readIgnores(text: string | undefined): { readonly ignores: Ignores; readonly problem?: string } {
  if (text === undefined) return { ignores: {} };
  try {
    return { ignores: readEntries(text, 'ignored') };
  } catch (error) {
    if (error instanceof DocumentInvalid) return { ignores: {}, problem: error.reason };
    throw error;
  }
}

// Whether a report's new revision is one the author ignored. Only `ahead` and `diverged` reports
// flag something new; once upstream moves past the ignored sha, it is flagged again.
export function isIgnored(report: SourceReport, ignores: Ignores): boolean {
  if (report.status !== 'ahead' && report.status !== 'diverged') return false;
  const sha = Object.hasOwn(ignores, report.source) ? ignores[report.source] : undefined;
  return sha !== undefined && report.latest?.sha?.toLowerCase() === sha.toLowerCase();
}

// Records that the author has seen `sha` (a source's latest revision) and does not want it
// flagged; undefined clears the source's entry. One sha per source, in source-ignores.json.
export const ignoreRevision = (
  repoDir: string,
  source: string,
  sha: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  sha !== undefined && !FULL_SHA.test(sha)
    ? Effect.fail(new DocumentInvalid({ reason: redact(`'${sha}' is not a full commit sha`) }))
    : writeEntry(repoDir, 'ignored', source, sha, options);
