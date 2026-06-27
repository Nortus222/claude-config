# Claude Config Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the Claude Code permission allowlist (and the files it depends on) across machines via a private Git repo, symlinked into `~/.claude/`.

**Architecture:** A private repo holds a portable copy of `settings.json` plus `bin/` and `hooks/`. An idempotent `bootstrap.sh` symlinks each into `~/.claude/`, backing up anything pre-existing. Because `~/.claude/settings.json` becomes the repo file, edits (including new allow rules) write straight into the repo — `commit && push`, then `pull` on other machines.

**Tech Stack:** Bash, Git, macOS (Darwin). No external dependencies.

## Global Constraints

- Target OS: macOS (all machines). Bash + coreutils available.
- Machines may have **different usernames** — no hardcoded `/Users/nortus/...`; use `$HOME`/`~` only.
- Repo canonical clone location: `$HOME/.config/claude-config` (overridable via `$CLAUDE_CONFIG_DIR`).
- Managed targets: `~/.claude/settings.json` (file), `~/.claude/bin` (dir), `~/.claude/hooks` (dir).
- `settings.json` must contain **no secrets** (private repo, but keep tokens out — none exist today).
- **User git policy:** the implementer does NOT run `git add`/`commit`/`push`. Repo creation and the first push are the user's. `bootstrap.sh` runs git only when the user executes it on a machine.

---

### Task 1: Scaffold the repo and import portable copies

**Files:**
- Create dir: `~/.config/claude-config/claude/`
- Create: `~/.config/claude-config/claude/settings.json` (copied from `~/.claude/settings.json`)
- Create: `~/.config/claude-config/claude/bin/sp`, `~/.config/claude-config/claude/bin/sdd-pkg.sh` (copied from `~/.claude/bin/`)
- Create: `~/.config/claude-config/claude/hooks/context-mode-cache-heal.mjs` (copied from `~/.claude/hooks/`)
- Create: `~/.config/claude-config/.gitignore`

**Interfaces:**
- Produces: the `claude/` subtree that `bootstrap.sh` (Task 3) symlinks from, at repo-relative paths `claude/settings.json`, `claude/bin`, `claude/hooks`.

- [ ] **Step 1: Copy the current portable files into the repo, preserving executable bits**

```bash
SRC="$HOME/.claude"
DST="$HOME/.config/claude-config/claude"
mkdir -p "$DST/bin" "$DST/hooks"
cp -p "$SRC/settings.json" "$DST/settings.json"
cp -p "$SRC/bin/sp" "$SRC/bin/sdd-pkg.sh" "$DST/bin/"
cp -p "$SRC/hooks/context-mode-cache-heal.mjs" "$DST/hooks/"
```

- [ ] **Step 2: Add a minimal .gitignore**

Create `~/.config/claude-config/.gitignore`:

```gitignore
.DS_Store
```

- [ ] **Step 3: Verify executable bits survived the copy**

Run: `ls -l ~/.config/claude-config/claude/bin`
Expected: both `sp` and `sdd-pkg.sh` show `-rwxr-xr-x` (the `x` bits present).

---

### Task 2: Make `settings.json` portable

The imported `settings.json` has two machine-specific absolute paths. Fix them so it works under any username.

**Files:**
- Modify: `~/.config/claude-config/claude/settings.json`

**Interfaces:**
- Produces: a `settings.json` whose only home-relative references use `$HOME` or `~`.

- [ ] **Step 1: Remove the version+username-pinned superpowers allow rule**

Delete this line from `permissions.allow` (it is redundant — the `~/.claude/bin/sp` rules already cover superpowers scripts version-agnostically):

```json
      "Bash(/Users/nortus/.claude/plugins/cache/claude-plugins-official/superpowers/6.0.3/skills/:*)",
```

- [ ] **Step 2: Rewrite the SessionStart hook command to use `$HOME`**

Change the hook command string from:

```json
"command": "\"/Users/nortus/.claude/hooks/context-mode-cache-heal.mjs\""
```

to:

