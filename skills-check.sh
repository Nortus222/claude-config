#!/usr/bin/env bash
# Report which universal agent skills (from skills-manifest.txt) are missing on
# THIS machine, and flag any broken skill symlinks under ~/.claude/skills.
# Read-only: installs nothing. Re-install missing skills with your own installer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/skills-manifest.txt"
AGENTS_SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
CLAUDE_SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "skills-check: manifest not found at $MANIFEST" >&2
  exit 1
fi

# Parse manifest: skill names (skip blanks/comments) and an optional install command.
expected=()
install_cmd=""
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^[[:space:]]*#[[:space:]]*install-command:[[:space:]]*(.*)$ ]]; then
    cand="${BASH_REMATCH[1]}"
    [[ "$cand" != "<your skills installer command here>" && -n "$cand" ]] && install_cmd="$cand"
    continue
  fi
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  expected+=("$(echo "$line" | tr -d '[:space:]')")
done < "$MANIFEST"

missing=()
for s in "${expected[@]}"; do
  [[ -d "$AGENTS_SKILLS_DIR/$s" ]] || missing+=("$s")
done

# Broken symlinks under ~/.claude/skills (target no longer exists).
broken=()
if [[ -d "$CLAUDE_SKILLS_DIR" ]]; then
  for l in "$CLAUDE_SKILLS_DIR"/*; do
    [[ -L "$l" && ! -e "$l" ]] && broken+=("$(basename "$l")")
  done
fi

echo "== Claude config: skills sync check =="
echo "expected (manifest): ${#expected[@]}    present in $AGENTS_SKILLS_DIR: $(( ${#expected[@]} - ${#missing[@]} ))"
echo

if [[ ${#missing[@]} -eq 0 && ${#broken[@]} -eq 0 ]]; then
  echo "All expected skills are present; no broken Claude skill links."
  exit 0
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing skills (expected by manifest, absent from $AGENTS_SKILLS_DIR):"
  for s in "${missing[@]}"; do echo "  - $s"; done
  echo
  if [[ -n "$install_cmd" ]]; then
    echo "Re-install with:"
    echo "  $install_cmd"
  else
    echo "No install-command set in skills-manifest.txt — add one so this check"
    echo "can tell you how to restore them."
  fi
  echo
fi

if [[ ${#broken[@]} -gt 0 ]]; then
  echo "Broken skill links under $CLAUDE_SKILLS_DIR (target missing):"
  for b in "${broken[@]}"; do echo "  - $b"; done
  echo "Remove with: (cd \"$CLAUDE_SKILLS_DIR\" && rm <name>)  after confirming."
fi
