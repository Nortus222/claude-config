// The single source of truth for what syncs and how.
//
// mode: 'link' — an agent never writes this path, so a symlink is safe and gives
//                live sync. Directories only.
// mode: 'copy' — Claude Code rewrites this file in place, which would silently
//                replace a symlink with a regular file. Copy it and track a hash.
export const SYNC = [
  { src: 'claude/bin', dest: 'bin', mode: 'link' },
  { src: 'claude/hooks', dest: 'hooks', mode: 'link' },
  { src: 'claude/settings.json', dest: 'settings.json', mode: 'copy' },
  { src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
];
