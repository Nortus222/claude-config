import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashFile, setBaseline } from './lock.mjs';
import { fileState } from './state.mjs';
import { backupOnce, backupPath } from './backup.mjs';

// Copy into the backup directory without removing the original. A refusal must
// leave both sides exactly as they were, so this cannot use backupOnce, which
// moves.
function preserve(absPath, relative, agent) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative, agent);
  copyFileSync(absPath, target);
  return target;
}

export function inspectCopy(src, dest, baseline) {
  const repo = hashFile(src);
  const local = hashFile(dest);
  return { state: fileState({ baseline, repo, local }), repo, local };
}

function write(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}

// `key` is the state-file key — `claude:CLAUDE.md`, so the two agents' files
// cannot collide on one baseline. `relative` is the on-disk backup path and
// defaults to the key, which keeps callers that have no target (and the state
// machine's own tests) unchanged; `agent` groups backups by target.
//
// repo -> machine. Refuses a conflict unless force is set, and never touches a
// file whose only change is local.
export function applyCopy(src, dest, key, lock, { force = false, relative = key, agent = null } = {}) {
  const baseline = lock.files[key]?.hash;
  const { state, repo } = inspectCopy(src, dest, baseline);

  if (state === 'missing-repo') return { action: 'skipped', backedUp: null };
  if (state === 'clean') {
    // Only restamp when the baseline is actually stale (both sides converged
    // on new, identical content). A no-op refresh here would make every apply
    // on an already-clean machine rewrite the state file.
    if (repo && baseline !== repo) setBaseline(lock, key, repo);
    return { action: 'skipped', backedUp: null };
  }

  // local-ahead is apply's signal to leave a file alone — that's capture's
  // job — unless force explicitly asks to discard the local side anyway.
  if (state === 'local-ahead' && !force) {
    return { action: 'skipped', backedUp: null };
  }

  if (state === 'conflict' && !force) {
    // Preserve the local side even though nothing is being overwritten, so the
    // user can resolve from a stable copy while continuing to work.
    return { action: 'refused', backedUp: preserve(dest, relative, agent) };
  }

  // unmanaged, repo-ahead, a forced local-ahead, or a forced conflict: the
  // local file is about to be replaced, so keep whatever was there.
  const backedUp = existsSync(dest) ? backupOnce(dest, relative, agent) : null;
  write(src, dest);
  setBaseline(lock, key, hashFile(dest));
  return { action: 'copied', backedUp };
}

// machine -> repo. Mirrors applyCopy with the directions swapped.
export function captureCopy(src, dest, key, lock, { force = false, relative = key, agent = null } = {}) {
  const baseline = lock.files[key]?.hash;
  const { state, local } = inspectCopy(src, dest, baseline);

  if (state === 'missing-repo' || local === null) return { action: 'skipped', backedUp: null };
  if (state === 'clean' || state === 'repo-ahead') {
    // Same convergence guard as applyCopy: only restamp when stale.
    if (state === 'clean' && local && baseline !== local) setBaseline(lock, key, local);
    return { action: 'skipped', backedUp: null };
  }

  if (state === 'conflict' && !force) {
    return { action: 'refused', backedUp: preserve(dest, relative, agent) };
  }

  // unmanaged, local-ahead, or a forced conflict: the repo file is about to be
  // replaced, so keep whatever was there first, exactly as applyCopy does for
  // the local side. copyFileSync overwrites the working tree with no relation
  // to git's index or HEAD, so an uncommitted repo-side edit is not otherwise
  // recoverable.
  const backedUp = existsSync(src) ? backupOnce(src, relative, agent) : null;
  write(dest, src);
  setBaseline(lock, key, hashFile(src));
  return { action: 'copied', backedUp };
}
