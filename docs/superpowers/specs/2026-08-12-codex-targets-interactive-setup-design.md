# Codex Targets and Interactive Setup

**Date:** 2026-08-12
**Status:** Approved design, pending implementation plan

## Problem

`nortuscc` currently treats Claude Code as its only configuration target. Its
paths, state file, reports, and restart guidance assume `~/.claude`; Codex has
no managed `AGENTS.md`; and skill installation does not explicitly select the
agents that should receive each skill.

First-time setup also has gaps. It installs skills without letting the user
review them, reports Claude plugin commands instead of installing selected
plugins, activates hooks only because an entire `settings.json` is copied, and
has no declarative MCP setup. Copying all of `settings.json` also mixes portable
configuration with permissions, UI preferences, and machine-specific state.

## Goals

1. Support Claude Code, Codex, or both through a consistent `--target` option.
2. Manage only Claude `CLAUDE.md` and helper commands, Codex `AGENTS.md`, and
   shared skills as portable agent configuration.
3. Stop tracking and syncing Claude's complete `settings.json` without deleting
   any machine's local settings.
4. Give users interactive control over first-time installation of hooks,
   plugins, MCP servers, and skills.
5. Use supported native installers and preserve their ownership of installation
   layouts and updates.
6. Make a fresh-machine setup complete, resumable, safe, and testable without
   touching the developer's live agent configuration.

## Non-goals

- Syncing Codex `config.toml`, credentials, sessions, history, caches, or other
  runtime state.
- Capturing arbitrary local hooks, plugins, or MCP servers into the repository.
- Storing secrets or machine-specific MCP arguments in the repository.
- Reimplementing the `skills` CLI or native Claude/Codex installers.
- Automatically upgrading integrations whose lifecycle is owned by their
  native installer.
- Deleting the old Claude settings file or old nortuscc lock during migration.

## Command interface

All relevant commands accept:

```text
--target claude|codex|all
```

The default is `all`. An invalid or repeated contradictory target exits 2
before any writes.

- `setup` clones or locates the repository, migrates state, presents the setup
  selector, applies selected configuration, installs selected integrations and
  skills, and finishes with status.
- `status` is read-only and reports configuration, integrations, and skill
  exposure for the selected target.
- `apply` reconciles portable configuration only by default. `--install` opens
  the selector for missing integrations and skills. `--skills` remains as a
  deprecated compatibility alias for installing missing skills.
- `capture` captures only selected target instruction files and the shared
  skill manifest. It never infers integration declarations from local machine
  state.
- `pull` performs a fast-forward-only pull followed by target-filtered apply.
  It reports newly available integrations but installs them only with
  `--install`.
- `push` captures selected targets and commits only paths that capture wrote.
- `update` updates shared skills through `npx skills` and then reconciles their
  exposure to the selected agents. Integration upgrades remain native-installer
  concerns.

Interactive installation uses these automation controls:

- With a TTY, setup and `apply --install` show a selector and require review.
- Without a TTY, they exit 2 unless `--yes` is supplied.
- `--yes` accepts every default-selected item without opening the selector.
- `--no-hooks`, `--no-mcp`, `--no-plugins`, and `--no-skills` disable categories
  in interactive and non-interactive runs.
- `status` never installs, prompts, or writes.

## Repository model

```text
claude/
  CLAUDE.md
  bin/
  hooks/
codex/
  AGENTS.md
integrations.json
skills-manifest.txt
```

`claude/settings.json` is removed from the repository and sync manifest. The
CLI leaves `~/.claude/settings.json` untouched except for narrow, explicitly
selected hook registration described below.

Sync manifest entries carry a target:

```js
[
  { target: 'claude', src: 'claude/bin', dest: 'bin', mode: 'link' },
  { target: 'claude', src: 'claude/CLAUDE.md', dest: 'CLAUDE.md', mode: 'copy' },
  { target: 'codex', src: 'codex/AGENTS.md', dest: 'AGENTS.md', mode: 'copy' },
]
```

Resolution uses the target to select `~/.claude` or `~/.codex`. Commands filter
the common manifest instead of maintaining separate command implementations.

## Neutral machine state

State moves from `~/.claude/.nortuscc-lock.json` to a platform-neutral location:
`~/.config/nortuscc/state.json` on Unix-like systems and
`%APPDATA%\nortuscc\state.json` on Windows. A test override redirects the entire
state root.

On first use, nortuscc imports recognized repository and file baselines from the
old Claude lock when neutral state does not yet exist. It writes the neutral
state atomically and leaves the old lock unchanged. Stale metadata for removed
`settings.json` management is not imported. State keys include the target so
Claude `CLAUDE.md` and Codex `AGENTS.md` cannot collide.

Backups also live beneath the neutral nortuscc state root and are grouped by
target. Existing Claude backups are not moved or deleted.

## Integration manifest

`integrations.json` is the explicit, non-secret source of truth for installable
integrations. Each entry has:

- a stable ID and user-facing label;
- target (`claude` or `codex`);
- type (`hook`, `plugin`, `marketplace`, or `mcp`);
- whether it is selected by default;
- type-specific source and installation metadata;
- required environment-variable names and prerequisite guidance, when needed.

