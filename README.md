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

If `--dir` already exists it must be a git checkout — an interrupted clone
leaves the directory behind, and syncing from a half-made one would record a
repo path that every later command silently resolves away from. `setup` refuses
it instead: remove the directory and re-run.

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
| `update [--check] [--yes]` | Refresh installed skills from their sources, after confirmation |
| `capture` | Machine → repo, including regenerating the skills manifest |
| `pull` | `git pull --ff-only`, then apply |
| `push -m MSG` | Capture, then commit and push only what changed |

Conflict resolution: `apply --take-repo` discards the local version;
`capture --take-local` keeps it. Each command only understands the flag that
matches its own direction — `apply --take-local` and `capture --take-repo`
would silently do nothing useful, so both are refused outright with a message
pointing at the command that actually supports them.

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
never guessed. Directory links add two more: `clobbered`, meaning a real path sits
where a link belongs and syncing had silently stopped, and `broken-link`, meaning
the link is perfectly formed but the repo path it points into is gone — a deleted
worktree or a moved clone. Both are reported, exit non-zero, and are repaired by
`apply`.

Everything destructive backs up to `~/.claude/backups/nortuscc-<stamp>/` first.

Directory links (`bin/`, `hooks/`) are created as NTFS junctions on Windows,
which need no Developer Mode or admin. That path is not exercised by the test
suite and has not been run on a real Windows machine — treat Windows support
as unverified until someone runs `setup` there and reports back.

## Skills

Skill content is never vendored here. `skills-manifest.txt` records which skills
belong on every machine and which repo each installs from; `nortuscc` drives
`npx skills` to fetch them.

Skills present on a machine but absent from the manifest are reported and never
removed — that is how a machine carries the shared set plus its own extras. Run
`nortuscc capture` to fold a locally installed skill into the shared set.

Skills with no recorded source are hand-authored and are never written to the
manifest, since nothing could install them.

### `NORTUSCC_AGENTS_DIR` does not sandbox the installer

`NORTUSCC_AGENTS_DIR` redirects only what **nortuscc reads**: the installed
skill list and the sibling `.skill-lock.json`. It does not reach the installer.
`npx skills add ... --global` writes into the real `~/.agents` regardless of
what that variable is set to, so `nortuscc apply --skills` — and therefore
`nortuscc setup` — is **not** isolated by it.

Anything that spawns the installer touches the machine's live skills. The test
suite never does: its fixtures keep `skills.missing` empty, so the `--skills`
branch takes the "satisfied" path and nothing is spawned. Keep it that way, and
do not treat `NORTUSCC_AGENTS_DIR` as a sandbox for a real install.

### Staying current

`apply --skills` installs skills the machine is *missing*. `nortuscc update`
refreshes the ones it already has.

The skill lock records a `skillFolderHash` per skill, which is the git tree SHA
of that skill's folder in its source repo. Comparing it against the repo's
current tree SHA answers "is there an update?" without downloading a single
file: one blobless, no-checkout shallow clone per source repo, then
`git rev-parse HEAD:<folder>`.

```bash
nortuscc update --check   # report only; exits non-zero if anything is stale
nortuscc update           # report, confirm, back up, then update
```

Every skill lands in one of five states: `current`, `outdated`, `gone` (the
folder no longer exists upstream), `unreachable` (the source repo could not be
cloned — only that source's skills are affected), and `local` (hand-authored,
with no source anything could update from).

Outdated skills are copied to `~/.claude/backups/nortuscc-<stamp>/skills/`
before the updater runs, and the closing report is built by re-reading the lock
afterwards, so it describes what happened rather than what was intended.

Without a TTY and without `--yes`, `update` refuses and exits 2 rather than
blocking a scheduled run on a prompt nothing will answer.

## Adding a synced path

Add one line to `SYNC` in `src/manifest.mjs`. Every command reads that table;
nothing else needs to change.

## Development

```bash
npm test    # node:test, no dependencies
```
