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

### Using it for skills alone

This repo's `claude/CLAUDE.md` and `codex/AGENTS.md` are one person's rules. If
you are here for the skill set and have instruction files of your own, say so
once:

```bash
npx github:Nortus222/claude-config setup --dir ~/dev/claude-config --skills-only
```

The choice is recorded in machine state, so every later command honours it with
no flag to remember — `apply` never writes your `CLAUDE.md`, and `capture` never
publishes it into the repo. `status` reports the section as `skills-only`
rather than staying silent, because silence would read as "clean" when nothing
has looked at those files at all.

Integrations and skills stay managed. Decline those per install with
`--no-hooks` / `--no-mcp` / `--no-plugins` / `--no-skills`, or point the repo at
your own fork and edit `skills-manifest.txt`.

`--with-config` syncs config for a single run without changing the setting;
`--no-skills-only` records it off for good.

## Targets

Every command takes `--target claude|codex|all`. The default is `all`.

```bash
nortuscc status --target codex   # report only what Codex owns
nortuscc apply  --target claude  # write ~/.claude/CLAUDE.md and nothing else
```

An invalid or repeated `--target` exits 2 before anything is read or written.

`--target` picks *which* agent, never *whether*. To manage no agent configuration
at all — this repo's skills, your own rules — see
[Using it for skills alone](#using-it-for-skills-alone):

```bash
nortuscc apply --skills-only     # record it; instruction and provider files are left alone
nortuscc apply --with-config     # sync them for this run only
nortuscc apply --no-skills-only  # record it off again
```

## Daily use

```bash
nortuscc status              # reports; only ever writes if you accept its update prompt
nortuscc pull                # git pull, then bring this machine up to date
nortuscc push -m "rules: ..." # share local edits
```

`status` exits non-zero when something declared needs attention. Undeclared
items — things installed but never named in `integrations.json` — are
reported but do not affect the exit code unless `--strict` is passed, so it
can still gate a shell prompt or a scheduled check without failing the day
this ships.

## Commands

| Command | Effect |
| --- | --- |
| `setup [--repo URL] [--dir PATH] [--skills-only]` | Clone if absent, apply, then install interactively |
| `status [--strict] [--versions]` | Report: cli, config, integrations, skills, undeclared. `--strict` exits non-zero on undeclared items; `--versions` shows each plugin's installed version. Offers to update nortuscc when behind |
| `apply [--install] [--take-repo] [--skills-only]` | Repo → machine. `--install` also offers missing integrations and skills |
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
| `codex/openrouter-glm/config.toml` | Codex via OpenRouter | copy to `~/.codex-openrouter/config.toml` |
| `skills-manifest.txt` | both | one shared skill set |
| `integrations.json` | both | declarations only, never machine state |

**Not synced, and never written by this tool:** credentials, Codex sessions,
history, caches, machine-local provider state, and any
machine-specific MCP argument. Those files are yours. Two exceptions are
narrow and explicit: a hook you select is registered by adding *only* that
entry to a backed-up `settings.json`, leaving every other key untouched; and
the keys named below are kept in sync the same way.

The committed OpenRouter config is the narrow exception for Codex configuration:
`nortuscc` copies it to a separate `~/.codex-openrouter` home when configuration
management is enabled. It contains the GLM model slug and the name of
`OPENROUTER_API_KEY`, never its value. On each machine, add that variable as a
sensitive value to a T3 Code Codex provider named `Codex · GLM Flash` whose
`CODEX_HOME path` is `~/.codex-openrouter`, then restart T3 Code.

### Key-level settings sync

`claude/settings.keys.json` names the keys the repo owns, and their values;
every other key in `~/.claude/settings.json` is left exactly as found.
Today that is `effortLevel`, `tui`, `theme`, and `worktree`.

`permissions` and `enabledPlugins` stay user-owned — the latter because
`integrations.json` already covers plugins. `hooks` is deliberately not
owned either: `integrations.json` already registers hooks, a second writer
here would let `apply` undo what `apply --install` just registered, and
`status` already reports undeclared hooks on its own.

The repo file's key set *is* the allowlist — nothing anywhere enumerates a
machine's own keys — and, like `integrations.json`, it is refused outright
if a key name or value looks like a credential.

Drift is reported and resolved per key exactly as it is for a whole file:
`nortuscc apply --take-repo` discards the local value, `nortuscc capture
--take-local` keeps it. Removing a key from the repo file stops it being
managed — deletions are not synced, and each machine keeps the value it
last had.

A local `settings.json` that fails to parse is reported apart from a
conflict, since neither `--take-repo` nor `--take-local` can fix invalid
JSON: `apply` and `capture` both refuse and leave it for you to fix by
hand.

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

It records where the repo lives, a baseline hash per synced file, and
`skillsOnly` — the [skills-only](#using-it-for-skills-alone) setting. That last
one is read strictly: anything but a literal `true` means this machine manages
its instruction files, which is what every state record written before the flag
existed was describing.

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

`integrations.json` may also carry a top-level `allow` object, keyed by the
same categories `status`'s undeclared section reports (`agents`, `plugins`,
`marketplaces`, `hooks`, `skills`). Each value is a list of ids to accept as
known extras rather than flag as undeclared — ids only, never a value, the
same convention the rest of this file keeps (for `hooks`, that id is the full
registered command, e.g. `node /Users/you/.claude/hooks/thing.mjs`, not a
short name — it's the same string `status` prints in an undeclared hook row's
note column, so it's copyable from there). An unrecognised category key is
refused like any other manifest error. **Because this file is committed, an
`allow` entry accepts that extra on every machine that checks out the repo,
not just this one.**

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

`update` and `pull` update different things, and neither implies the other:

| | updates | leaves alone |
| --- | --- | --- |
| `nortuscc update` | the installed **skills**, from their own source repos | this repo, and so the CLI |
| `nortuscc pull` | this **repo** (`git pull --ff-only`), then applies it | installed skills |

`update` clones each *skill* source into a temp directory to compare tree SHAs;
it never touches the claude-config checkout. So a machine running the CLI from a
checkout — `--dir`, or an `npm link` — is still on the code it had before, and
`nortuscc pull` is what moves it forward. Running the CLI through
`npx github:Nortus222/claude-config` instead means there is no checkout to
update; each invocation resolves the repo itself.

Order matters when a release changes both: `pull` first, then `update`, so the
skill pass runs on the newer code and against the newer `skills-manifest.txt`.

You do not have to remember to check. `status` compares this checkout against
the remote on every run and offers the update:

```
cli
  nortuscc         behind       origin/main is at 7f098e9

Update nortuscc now? [y/N]
```

Accepting runs `pull` and then stops, telling you to re-run — every later line
of a report would come from the modules the process already loaded, and a report
you cannot trust is worse than one you have to run twice. Declining exits
non-zero and names `nortuscc pull`, because the prompt is gone by then.

The check asks `git ls-remote`, never `fetch`: a fetch writes refs into `.git`,
and `status` must not change the repo it reports on. It asks "do we already have
the remote's tip?" rather than counting commits — a checkout that is *ahead* by
unpushed commits has the tip and is correctly left alone.

Nothing is asked where nothing can answer: with no terminal, `status` reports
and exits non-zero rather than blocking a scheduled run on a prompt. An
unreachable remote is reported as `unknown` and does **not** fail the run —
being offline is ordinary and offers nothing to act on, unlike an exposure read
that failed against local files. Running via `npx github:…` has no checkout to
compare, so the section stays silent.

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