```json
"command": "\"$HOME/.claude/hooks/context-mode-cache-heal.mjs\""
```

(`$HOME` expands when the hook runs in the shell; the inner quotes handle any spaces.)

- [ ] **Step 3: Verify no hardcoded user path remains and JSON is valid**

Run:

```bash
F=~/.config/claude-config/claude/settings.json
grep -n "/Users/nortus" "$F" || echo "OK: no hardcoded user path"
python3 -c "import json; json.load(open('$F')); print('OK: valid JSON')"
```

Expected: `OK: no hardcoded user path` and `OK: valid JSON`.

---

### Task 3: Write `bootstrap.sh`

**Files:**
- Create: `~/.config/claude-config/bootstrap.sh`

**Interfaces:**
- Consumes: the `claude/` subtree from Task 1/2.
- Produces: symlinks `~/.claude/{settings.json,bin,hooks}` → `$CLONE_DIR/claude/...`. Honors env vars `CLAUDE_CONFIG_DIR` (clone location), `CLAUDE_CONFIG_REPO_URL` (override remote), `CLAUDE_CONFIG_SKIP_FETCH=1` (skip clone/pull — used by Task 4 tests and for offline re-linking).

- [ ] **Step 1: Write the script**

Create `~/.config/claude-config/bootstrap.sh`:

```bash
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
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x ~/.config/claude-config/bootstrap.sh`

- [ ] **Step 3: Shellcheck / syntax check**

Run: `bash -n ~/.config/claude-config/bootstrap.sh && echo "OK: syntax"`
Expected: `OK: syntax`.

---

### Task 4: Verify `bootstrap.sh` in a sandbox HOME

Prove linking, backup, and idempotency without touching the real `~/.claude` or the network.

**Files:**
- No repo files created. Uses a throwaway temp dir.

- [ ] **Step 1: Set up a sandbox and run bootstrap once**

```bash
SB="$(mktemp -d)"
REPO="$SB/repo"
mkdir -p "$REPO/claude/bin" "$REPO/claude/hooks"
echo '{"permissions":{"allow":["Bash(ls:*)"]}}' > "$REPO/claude/settings.json"
echo 'echo sp' > "$REPO/claude/bin/sp"; chmod +x "$REPO/claude/bin/sp"
echo 'export {}' > "$REPO/claude/hooks/h.mjs"
# Pre-existing real settings.json that must get backed up:
mkdir -p "$SB/home/.claude"
echo '{"old":true}' > "$SB/home/.claude/settings.json"

HOME="$SB/home" CLAUDE_CONFIG_DIR="$REPO" CLAUDE_CONFIG_SKIP_FETCH=1 \
  bash ~/.config/claude-config/bootstrap.sh
```

- [ ] **Step 2: Assert symlinks point into the repo and the old file was backed up**

```bash
test "$(readlink "$SB/home/.claude/settings.json")" = "$REPO/claude/settings.json" && echo "OK: settings linked"
test -L "$SB/home/.claude/bin" && echo "OK: bin linked"
test -L "$SB/home/.claude/hooks" && echo "OK: hooks linked"
ls "$SB/home/.claude/backups/"*/settings.json >/dev/null && echo "OK: old settings backed up"
```

Expected: all four `OK:` lines.

- [ ] **Step 3: Assert idempotency (re-run is a no-op, no new backup)**

```bash
OUT="$(HOME="$SB/home" CLAUDE_CONFIG_DIR="$REPO" CLAUDE_CONFIG_SKIP_FETCH=1 \
  bash ~/.config/claude-config/bootstrap.sh)"
echo "$OUT" | grep -q "ok   $SB/home/.claude/settings.json" && echo "OK: idempotent (left existing link)"
test "$(ls -1d "$SB/home/.claude/backups/"* | wc -l)" -eq 1 && echo "OK: no second backup created"
```

Expected: `OK: idempotent ...` and `OK: no second backup created`.

- [ ] **Step 4: Clean up the sandbox**

Run: `rm -rf "$SB"`

