# Files are synced by copy against a recorded baseline, never by symlink

Claude Code and Codex rewrite their instruction files in place by writing a temp file and
renaming it, which silently replaces a symlink with a regular file. Each managed file is
therefore copied, and the hash from the last apply or capture is kept in machine-local state. Repo,
baseline and local file are compared three ways (clean, repo-ahead, local-ahead, conflict); a
conflict is refused, and only `--take-repo` or `--take-local` can discard an edit.

## Considered options

- Symlinks: break silently on atomic rewrites and need Developer Mode on Windows.
- Linking the directories nobody writes and copying the rest: built first, then retired once
  native installers took over those layouts.
- JSON-aware merging of whole files: refusing conflicts is simpler and loses nothing.
