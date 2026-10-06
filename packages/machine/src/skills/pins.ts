import { isCommitSha, type DesiredConfig } from '@nortuscc/profile-engine';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A sha as the reports print it: its first seven characters.
export const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

// The ref the installer recorded for a skill, or null when it recorded none.
export const lockRef = (meta: unknown): string | null =>
  isRecord(meta) && typeof meta.ref === 'string' && meta.ref ? meta.ref : null;

// Source → pinned sha, from the resolved skills (pins are per source).
export const pinsBySource = (desired: DesiredConfig): ReadonlyMap<string, string> =>
  new Map(desired.skills.flatMap((s) => (s.pin ? [[s.source, s.pin.ref] as const] : [])));

// The installer source argument and step-key suffix: `o/r#<sha>` when pinned, else `o/r`.
export const pinnedSource = (source: string, sha: string | undefined): string => (sha ? `${source}#${sha}` : source);

// Splits a step's source back into source and sha; sha only when the suffix is a commit sha.
export const splitPinned = (value: string): { source: string; sha?: string } => {
  const at = value.lastIndexOf('#');
  const sha = value.slice(at + 1);
  return at >= 0 && isCommitSha(sha) ? { source: value.slice(0, at), sha } : { source: value };
};

// The note on a skill installed at a ref other than its pin; `to: null` means the source is no longer pinned.
export const offPinNote = (from: string | null, to: string | null): string =>
  `installed at ${from ? short(from) : 'no pin'}, ${to ? `pinned to ${short(to)}` : 'unpinned'}`;