Manifest validation happens before any installation. It rejects unknown types,
duplicate IDs, unsupported targets, missing referenced files, and fields that
appear to contain secret values. Environment-variable names may be committed;
their values may not.

The first manifest represents the integrations currently implied by
`claude/settings.json`: the context-mode cache-repair hook, the official
Superpowers plugin, context-mode, and claude-mem. Codex MCP entries are added
explicitly rather than captured from local `config.toml`.

## Native installation adapters

Each integration type has a small adapter with the same conceptual operations:
validate its declaration, inspect whether it is installed, describe its planned
actions, install it, and format a redacted result. Command modules orchestrate
these adapters without knowing platform-specific storage details.

### Claude hooks

Selected hook files are installed into a nortuscc-owned location under
`~/.claude/hooks`. The adapter then reads local `settings.json`, adds only the
declared hook registration if absent, and writes a backup before changing the
file. It preserves unrelated permissions, preferences, plugins, hook events,
and hook commands. It never replaces the whole settings document or removes an
unselected pre-existing hook.

### Claude plugins

Marketplaces are installed before plugins that depend on them. The adapter uses
the supported `claude plugin marketplace add` and `claude plugin install`
commands. Inspection reads Claude's installed-plugin and marketplace state.
Independent plugin failures do not prevent other selected integrations from
running.

### Codex MCP servers

The adapter uses the supported Codex MCP command interface rather than editing
`config.toml` directly. It passes declared non-secret arguments and references
credentials through environment variables. Planned commands and reports redact
sensitive values. A missing required environment variable marks that item
blocked with its prerequisite guidance; it does not prompt nortuscc to persist
the secret.

## Skills

There is one shared `skills-manifest.txt`. This matches Codex's native user
skill discovery at `$HOME/.agents/skills` and avoids artificial per-agent copies
of skill content.

`npx skills` remains the native installation layer. Nortuscc groups selected
skills by source and invokes it with explicit target agents:

- Claude target: `--agent claude-code`
- Codex target: `--agent codex`
- All targets: both agent names

Install commands also pass `--global`, the exact selected `--skill` names, and
`--yes` because nortuscc has already obtained confirmation. Nortuscc never
manually copies skill content or invents an installation layout.

Status distinguishes canonical presence from agent exposure. A skill that
exists in the shared store but is unavailable to a selected agent is reported
as partially installed. Update continues through `npx skills update`; nortuscc
then reconciles agent exposure using the installer. Capture regenerates the
single manifest from canonical installed skills with recorded sources, retaining
the existing shrink guard.

## Interactive setup

The selector contains four sections:

1. target-specific configuration;
2. Claude hooks and plugins;
3. Codex MCP servers;
4. shared skills.

Default-enabled items start selected. Already satisfied items are visibly
marked and are not reinstalled. Users can toggle individual rows or whole
groups. The review step reports how many configuration items, integrations, and
skills will change and lets the user inspect the commands and files involved
before confirming.

Installation order is configuration, hooks, marketplaces, plugins, MCP servers,
then skills. This gives prerequisites a deterministic order while allowing
independent items to continue after a failure. The final report groups every
selected item as installed, already satisfied, skipped, blocked, or failed. Any
blocked or failed selected item produces a nonzero exit.

Re-running setup is idempotent and selects only incomplete work by default. It
can therefore resume a partial first run safely.

## Error handling and safety

- Invalid arguments or manifests exit 2 before writes or child processes.
- Configuration conflicts retain the existing refuse-and-back-up behavior and
  target-specific resolution flags.
- Every local file replacement or hook-registration edit is backed up first.
- Installer failures are recorded per item; unrelated selected items continue.
- Child-process launch errors name the unavailable native command.
- Command previews and logs redact declared secret-bearing arguments and
  environment values.
- Capture never reads local MCP configuration or converts local integrations
  into repository declarations.
- Removing settings management never deletes or resets local Claude settings.

## Testing

Pure tests cover target parsing and filtering, integration-manifest validation,
selection defaults, command construction, redaction, and state reconciliation.

Adapter contract tests use fixture executables and isolated homes. No automated
test may invoke a real installer, access the network, or touch live Claude,
Codex, `.agents`, or nortuscc state directories.

Integration tests cover:

- an actually empty home directory;
- partial prior installation and idempotent reruns;
- Claude-only, Codex-only, and all-target setup;
- interactive selection and group toggles;
- non-TTY refusal, `--yes`, and every category opt-out;
- partially exposed shared skills;
- per-item installer and prerequisite failures;
- old-lock migration without modifying the old lock;
- hook registration that preserves unrelated settings and existing hooks;
- capture exclusion of local integrations and secrets;
- manifest rejection before any child process starts.

CLI help and README examples document target selection, interactive setup,
automation flags, native skill exposure, state migration, and the fact that
Claude settings and Codex configuration are otherwise user-owned.

## Implementation sequence

1. Add target parsing, target-aware resolution, neutral state, and migration.
2. Remove tracked Claude settings and add Codex `AGENTS.md` synchronization.
3. Add and validate the integration manifest and native adapters.
4. Build the shared interactive installation selector and automation controls.
5. Make skill installation and reporting explicitly agent-aware.
6. Update command composition, documentation, and fresh-machine verification.
