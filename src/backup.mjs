import { mkdirSync, renameSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { backupRoot } from './resolve.mjs';

// One backup directory per process run, so a single command's displacements
// stay together and are obvious to find afterwards.
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
let runDir = null;

export function backupDir() {
  if (!runDir) {
    runDir = join(backupRoot(), `nortuscc-${STAMP}`);
    mkdirSync(runDir, { recursive: true });
  }
  return runDir;
}

export function backupPath(relative) {
  const target = join(backupDir(), relative);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

// Move whatever is at absPath into the backup directory. Returns where it went,
// or null if there was nothing to preserve. rename is tried first and falls back
// to copy+remove, since rename fails across volumes.
export function backupOnce(absPath, relative) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative);
  try {
    renameSync(absPath, target);
  } catch {
    cpSync(absPath, target, { recursive: true });
    rmSync(absPath, { recursive: true, force: true });
  }
  return target;
}
