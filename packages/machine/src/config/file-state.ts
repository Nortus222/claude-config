import { hashText } from '../hash.ts';

export type FileState = 'clean' | 'repo-ahead' | 'local-ahead' | 'conflict' | 'unmanaged' | 'missing-repo';

// The three-way state of one copied file or settings key, from hashes; undefined means absent.
export const fileState = (input: { readonly baseline?: string; readonly repo?: string; readonly local?: string }): FileState => {
  const { baseline, repo, local } = input;
  if (repo === undefined) return 'missing-repo';
  if (baseline === undefined) return 'unmanaged';
  // A deleted local file is recoverable from the repo, so it reads as the repo being ahead.
  if (local === undefined) return 'repo-ahead';
  // Both sides converged: nothing to reconcile, only a stale baseline.
  if (repo === local) return 'clean';
  if (local === baseline) return 'repo-ahead';
  if (repo === baseline) return 'local-ahead';
  return 'conflict';
};

// A JSON value's text with object keys sorted: agents rewrite settings in place, and key order is
// not a change. Array order is.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// undefined for an absent value, which fileState reads as "not on this side".
export const hashValue = (value: unknown): string | undefined =>
  value === undefined ? undefined : hashText(canonical(value));
