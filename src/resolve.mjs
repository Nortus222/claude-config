import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// src/ lives directly under the repo root. The override lets tests that WRITE
// to the repo side (capture) point at a throwaway fixture instead of mutating
// tracked files.
export function repoRoot() {
  return process.env.NORTUSCC_REPO_DIR || resolve(here, '..');
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
