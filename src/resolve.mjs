import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// src/ lives directly under the repo root. The override lets tests that WRITE
// to the repo side (capture) point at a throwaway fixture instead of mutating
// tracked files.
export function repoRoot() {
  // Priority 1: explicit env var override (used by tests and npx scenarios)
  if (process.env.NORTUSCC_REPO_DIR) {
    return process.env.NORTUSCC_REPO_DIR;
  }

  // Priority 2: recorded lock.repo if it's a valid, existing git checkout
  // Read lockfile directly to avoid import cycle with lock.mjs
  const lockFilePath = lockPath();
  if (existsSync(lockFilePath)) {
    try {
      const lock = JSON.parse(readFileSync(lockFilePath, 'utf8'));
      if (lock.repo && typeof lock.repo === 'string') {
        // Validate: path must exist and look like a git repo
        if (existsSync(lock.repo) && existsSync(join(lock.repo, '.git'))) {
          return lock.repo;
        }
        // Stale path: log and fall through to module location
      }
    } catch {
      // Corrupt lockfile: ignore and fall through
    }
  }

  // Priority 3: module's own location (original behavior)
  return resolve(here, '..');
}

export function claudeDir() {
  return process.env.NORTUSCC_CLAUDE_DIR || join(homedir(), '.claude');
}

export function agentsSkillsDir() {
  return process.env.NORTUSCC_AGENTS_DIR || join(homedir(), '.agents', 'skills');
}

export function lockPath() {
  return join(claudeDir(), '.nortuscc-lock.json');
}

export function backupRoot() {
  return join(claudeDir(), 'backups');
}

// Turn a manifest entry into absolute paths on both sides.
export function resolveEntry(entry) {
  return {
    ...entry,
    src: join(repoRoot(), entry.src),
    dest: join(claudeDir(), entry.dest),
  };
}
