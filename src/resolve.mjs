import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

// The single test for "is this path a usable clone?", shared by repoRoot's
// stale-lock guard and by setup's --dir validation so the two can never
// disagree about which paths are acceptable. `.git` is a directory in a normal
// clone and a file in a linked worktree; existsSync accepts both.
export function isGitCheckout(path) {
  return Boolean(path) && existsSync(path) && existsSync(join(path, '.git'));
}

// A stale lock.repo is worth exactly one line of warning per process: repoRoot()
// is called once per manifest entry per command, so warning every time would
// bury the report it is meant to draw attention to.
let warnedStaleRepo = false;

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
        if (isGitCheckout(lock.repo)) {
          return lock.repo;
        }
        // Stale path: warn once, then fall through to the module location.
        // Falling through silently is what made a poisoned lock.repo invisible
        // — every command would quietly sync against a different repo than the
        // one the user believes is recorded.
        if (!warnedStaleRepo) {
          warnedStaleRepo = true;
          console.error(
            `nortuscc: recorded repo '${lock.repo}' is not a git checkout; ` +
              `using ${resolve(here, '..')} instead. Re-run 'nortuscc setup --dir <path>' to fix the record.`,
          );
        }
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

export function codexDir() {
  return process.env.NORTUSCC_CODEX_DIR || join(homedir(), '.codex');
}

const AGENT_DIRS = { claude: claudeDir, codex: codexDir };

// The one place a target becomes a filesystem path. It throws rather than
// defaulting, because every other outcome of an unrecognised target — writing
// under ~/.claude, or under the home directory itself — is a write to
// somewhere the user never named.
export function agentDir(target) {
  const dir = AGENT_DIRS[target];
  if (!dir) throw new Error(`nortuscc: unknown target '${target}'`);
  return dir();
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

// Turn a manifest entry into absolute paths on both sides. The destination
// side is chosen by the entry's own target, so a Claude entry can never land
// in ~/.codex and vice versa.
export function resolveEntry(entry) {
  return {
    ...entry,
    src: join(repoRoot(), entry.src),
    dest: join(agentDir(entry.target), entry.dest),
  };
}
