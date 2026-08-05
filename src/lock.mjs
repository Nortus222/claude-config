import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { lockPath } from './resolve.mjs';

const LOCK_VERSION = 1;

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

// A missing or corrupt lockfile is treated as first run rather than as an
// error: every managed file then reads as 'unmanaged', which backs up before
// writing instead of overwriting blind.
export function readLock() {
  const path = lockPath();
  if (!existsSync(path)) return emptyLock();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.files) return emptyLock();
    return { version: parsed.version ?? LOCK_VERSION, repo: parsed.repo ?? null, files: parsed.files };
  } catch {
    return emptyLock();
  }
}

export function writeLock(lock) {
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}

export function setBaseline(lock, dest, hash) {
  lock.files[dest] = { hash, appliedAt: new Date().toISOString() };
}
