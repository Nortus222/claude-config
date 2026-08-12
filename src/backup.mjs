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

// `agent` groups a run's displaced files by the target they belong to, so a
// single `--target all` run's CLAUDE.md and AGENTS.md land in separate
// subdirectories instead of colliding on identical relative names. It is
// omitted for things no single agent owns — shared skill folders — which then
// sit directly under the run directory.
//
// The agent is a path segment rather than part of the filename because lock
// keys use `claude:CLAUDE.md`, and a colon is not a legal filename character
// on Windows.
export function backupPath(relative, agent = null) {
  const target = join(backupDir(), ...(agent ? [agent] : []), relative);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}

// Move whatever is at absPath into the backup directory. Returns where it went,
// or null if there was nothing to preserve. rename is tried first and falls back
// to copy+remove, since rename fails across volumes.
export function backupOnce(absPath, relative, agent = null) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative, agent);
  try {
    renameSync(absPath, target);
  } catch {
    cpSync(absPath, target, { recursive: true });
    rmSync(absPath, { recursive: true, force: true });
  }
  return target;
}

// Copy rather than move. backupOnce moves its target aside, which is right
// when something else is about to take that path — but a skill folder has to
// stay exactly where it is for the updater to overwrite it in place, so
// preserving it here must not disturb the original.
export function preserveCopy(absPath, relative, agent = null) {
  if (!existsSync(absPath)) return null;
  const target = backupPath(relative, agent);
  cpSync(absPath, target, { recursive: true });
  return target;
}
