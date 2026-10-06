import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from 'node:fs';
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
  return { version: LOCK_VERSION, repo: null, skillsOnly: false, files: {} };
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
  // skillsOnly is read strictly: anything but a literal true means this machine
  // manages its instruction files, which is the behaviour every state record
  // written before the flag existed was describing.
  return {
    version: parsed.version ?? LOCK_VERSION,
    repo: parsed.repo ?? null,
    skillsOnly: parsed.skillsOnly === true,
    ...(Array.isArray(parsed.configTargets)
      && parsed.configTargets.every((target) => ['claude', 'codex'].includes(target))
      ? { configTargets: [...new Set(parsed.configTargets)] } : {}),
    files: parsed.files,
  };
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
  return withOverrides(readStateOnly());
}

function readStateOnly() {
  const state = readStateFile(statePath());
  if (state) return state;
  // No usable neutral state: this may be a machine that still has the old
  // Claude-side lock, so give the migration its one chance before reporting
  // every managed file as never synced.
  if (existsSync(statePath())) return emptyLock();
  return migrateLegacyState().state;
}

// Transitional until the legacy CLI is removed (#59): the TypeScript commands keep the machine's
// choices only in overrides.json and drop them from state.json, so when overrides.json exists and
// parses as an object its choices replace state.json's. Otherwise state.json's fields stand.
function withOverrides(lock) {
  let overrides;
  try {
    overrides = JSON.parse(readFileSync(join(stateRoot(), 'overrides.json'), 'utf8'));
  } catch {
    return lock;
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return lock;
  const { configTargets: _stateTargets, ...rest } = lock;
  const targets = overrides.configTargets;
  return {
    ...rest,
    skillsOnly: overrides.manageConfig === false,
    ...(Array.isArray(targets) && targets.every((target) => ['claude', 'codex'].includes(target))
      ? { configTargets: [...new Set(targets)] } : {}),
  };
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
    mirrorOverrides(lock);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

// overrides.json, once a TypeScript command has written it, records the same two choices. Until
// cutover (#59) every state write keeps it in step. It is never created here, and a malformed one
// is left for its owner. A failed mirror warns and never fails the state write.
function mirrorOverrides(lock) {
  const path = join(stateRoot(), 'overrides.json');
  let current;
  try {
    current = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return;
  const next = { ...current };
  delete next.manageConfig;
  delete next.configTargets;
  if (lock.skillsOnly === true) next.manageConfig = false;
  if (Array.isArray(lock.configTargets)) next.configTargets = lock.configTargets;
  if (next.manageConfig === current.manageConfig
    && JSON.stringify(next.configTargets) === JSON.stringify(current.configTargets)) return;
  const temp = join(stateRoot(), `.overrides.json.${process.pid}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best effort: the warning below is the report.
    }
    console.error(`nortuscc: could not update overrides.json: ${err.message}`);
  }
}

export function setBaseline(lock, dest, hash) {
  lock.files[dest] = { hash, appliedAt: new Date().toISOString() };
}

function lockHolder(path) {
  try {
    const pid = JSON.parse(readFileSync(path, 'utf8')).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Runs `fn` holding <stateRoot>/apply.lock, the lock @nortuscc/machine's executor takes, so a
// legacy command that reads state.json and rewrites it whole never overlaps a desktop or
// TypeScript run. Same file format; a lock whose holder died is taken over. Returns fn's exit
// code, or 1 after naming a live holder.
export async function withApplyLock(fn) {
  const root = stateRoot();
  const path = join(root, 'apply.lock');
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; ; attempt++) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      linkSync(temp, path);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = lockHolder(path);
      if ((pid !== null && isAlive(pid)) || attempt > 0) {
        console.error(`nortuscc: another nortuscc run (pid ${pid ?? 'unknown'}) holds ${path}`);
        return 1;
      }
      rmSync(path, { force: true });
    } finally {
      rmSync(temp, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    if (lockHolder(path) === process.pid) rmSync(path, { force: true });
  }
}
