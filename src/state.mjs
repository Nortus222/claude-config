// Pure state derivation. No I/O, no imports — this is the part of the CLI
// most worth getting right, so it is kept trivially testable.

// Copied files: compare both sides against the baseline recorded at last sync.
// `repo` and `local` are hashes, or null when the file is absent.
export function fileState({ baseline, repo, local }) {
  if (repo === null || repo === undefined) return 'missing-repo';
  if (baseline === null || baseline === undefined) return 'unmanaged';

  // A deleted local file is recoverable from the repo, so treat it as the repo
  // being ahead rather than as a loss to adjudicate.
  if (local === null || local === undefined) return 'repo-ahead';

  // Both sides moved but landed on identical content — nothing to reconcile,
  // only a stale baseline. Checking this before the conflict branch keeps
  // convergence from being reported as a conflict.
  if (repo === local) return 'clean';

  const repoMoved = repo !== baseline;
  const localMoved = local !== baseline;

  if (!repoMoved && !localMoved) return 'clean';
  if (repoMoved && !localMoved) return 'repo-ahead';
  if (!repoMoved && localMoved) return 'local-ahead';
  return 'conflict';
}

// Linked directories: the failure the old scripts could not see is 'clobbered',
// where a real directory sits where a link belongs and syncing silently stopped.
export function linkState({ exists, isSymlink, target, expectedTarget }) {
  if (!exists) return 'missing';
  if (!isSymlink) return 'clobbered';
  if (target !== expectedTarget) return 'wrong-target';
  return 'linked';
}

export const NEEDS_APPLY = new Set(['repo-ahead', 'unmanaged', 'missing', 'clobbered', 'wrong-target']);
export const NEEDS_CAPTURE = new Set(['local-ahead']);
export const BLOCKED = new Set(['conflict', 'missing-repo']);
