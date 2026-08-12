import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { statePath, stateRoot, legacyLockPath } from './resolve.mjs';

const LOCK_VERSION = 1;

// The one legacy key worth carrying forward. Everything else the old lock
// recorded — settings.json, bin, hooks — describes management that is being
// retired, not relocated, so importing it would leave a permanent baseline
// for a file no manifest entry will ever reconcile again.
const LEGACY_KEYS = { 'CLAUDE.md': 'claude:CLAUDE.md' };

// Line endings are normalised before digesting so that a CRLF checkout on
// Windows does not read as permanent drift against an LF repo.
export function hashText(text) {
  const normalised = text.replace(/\r\n/g, '\n');
  return 'sha256:' + createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export function hashFile(path) {
  if (!existsSync(path)) return null;
  return hashText(readFileSync(path, 'utf8'));
}

function emptyLock() {
  return { version: LOCK_VERSION, repo: null, files: {} };
}

// Shape-check whatever JSON was on disk. A record that isn't the shape we
// expect is treated as absent rather than trusted halfway.
function parseState(text) {
  const parsed = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !parsed.files ||
    typeof parsed.files !== 'object' ||
    Array.isArray(parsed.files)
  ) {
    return null;
  }
  return { version: parsed.version ?? LOCK_VERSION, repo: parsed.repo ?? null, files: parsed.files };
}

function readStateFile(path) {
  if (!existsSync(path)) return null;
  try {
    return parseState(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Import what the pre-Codex lock recorded, once, into the neutral state file.
//
// Runs only when neutral state is absent: after the first migration the
// neutral file is authoritative, and re-importing would resurrect baselines
// the user has since moved past. The old lock is read and left exactly as it
// was — it is the only record a machine has if this migration turns out to be
// wrong, so nothing here unlinks or rewrites it.
export function migrateLegacyState() {
  const existing = readStateFile(statePath());
  if (existing) return { migrated: false, state: existing };

  const legacy = readStateFile(legacyLockPath());
  if (!legacy) return { migrated: false, state: emptyLock() };

  const state = emptyLock();
  state.repo = legacy.repo ?? null;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
    if (legacy.files[oldKey]) state.files[newKey] = legacy.files[oldKey];
  }

  writeLock(state);
  return { migrated: true, state };
}

// A missing or corrupt state file is treated as first run rather than as an
// error: every managed file then reads as 'unmanaged', which backs up before
// writing instead of overwriting blind.
export function readLock() {
  const state = readStateFile(statePath());
  if (state) return state;
  // No usable neutral state: this may be a machine that still has the old
  // Claude-side lock, so give the migration its one chance before reporting
  // every managed file as never synced.
  if (existsSync(statePath())) return emptyLock();
  return migrateLegacyState().state;
}

// Written to a sibling and renamed into place. A half-written state file
// parses as corrupt, which degrades every managed file to 'unmanaged' and
// makes the next apply back up and overwrite files it had already reconciled
// — rename is atomic on every platform this runs on, so a reader sees either
// the old file or the whole new one.
export function writeLock(lock) {
  const root = stateRoot();
  mkdirSync(root, { recursive: true });
  const target = statePath();
  const temp = join(root, `.state.json.${process.pid}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

export function setBaseline(lock, dest, hash) {
  lock.files[dest] = { hash, appliedAt: new Date().toISOString() };
}
