# claude-config

Portable agent configuration for **Claude Code and Codex**, kept in agreement
across machines by `nortuscc` — one CLI that reports drift instead of letting it
go silent.

## New machine

```bash
npx github:Nortus222/claude-config setup --dir ~/dev/claude-config
```

Clones the repo, migrates any older machine state, writes the instruction file
for each selected agent, then opens a selector for the integrations and skills
to install. Restart the affected agent afterwards to load the rules.

Without a terminal to choose on, `setup` refuses rather than picking for you:
pass `--yes` to accept the defaults, or `--no-hooks` / `--no-mcp` /
`--no-plugins` / `--no-skills` to decline categories.

If `--dir` already exists it must be a git checkout — an interrupted clone
leaves the directory behind, and syncing from a half-made one would record a
repo path that every later command silently resolves away from. `setup` refuses
it instead: remove the directory and re-run.

## Targets

Every command takes `--target claude|codex|all`. The default is `all`.

```bash
nortuscc status --target codex   # report only what Codex owns
nortuscc apply  --target claude  # write ~/.claude/CLAUDE.md and nothing else
```

An invalid or repeated `--target` exits 2 before anything is read or written.

## Daily use

```bash
nortuscc status              # read-only; changes nothing
nortuscc pull                # git pull, then bring this machine up to date
nortuscc push -m "rules: ..." # share local edits
```

`status` exits non-zero when anything needs attention, so it can gate a shell
prompt or a scheduled check.

## Commands

| Command | Effect |
| --- | --- |
| `setup [--repo URL] [--dir PATH]` | Clone if absent, apply, then install interactively |
| `status` | Read-only report: config, integrations, skills |
| `apply [--install] [--take-repo]` | Repo → machine. `--install` also offers missing integrations and skills |
| `update [--check] [--yes]` | Refresh installed skills, then reconcile agent exposure |
| `capture` | Machine → repo, including regenerating the skills manifest |
| `pull` | `git pull --ff-only`, then apply. Reports new integrations; installs them only with `--install` |
| `push -m MSG` | Capture, then commit and push only what changed |

Conflict resolution: `apply --take-repo` discards the local version;
`capture --take-local` keeps it. Each command only understands the flag that
matches its own direction — `apply --take-local` and `capture --take-repo`
would silently do nothing useful, so both are refused outright with a message
pointing at the command that actually supports them.

`apply --skills` still works as a deprecated alias for installing missing
skills; it prints one warning and points at `--install`.

## What is synced, and what is not

| Path | Target | Mode |
| --- | --- | --- |
| `claude/CLAUDE.md` | Claude | copy |
| `codex/AGENTS.md` | Codex | copy |
| `skills-manifest.txt` | both | one shared skill set |
| `integrations.json` | both | declarations only, never machine state |

**Not synced, and never written by this tool:** Claude's `settings.json`,
Codex's `config.toml`, credentials, sessions, history, caches, and any
machine-specific MCP argument. Those files are yours. The one exception is
narrow and explicit: a hook you select is registered by adding *only* that
entry to a backed-up `settings.json`, leaving every other key untouched.

Earlier versions copied all of `settings.json` and symlinked `claude/bin` and
`claude/hooks`. Those are retired. Existing copies on a machine are left alone —
they simply stop being managed.

Copied files carry a content hash in the state file, recorded at the last sync.
Comparing it against both sides gives four states: `clean`, `repo-ahead`,
`local-ahead`, and `conflict`. A conflict is refused and backed up, never
guessed.

Everything destructive backs up first, under
`<state>/backups/nortuscc-<stamp>/<agent>/`.

## Machine state

State lives outside every agent directory, because nortuscc configures more
than one agent:

- `~/.config/nortuscc/state.json` on Unix-like systems
- `%APPDATA%\nortuscc\state.json` on Windows

It is written atomically (temp file plus rename), so an interrupted write can
never leave a half-parsed file that makes every managed file look unsynced.

On first use, the older `~/.claude/.nortuscc-lock.json` is imported once: the
recorded repo and the `CLAUDE.md` baseline come across as `claude:CLAUDE.md`,
and the retired `settings.json` / `bin` / `hooks` entries are dropped. **The old
lock is never modified or deleted.**

`NORTUSCC_STATE_DIR` overrides the whole state root; `NORTUSCC_CLAUDE_DIR` and
`NORTUSCC_CODEX_DIR` override the agent directories.

## Integrations

`integrations.json` declares the plugins, marketplaces, hooks and MCP servers a
machine should have. It is validated before anything runs, and a manifest with
any error installs nothing at all — unknown types, duplicate ids, unsupported
targets, missing referenced files, and fields that look like secret values are
all refused.

**This file is public.** It may name an environment variable; it may never
carry the value. An MCP server whose `requiresEnv` is unset is reported as
blocked, with the variable named, before any child process starts.

Installation order is hooks, marketplaces, plugins, then MCP servers, so
prerequisites land first. Each item's failure is its own — the rest of the run
continues, and any failed or blocked selected item makes the run exit non-zero.

Native installers own their own layouts and updates: nortuscc runs
`claude plugin install`, `codex mcp add` and friends as argument arrays, and
never edits `config.toml` or a plugin cache itself.

