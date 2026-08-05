# claude-config

Portable Claude Code configuration, kept in agreement across machines by
`nortuscc` — one CLI that reports drift instead of letting it go silent.

## New machine

```bash
npx github:Nortus222/claude-config setup --dir ~/dev/claude-config
```

Clones the repo, links `bin/` and `hooks/` into `~/.claude`, copies
`settings.json` and `CLAUDE.md`, installs every skill in the manifest, and
prints a status report. Restart Claude Code afterwards to load the rules.

## Daily use

```bash
nortuscc status              # read-only; changes nothing
nortuscc pull                # git pull, then bring this machine up to date
nortuscc push -m "rules: allow gh pr view"   # share local edits
```

`status` exits non-zero when anything needs attention, so it can gate a shell
prompt or a scheduled check.

## Commands

| Command | Effect |
| --- | --- |
| `setup [--repo URL] [--dir PATH]` | Clone if absent, apply, install skills, report |
| `status` | Read-only report: config, plugins, skills |
| `apply [--skills]` | Repo → machine. `--skills` also installs missing skills |
| `capture` | Machine → repo, including regenerating the skills manifest |
| `pull` | `git pull --ff-only`, then apply |
| `push -m MSG` | Capture, then commit and push only what changed |

Conflict resolution on `apply` and `capture`: `--take-repo` or `--take-local`.

## How syncing works

| Path | Mode | Why |
| --- | --- | --- |
| `claude/bin` | link | An agent never writes it, so a link gives live sync |
| `claude/hooks` | link | Same |
| `claude/settings.json` | copy | Claude Code rewrites it in place, which would silently replace a link |
| `claude/CLAUDE.md` | copy | Same |

Copied files carry a content hash in `~/.claude/.nortuscc-lock.json`, recorded at
the last sync. Comparing it against both sides gives four states: `clean`,
`repo-ahead`, `local-ahead`, and `conflict`. A conflict is refused and backed up,
never guessed. Directory links add a fifth: `clobbered`, meaning a real path sits
where a link belongs and syncing had silently stopped.

Everything destructive backs up to `~/.claude/backups/nortuscc-<stamp>/` first.

## Skills

Skill content is never vendored here. `skills-manifest.txt` records which skills
belong on every machine and which repo each installs from; `nortuscc` drives
`npx skills` to fetch them.

Skills present on a machine but absent from the manifest are reported and never
removed — that is how a machine carries the shared set plus its own extras. Run
`nortuscc capture` to fold a locally installed skill into the shared set.

Skills with no recorded source are hand-authored and are never written to the
manifest, since nothing could install them.

## Adding a synced path

Add one line to `SYNC` in `src/manifest.mjs`. Every command reads that table;
nothing else needs to change.

## Development

```bash
npm test    # node:test, no dependencies
```
