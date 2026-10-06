import { isCommitSha } from '@nortuscc/profile-engine';
import { Effect } from 'effect';
import { DocumentInvalid, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';

// Brings a revision into the setup: pins `source` to `ref` in skill-pins.json, or unpins it when
// `ref` is undefined. `ref` must be a full commit sha (callers pass `pinImpact(...).to.sha`). The pin
// moves every skill from that source; preview with `pinImpact`.
export const pinSource = (
  repoDir: string,
  source: string,
  ref: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  ref !== undefined && !isCommitSha(ref)
    ? Effect.fail(new DocumentInvalid({ reason: redact(`'${ref}' is not a full commit sha; pin impact.to.sha`) }))
    : writeEntry(repoDir, 'pins', source, ref, options);
