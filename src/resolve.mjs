import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

export function moduleRoot() {
  return resolve(here, '..');
}

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

// The `repo` field of whichever state record exists, or null. Read straight
// off disk rather than through lock.mjs, which imports this module — the same
// import-cycle dodge the old lockfile read used.
//
// The legacy lock is consulted only as a fallback, so a machine that has not
// been migrated yet still resolves its repo on the very first command, before
// anything has had a chance to write neutral state.
function recordedRepo() {
  for (const path of [statePath(), legacyLockPath()]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed.repo && typeof parsed.repo === 'string') return parsed.repo;
    } catch {
      // Corrupt record: try the next one, then fall through to the module location
    }
  }
  return null;
}

// src/ lives directly under the repo root. The override lets tests that WRITE
// to the repo side (capture) point at a throwaway fixture instead of mutating
// tracked files.
export function repoRoot({ warnStale = true } = {}) {
  // Priority 1: explicit env var override (used by tests and npx scenarios)
  if (process.env.NORTUSCC_REPO_DIR) {
    return process.env.NORTUSCC_REPO_DIR;
  }

  // Priority 2: the recorded repo, if it is a valid, existing git checkout
  const recorded = recordedRepo();
  if (recorded) {
    if (isGitCheckout(recorded)) return recorded;
    // Stale path: warn once, then fall through to the module location.
    // Falling through silently is what made a poisoned repo record invisible
    // — every command would quietly sync against a different repo than the
    // one the user believes is recorded.
    if (warnStale && !warnedStaleRepo) {
      warnedStaleRepo = true;
      console.error(
        `nortuscc: recorded repo '${recorded}' is not a git checkout; ` +
          `using ${moduleRoot()} instead. Re-run 'nortuscc setup --dir <path>' to fix the record.`,
      );
    }
  }

  // Priority 3: module's own location (original behavior)
  return moduleRoot();
}

export function claudeDir() {
  return process.env.NORTUSCC_CLAUDE_DIR || join(homedir(), '.claude');
}

export function codexDir() {
  return process.env.NORTUSCC_CODEX_DIR || join(homedir(), '.codex');
}

export function openRouterCodexDir() {
  if (process.env.NORTUSCC_OPENROUTER_CODEX_DIR) return process.env.NORTUSCC_OPENROUTER_CODEX_DIR;
  if (process.env.NORTUSCC_CODEX_DIR) return join(dirname(process.env.NORTUSCC_CODEX_DIR), '.codex-openrouter');
  return join(homedir(), '.codex-openrouter');
}

const MACHINE_DIRS = { claude: claudeDir, codex: codexDir, 'codex-openrouter': openRouterCodexDir };

// The one place a target becomes a filesystem path. It throws rather than
// defaulting, because every other outcome of an unrecognised target — writing
// under ~/.claude, or under the home directory itself — is a write to
// somewhere the user never named.
export function agentDir(target) {
  const dir = MACHINE_DIRS[target];
  if (!dir) throw new Error(`nortuscc: unknown target '${target}'`);
  return dir();
}

export function agentsSkillsDir() {
  return process.env.NORTUSCC_AGENTS_DIR || join(homedir(), '.agents', 'skills');
}

// Machine state is nortuscc's own bookkeeping, not any agent's configuration,
// so it lives outside both ~/.claude and ~/.codex. NORTUSCC_STATE_DIR is the
// complete override: point it at a throwaway directory and nothing this
// process records can reach the developer's real machine state.
export function stateRoot() {
  if (process.env.NORTUSCC_STATE_DIR) return process.env.NORTUSCC_STATE_DIR;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? '', 'nortuscc');
  return join(homedir(), '.config', 'nortuscc');
}

export function statePath() {
  return join(stateRoot(), 'state.json');
}

// Where state lived when Claude Code was the only target. Read during
// migration and as a repo fallback; never written, never removed.
export function legacyLockPath() {
  return join(claudeDir(), '.nortuscc-lock.json');
}

export function backupRoot() {
  return join(stateRoot(), 'backups');
}

// Turn a manifest entry into absolute paths on both sides. The destination
// side is chosen by the entry's own target, so a Claude entry can never land
// in ~/.codex and vice versa.
export function resolveEntry(entry) {
  return {
    ...entry,
    src: join(repoRoot(), entry.src),
    dest: join(agentDir(entry.machine ?? entry.target), entry.dest),
  };
}
