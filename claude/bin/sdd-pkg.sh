#!/usr/bin/env bash
# SDD working-tree review-package generator (NO commits — user git policy).
#
# Usage: sdd-pkg.sh <output-file> [--title "Title"] <file1> [file2 ...]
#
# Writes a review package for the listed files into <output-file>:
#   - git status --porcelain (scoped to the files)
#   - git diff HEAD          (tracked changes)
#   - full contents of any UNTRACKED new files among the list
#     (these never appear in `git diff HEAD` since nothing is staged)
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

# Identify untracked files among the arguments.
untracked=()
for f in "$@"; do
  if [[ -n "$(git ls-files --others --exclude-standard -- "$f")" ]]; then
    untracked+=("$f")
  fi
done

{
  echo "# $TITLE"
  echo
  echo "NOTE: No commits (user git policy). This is a WORKING-TREE review."
  echo "Tracked changes are shown via 'git diff HEAD'. Untracked NEW files are dumped in full below."
  echo
  echo "## git status --porcelain (review files)"
  git status --porcelain -- "$@"
  echo
  echo "## git diff HEAD (tracked changes)"
  git diff HEAD -- "$@"
  if [[ ${#untracked[@]} -gt 0 ]]; then
    echo
    echo "## Untracked NEW files (full contents)"
    for f in "${untracked[@]}"; do
      echo
      echo "### $f"
      echo '```'
      cat -- "$f"
      echo '```'
    done
  fi
} > "$PKG"

echo "wrote $PKG ($(wc -l < "$PKG") lines)"
