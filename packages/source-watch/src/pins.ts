import { Effect } from 'effect';
import { DocumentInvalid, type WriteOptions, type Written, WriteFailed, writeEntry } from './documents.ts';
import { redact } from './redact.ts';

// Brings a revision into the setup: pins `source` to `ref` in skill-pins.json, or unpins it when
// `ref` is undefined. The pin moves every skill from that source; preview with `pinImpact`.
export const pinSource = (
  repoDir: string,
  source: string,
  ref: string | undefined,
  options: WriteOptions,
): Effect.Effect<Written, DocumentInvalid | WriteFailed> =>
  ref !== undefined && (ref === '' || ref.startsWith('-'))
    ? Effect.fail(new DocumentInvalid({ reason: redact(`'${ref}' cannot be pinned`) }))
    : writeEntry(repoDir, 'pins', source, ref, options);