---

### Task 5: Write `README.md`

**Files:**
- Create: `~/.config/claude-config/README.md`

- [ ] **Step 1: Write the README**

Create `~/.config/claude-config/README.md`:

```markdown
# claude-config

Portable Claude Code configuration synced across machines. Holds a shared
`settings.json` (permission allowlist, plugins, hooks, prefs) plus the
`bin/` helper scripts and `hooks/` it references. `bootstrap.sh` symlinks
them into `~/.claude/` so edits sync via Git.

## First-time setup (source machine)

1. Create a **private** repo named `claude-config` on GitHub.
2. Set the remote and push (this repo is already populated):
   ```bash
   cd ~/.config/claude-config
   git init && git add . && git commit -m "init: claude config sync"
   git branch -M main
   git remote add origin git@github.com:OWNER/claude-config.git
   git push -u origin main
   ```
3. Edit `bootstrap.sh` and set `OWNER` in `REPO_URL` (or always run with
   `CLAUDE_CONFIG_REPO_URL=...`).
4. Link this machine: `./bootstrap.sh`
5. Restart Claude Code (or open `/permissions`) to load the rules.

## New machine

```bash
git clone git@github.com:OWNER/claude-config.git ~/.config/claude-config
~/.config/claude-config/bootstrap.sh
```

## Daily use

- `~/.claude/settings.json` is a symlink to this repo, so any allow rule you
  add (including Claude's "always allow") writes here. To share it:
  ```bash
  cd ~/.config/claude-config && git add -A && git commit -m "rules: ..." && git push
  ```
- On other machines: `git -C ~/.config/claude-config pull` (or re-run `bootstrap.sh`).

## Caveat: symlink clobbering

If Claude Code ever rewrites `settings.json` via atomic temp-file+rename, the
symlink is replaced by a regular file and live syncing stops silently. To
detect/recover: re-run `bootstrap.sh` — it backs up the now-real file and
re-creates the symlink. Reconcile any rules from the backup into the repo
copy if needed. Re-link offline with:
`CLAUDE_CONFIG_SKIP_FETCH=1 ./bootstrap.sh`
```

- [ ] **Step 2: Verify it renders as valid markdown (no broken code fences)**

Run: `grep -c '```' ~/.config/claude-config/README.md`
Expected: an even number (all code fences closed).

---

### Task 6 (USER): Create the private repo and switch this machine over

> These are git/remote actions reserved to the user per git policy. Listed for completeness; the implementer does not run them.

- [ ] Create a private GitHub repo `claude-config`.
- [ ] From `~/.config/claude-config`: `git init && git add . && git commit && git remote add origin ... && git push -u origin main`.
- [ ] Set `OWNER` in `bootstrap.sh` `REPO_URL`.
- [ ] Run `~/.config/claude-config/bootstrap.sh` on this machine to replace the real `~/.claude/{settings.json,bin,hooks}` with symlinks (originals are backed up under `~/.claude/backups/`).
- [ ] Restart Claude Code; confirm allow rules still apply (e.g. an `ls` runs without prompt).

---

## Self-Review

- **Spec coverage:** Portable settings.json (Task 2) ✓; bin/ + hooks/ bundled (Task 1) ✓; symlink bootstrap with backup + idempotency (Tasks 3–4) ✓; new-machine flow + clobber caveat (Task 5) ✓; user-owned git actions isolated (Task 6) ✓.
- **Placeholders:** none — bootstrap.sh, README, and settings edits are shown in full. `OWNER` is an explicit, intended fill-in, documented in Task 5/6.
- **Type/path consistency:** repo-relative sources (`claude/settings.json`, `claude/bin`, `claude/hooks`) match between Task 1 (creation), Task 3 (link map), and Task 4 (sandbox mirror). Env var names (`CLAUDE_CONFIG_DIR`, `CLAUDE_CONFIG_REPO_URL`, `CLAUDE_CONFIG_SKIP_FETCH`) are used identically in Task 3 and Task 4.
```
