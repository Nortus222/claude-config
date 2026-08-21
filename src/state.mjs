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

// Directory links are gone: no managed path is a directory any more, so the
// link state machine — and 'clobbered', 'wrong-target' and 'broken-link' with
// it — had no remaining producer. Native installers own the layouts those
// links used to stand in for.
export const NEEDS_APPLY = new Set(['repo-ahead', 'unmanaged', 'missing']);
export const NEEDS_CAPTURE = new Set(['local-ahead']);
// 'unparseable-local' is the merge-keys equivalent of a conflict the tool must
// not resolve: the user's settings.json could not be read, so no part of it is
// ours to rewrite. 'invalid' is a repo file validateOwnedKeys refused — present
// and readable, but not one this tool will act on either direction.
export const BLOCKED = new Set(['conflict', 'missing-repo', 'unknown-mode', 'unparseable-local', 'invalid']);
