// The single source of truth for what syncs and how.
//
// Every entry carries the agent it belongs to, so one manifest serves both
// targets and `--target` is a filter over this table rather than a second
// implementation of every command.
//
// mode: 'copy' — an agent rewrites its instruction file in place, which would
//                silently replace a symlink with a regular file. Copy it and
//                track a hash.
//
// Only portable instruction files are managed. Claude's settings.json and
// Codex's config.toml stay user-owned: they mix portable rules with
// permissions, UI preferences and machine-specific state.
export const SYNC = [
  { target: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
  { target: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy' },
];