`capture` never reads local integrations back into the repo. Adding one is an
edit to `integrations.json`, deliberately.

## Skills

Skill content is never vendored here. `skills-manifest.txt` records which skills
belong on every machine and which repo each installs from; `nortuscc` drives
`npx skills` to fetch them into the shared store at `~/.agents/skills`, which is
where Codex looks natively and where Claude's installation points.

### Exact sources

By default `update` lists a source repo and offers everything in it that is not
installed yet, which is how a new skill upstream gets noticed. That is the wrong
default for a monorepo: `cursor/plugins` holds 82 skills and this machine wants
one of them. Marking the source **exact** limits it to the skills named under it:

```
[cursor/plugins] exact
unslop
```

An exact source is still checked for updates — the tree SHA of each named skill
is still compared — but the repo is never listed, so the other 81 are neither
offered nor paid for. `exact` is the only marker; a source without it keeps
being scanned, and an unrecognised marker leaves the source unpinned rather than
failing the read. `capture` carries the marker across when it rewrites the file.

There is **one** shared store, and installs name their agents explicitly:

```bash
npx -y skills add owner/repo --skill one two --agent claude-code codex --global --yes
```

So "installed" and "usable by this agent" are separate questions — but not
equally so for both agents, and the difference decides where `status` looks:

| agent | loads from | so a store skill is |
| --- | --- | --- |
| Codex | `~/.agents/skills` — the store itself | already loadable |
| Claude | `~/.claude/skills`, and nowhere else | loadable only once linked there |

The installer says as much per skill, reporting `universal: Codex` alongside
`symlink → Claude Code`. Claude is therefore the only agent a skill can be
installed for and still be unloadable by, and `~/.codex/skills` holds just
Codex's built-in `.system` set. Checking that directory for shared skills
reports every one of them as missing from Codex forever — a `status` that can
never come back clean and an `update` that reinstalls on every run, since
installing again cannot change which directory Codex reads.

`status` reports a skill that exists in the store but is invisible to a selected
agent as **partial**, and names the agent that cannot see it; one no selected
agent can load is **unlinked**. A directory that cannot be read is reported as
unknown rather than as an empty one — treating a failed read as "no skills"
would drive a reinstall of everything.

Skills present on a machine but absent from the manifest are reported and never
removed — that is how a machine carries the shared set plus its own extras. Run
`nortuscc capture` to fold a locally installed skill into the shared set. Skills
with no recorded source are hand-authored and are never written to the manifest,
since nothing could install them.

### `NORTUSCC_AGENTS_DIR` does not sandbox the installer

`NORTUSCC_AGENTS_DIR` redirects only what **nortuscc reads**: the installed
skill list and the sibling `.skill-lock.json`. It does not reach the installer.
`npx skills add ... --global` writes into the real `~/.agents` regardless of
what that variable is set to.

The test suite never spawns a real installer: the acceptance tests put fake
`claude`, `codex` and `npx` executables on `PATH` inside an empty temporary
home, and every other test injects its own runner. Keep it that way.

### Staying current

`nortuscc update` refreshes the skills a machine already has, then re-checks
agent exposure and asks the installer to re-expose anything a selected agent
cannot see. It never creates symlinks by hand.

```bash
nortuscc update --check   # report only; exits non-zero only if a skill is gone or unreachable
nortuscc update           # report, confirm, back up, then update
```

Every skill lands in one of five states: `current`, `outdated`, `gone` (the
folder no longer exists upstream), `unreachable` (the source repo could not be
cloned), and `local` (hand-authored, with no source anything could update from).

Outdated skills are copied into the backup directory before the updater runs,
and the closing report is built by re-reading the lock afterwards, so it
describes what happened rather than what was intended.

Without a TTY and without `--yes`, `update` refuses and exits 2 rather than
blocking a scheduled run on a prompt nothing will answer.

Run without `--check` and it becomes one interactive pass over every pending
decision:

```
  update (8)
  ❯ ◉ ask-matt                  c7d5778 -> c9c83b1   mattpocock/skills

  remove (3)
    ◯ to-issues                 gone upstream        mattpocock/skills

  add (14)
    ◯ wizard                    available            mattpocock/skills

  ↑↓ move · space toggle · a all in group · A all · n none in group · N none
  enter confirm · esc cancel
```

Outdated skills start ticked; removing and adopting are opt-in. `--add
wizard,wait-what` pre-ticks those rows; with `--yes` it acts on them without
asking. There is deliberately no flag that adopts a whole repo. `--prune`
pre-ticks every skill deleted upstream.

Adopting or pruning rewrites `skills-manifest.txt` from what is installed
afterwards. A shrink larger than the number pruned is refused — that means this
machine is missing skills the shared manifest lists, and writing it would drop
them for every other machine.

## Adding a synced path

Add one line to `SYNC` in `src/manifest.mjs`, tagged with the agent it belongs
to. Every command reads that table; nothing else needs to change.

## Development

```bash
npm test    # node:test, no dependencies
```

Windows support was verified on 2026-08-12 with a full `setup` run. State
resolved through `%APPDATA%`, and backup filenames worked without colons.
