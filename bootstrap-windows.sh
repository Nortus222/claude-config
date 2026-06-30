#!/usr/bin/env bash
# Windows (Git Bash) bootstrap — COPY-BASED sync of settings.json only.
#
# Unlike bootstrap.sh (macOS symlinks), Windows uses copies: symlinks there need
# Developer Mode/admin and Claude Code may rewrite settings.json in place. This
# script copies the repo's settings.json into the Windows-side ~/.claude and can
# copy local edits back (--capture).
#
#   ./bootstrap-windows.sh            # apply: repo  -> ~/.claude/settings.json
#   ./bootstrap-windows.sh --capture  # capture: ~/.claude/settings.json -> repo
#   ./bootstrap-windows.sh --skip-fetch
#
# Run it from inside the cloned repo, in Git Bash.
set -euo pipefail

MODE="apply"
SKIP_FETCH=0
for arg in "$@"; do
  case "$arg" in
    --capture)    MODE="capture" ;;
    --skip-fetch) SKIP_FETCH=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# The repo is wherever this script lives.
CLONE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the Windows user profile's .claude (where native Claude Code reads),
# which may differ from Git Bash's $HOME. Override with CLAUDE_DIR=... if needed.
if command -v cygpath >/dev/null 2>&1 && [[ -n "${USERPROFILE:-}" ]]; then
  HOME_DIR="$(cygpath -u "$USERPROFILE")"
else
  HOME_DIR="$HOME"
fi
CLAUDE_DIR="${CLAUDE_DIR:-$HOME_DIR/.claude}"

SRC="$CLONE_DIR/claude/settings.json"
DEST="$CLAUDE_DIR/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Refresh the repo (apply mode only; capture is about local -> repo).
if [[ "$SKIP_FETCH" == "0" && "$MODE" == "apply" && -d "$CLONE_DIR/.git" ]]; then
  echo "==> Updating $CLONE_DIR"
  git -C "$CLONE_DIR" pull --ff-only || echo "!! pull failed; using local repo copy" >&2
fi

if [[ "$MODE" == "capture" ]]; then
  if [[ ! -f "$DEST" ]]; then
    echo "capture: no settings.json at $DEST" >&2; exit 1
  fi
  cp "$DEST" "$SRC"
  echo "captured $DEST -> $SRC"
  echo "Note: this copies the ENTIRE settings.json (not just the allowlist) back"
  echo "to the repo. Review with 'git -C \"$CLONE_DIR\" diff', then commit & push."
  exit 0
fi

# apply
if [[ ! -f "$SRC" ]]; then
  echo "apply: repo settings.json missing at $SRC" >&2; exit 1
fi
mkdir -p "$CLAUDE_DIR"

if [[ -e "$DEST" ]]; then
  BACKUP_DIR="$CLAUDE_DIR/backups/win-config-$STAMP"
  mkdir -p "$BACKUP_DIR"
  cp "$DEST" "$BACKUP_DIR/"
  echo "bak  $DEST -> $BACKUP_DIR/"
fi

cp "$SRC" "$DEST"
echo "copy $SRC -> $DEST"
echo
echo "Done. Target resolved to: $DEST"
echo "If that is NOT where your Windows Claude Code reads settings, re-run with"
echo "CLAUDE_DIR=/c/Users/<you>/.claude ./bootstrap-windows.sh"
echo
echo "Plugins: launch Claude Code to auto-install enabled plugins, or run the"
echo "checker (needs python3): ./plugin-check.sh"

# Best-effort plugin gap report (non-fatal; skips itself if python3 absent).
if [[ -x "$CLONE_DIR/plugin-check.sh" ]]; then
  echo
  CLAUDE_DIR="$CLAUDE_DIR" "$CLONE_DIR/plugin-check.sh" || true
fi
