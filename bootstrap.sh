#!/usr/bin/env bash
# Bootstrap Claude Code config: symlink shared files from this repo into ~/.claude.
# Idempotent and safe to re-run. Pre-existing real files are backed up first.
set -euo pipefail

REPO_URL="${CLAUDE_CONFIG_REPO_URL:-git@github.com:OWNER/claude-config.git}"  # <-- set OWNER
CLONE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.config/claude-config}"
CLAUDE_DIR="$HOME/.claude"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$CLAUDE_DIR/backups/config-sync-$STAMP"

# 1. Obtain or refresh the repo (skippable for offline re-link / tests).
if [[ "${CLAUDE_CONFIG_SKIP_FETCH:-0}" == "1" ]]; then
  echo "==> Skipping fetch (CLAUDE_CONFIG_SKIP_FETCH=1)"
elif [[ -d "$CLONE_DIR/.git" ]]; then
  echo "==> Updating $CLONE_DIR"
  git -C "$CLONE_DIR" pull --ff-only
else
  echo "==> Cloning into $CLONE_DIR"
  mkdir -p "$(dirname "$CLONE_DIR")"
  git clone "$REPO_URL" "$CLONE_DIR"
fi

mkdir -p "$CLAUDE_DIR"

# 2. Link map: <repo-relative source>:<absolute target under ~/.claude>
links=(
  "claude/settings.json:$CLAUDE_DIR/settings.json"
  "claude/bin:$CLAUDE_DIR/bin"
  "claude/hooks:$CLAUDE_DIR/hooks"
)

for entry in "${links[@]}"; do
  src="$CLONE_DIR/${entry%%:*}"
  dest="${entry#*:}"

  if [[ ! -e "$src" ]]; then
    echo "!! missing source, skipping: $src" >&2
    continue
  fi

  # Already the correct symlink? leave it.
  if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
    echo "ok   $dest"
    continue
  fi

  # Back up anything in the way (real file/dir, or a wrong symlink).
  if [[ -e "$dest" || -L "$dest" ]]; then
    mkdir -p "$BACKUP_DIR"
    echo "bak  $dest -> $BACKUP_DIR/"
    mv "$dest" "$BACKUP_DIR/"
  fi

  ln -sfn "$src" "$dest"
  echo "link $dest -> $src"
done

echo
echo "Done. Restart Claude Code (or open /permissions) to load the synced rules."
if [[ -d "$BACKUP_DIR" ]]; then
  echo "Backups saved in: $BACKUP_DIR"
fi

# Report any enabled plugins/marketplaces not yet installed on this machine.
if [[ -x "$CLONE_DIR/plugin-check.sh" ]]; then
  echo
  "$CLONE_DIR/plugin-check.sh" || true
fi

# Report any universal agent skills (from skills-manifest.txt) missing here.
if [[ -x "$CLONE_DIR/skills-check.sh" ]]; then
  echo
  "$CLONE_DIR/skills-check.sh" || true
fi
