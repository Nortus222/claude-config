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
