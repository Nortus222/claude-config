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

## Plugins & skills

`enabledPlugins` and `extraKnownMarketplaces` live in the synced `settings.json`,
so the *desired* plugin set travels automatically. Launching Claude Code with the
synced settings usually auto-installs enabled plugins from known marketplaces.

To see what's still missing on a machine (and the exact commands to fix it),
run the read-only checker — `bootstrap.sh` also runs it automatically at the end:

```bash
~/.config/claude-config/plugin-check.sh
```

It diffs `settings.json` against this machine's `installed_plugins.json` /
`known_marketplaces.json` and prints `claude plugin marketplace add …` /
`claude plugin install …` commands for anything absent. It installs nothing.

Plugin-provided **skills** come with their plugins, so they're covered by the
above.

### Universal agent skills (`~/.agents/skills/`)

Skills installed into the shared `~/.agents/skills/` store (symlinked into
`~/.claude/skills/`, also used by Amp/Codex/etc.) are **not vendored** here —
they'd go stale against upstream. Instead they're tracked by name in
`skills-manifest.txt`, and `skills-check.sh` reports what's missing on a
machine (and flags broken `~/.claude/skills` symlinks). `bootstrap.sh` runs it
automatically.

```bash
~/.config/claude-config/skills-check.sh
```

On a new machine: re-run your skills installer to populate `~/.agents/skills/`,
then re-run the check. Record that installer command on the `# install-command:`
line in `skills-manifest.txt` so the check can print it for you. When you add or
remove universal skills, update `skills-manifest.txt` and commit.

Personal skills you author directly under `~/.claude/skills/` (not via the
`~/.agents/skills/` store) are still not synced — add `claude/skills/` to the
link map in `bootstrap.sh` if you start keeping your own.

## Caveat: symlink clobbering

If Claude Code ever rewrites `settings.json` via atomic temp-file+rename, the
symlink is replaced by a regular file and live syncing stops silently. To
detect/recover: re-run `bootstrap.sh` — it backs up the now-real file and
re-creates the symlink. Reconcile any rules from the backup into the repo
copy if needed. Re-link offline with:
`CLAUDE_CONFIG_SKIP_FETCH=1 ./bootstrap.sh`
