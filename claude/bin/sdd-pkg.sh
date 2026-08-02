#!/usr/bin/env bash
# SDD working-tree review-package generator (NO commits — user git policy).
#
# Usage: sdd-pkg.sh <output-file> [--title "Title"] <file1> [file2 ...]
#
# Writes a review package for the listed files into <output-file>:
#   - git status --porcelain (scoped to each file)
#   - git diff HEAD          (tracked changes)
#   - full contents of any UNTRACKED new files among the list
#     (these never appear in `git diff HEAD` since nothing is staged)
#
# Submodule-aware: each file is resolved against ITS OWN containing git repo
# (via `git -C <dir>`), so files inside a submodule (e.g. `shared/`) are diffed
# with the submodule's git, and outer-repo files with the outer git — in one
# package. This matters because outer-repo `git diff HEAD` never shows changes
# living inside a submodule (it only shows the `M <submodule>` pointer).
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo 'usage: sdd-pkg.sh <output-file> [--title "Title"] <file1> [file2 ...]' >&2
  exit 2
fi

PKG="$1"; shift

TITLE="Working-tree review package"
if [[ "${1:-}" == "--title" ]]; then
  TITLE="$2"; shift 2
fi

if [[ $# -lt 1 ]]; then
  echo "error: no review files given" >&2
  exit 2
fi

mkdir -p "$(dirname "$PKG")"

# Per-file git helpers that operate in the file's own repo (outer or submodule).
_dir() { dirname -- "$1"; }
_base() { basename -- "$1"; }
_is_untracked() {
  local f="$1"
  [[ -n "$(git -C "$(_dir "$f")" ls-files --others --exclude-standard -- "$(_base "$f")" 2>/dev/null)" ]]
}

{
  echo "# $TITLE"
  echo
  echo "NOTE: No commits (user git policy). This is a WORKING-TREE review."
  echo "Tracked changes are shown via 'git diff HEAD' (run per-file in each file's own repo,"
  echo "so submodule-internal changes are included). Untracked NEW files are dumped in full below."
  echo
  echo "## git status (review files, per repo)"
  for f in "$@"; do
    git -C "$(_dir "$f")" status --porcelain -- "$(_base "$f")" 2>/dev/null \
      | sed "s#\$# ($f)#" || true
  done
  echo
  echo "## git diff HEAD (tracked changes)"
  for f in "$@"; do
    if ! _is_untracked "$f"; then
      echo "### $f"
      git -C "$(_dir "$f")" diff HEAD -- "$(_base "$f")" 2>/dev/null || true
      echo
    fi
  done
  # Untracked NEW files: dump full contents (never appear in diff).
  first_untracked=1
  for f in "$@"; do
    if _is_untracked "$f"; then
      if [[ $first_untracked -eq 1 ]]; then
        echo
        echo "## Untracked NEW files (full contents)"
        first_untracked=0
      fi
      echo
      echo "### $f"
      echo '```'
      cat -- "$f"
      echo '```'
    fi
  done
} > "$PKG"

echo "wrote $PKG ($(wc -l < "$PKG") lines)"
