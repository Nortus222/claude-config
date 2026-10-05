import { Effect } from 'effect';
import { DocumentInvalid, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

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
