# status: report what's installed but undeclared

Closes [#16](https://github.com/Nortus222/claude-config/issues/16).

## Goal

`nortuscc status` answers "is everything I declared present?" but never "is
anything present that I did not declare?" Extras are invisible, so a machine
accumulates untracked agents, plugins and skills for months while status
reports agreement.

Add an inventory pass that walks each managed category on disk and reports what
is present but undeclared. Report only — removal is not this command's job, and
`status` stays read-only by construction.

## Why now

The evidence in the issue is historical: an undeclared `~/.claude/agents/`
symlink exposing 24 third-party agents survived ~13 months, and seven extra
plugins survived an audit-to-audit gap. `nortuscc status` reported "in
agreement" throughout both.

PR #14 made the gap current rather than historical. It removed context-mode and
claude-mem from `integrations.json`, and says so in the file's own comment:

> Removing them here stops new machines being offered them — it does not
> uninstall them from a machine that already has them.

This machine was then cleaned by hand, and verified on 2026-08-20:
`installed_plugins.json` holds `superpowers@claude-plugins-official` alone,
`known_marketplaces.json` holds `claude-plugins-official` alone, and
`~/.claude-mem` is gone entirely.

That does not weaken the case, it sharpens it. The cleanup was manual and
nothing recorded it, so `nortuscc status` said "everything is in agreement"
before it and says the same after — it cannot confirm the runbook's uninstall
step ran, or report which *other* machines still carry the plugins. Verifying a
removal is the same capability as noticing an addition, and neither exists
today.

## What "declared" means, per category

| Category | Observed from | Declared by |
| --- | --- | --- |
| Claude plugins | `~/.claude/plugins/installed_plugins.json`, user scope | `integrations.json` `type: 'plugin'`, target `claude` |
| Claude marketplaces | `~/.claude/plugins/known_marketplaces.json` | `type: 'marketplace'` `name`, plus the built-in exemption below |
| Codex plugins, marketplaces | `readCodexState()` — already returns full sets | the same declarations, target `codex` |
| Hook registrations | `settings.json` → `hooks[event][].hooks[].command` | `type: 'hook'` → `node <hooksDir>/<basename(file)>` |
| Agents | `~/.claude/agents/` entries | nothing — see below |
| Claude skill links | `~/.claude/skills/` entries | a link resolving to `~/.agents/skills/<same name>` |

Four rules in that table are not obvious enough to leave implicit.

**`claude-plugins-official` is exempt, because Claude Code adds it, not the
user.** From [the plugin docs](https://code.claude.com/docs/en/discover-plugins):

> Claude Code adds the official Anthropic marketplace (`claude-plugins-official`)
> automatically the first time you start it interactively.

Local state agrees: it is sourced from `anthropics/claude-plugins-official`,
fetched over GCS rather than git, and auto-updates in the background — the docs
confirm auto-update is on by default for official marketplaces. Reporting it as
the user's drift would report Claude Code's own behaviour back at them. The
exemption is a named constant with this reasoning attached, not a silent filter.
`claude-community` and the `claude-code-plugins` demo marketplace are *not*
exempt: the docs say both are added by hand.

**An undeclared marketplace that a declared plugin needs is a defect, not an
extra.** The tempting rule — treat the `@marketplace` suffix of a declared
plugin as an implicit marketplace declaration — would have hidden a real bug.
`runIntegrations` installs only *declared* marketplaces, so `foo@bar` with no
`bar` declaration can never be installed by `apply --install` on a fresh
machine.

It is reported in this section under a `manifest` category — the repo is wrong,
not the machine — and counts under `--strict`. It deliberately does not go
through `validateIntegrations`, which is fail-closed: an error there yields *no*
integrations at all, and a missing marketplace declaration must not stop the
other declarations from installing.

**The built-in exemption applies to this check too**, and the repo's current
state is the reason. `integrations.json` declares exactly one integration,
`superpowers@claude-plugins-official`, and declares no marketplace at all. A
defect check that did not consult the built-in set would flag the repo's only
declaration as broken on its first run. A built-in marketplace counts as
declared for both checks, from one shared constant, so the two can never
disagree about what "built-in" means.

One real edge this leaves open, stated rather than hidden: on a machine that has
never started Claude Code interactively, the official marketplace has not been
auto-added yet, and the docs say the install then fails with `Marketplace
"claude-plugins-official" not found`. `integrations.json` already takes that
position in its own note — "Ships from the official marketplace Claude Code
already knows" — so this design keeps it rather than reopening it.

**Only user-scope plugin installs count.** `installed_plugins.json` records a
scope per install. A `project`-scoped plugin belongs to a repository and a
`managed` one to an administrator; neither is the user's to declare, so neither
is drift against a machine-wide manifest. Concretely: in the v2 shape each
plugin maps to an array of install records carrying `scope` and `version`, so
the probe keeps the record whose scope is `user`. A value that is not an array
is the older shape, which records neither field — count it as installed at user
scope with an unknown version rather than dropping it.

**Every entry under `~/.claude/agents/` is undeclared, by construction.** This
repo has no agents concept at all — nothing reads that directory today. Until
one exists, presence is the only signal there is, which is exactly the signal
that was missing for 13 months. Intentional agents go in `allow`. An entry is
any file, directory or symlink whose name is not dot-prefixed, matching how
`exposedSkillNames` already treats an agent's own bookkeeping. A symlink reports
its target in the note, since that is what made the 24-agent case legible.

The skills row is deliberately narrow. `reconcile()` already reports store-level
`extra` and `local`, and `status` already prints them; duplicating that would be
noise. The new check covers only the hole `reconcile` cannot see: an entry in
`~/.claude/skills` that did not come from the shared store — a hand-placed
directory, or a link pointing somewhere else. Claude loads it either way.

**Resolve the link; never compare its text.** `~/.claude/skills` on this machine
holds 29 links written two different ways: 21 relative
(`../../.agents/skills/<name>`) and 8 absolute
(`/Users/ihor/.agents/skills/<name>`). Both forms resolve to the same store.
A draft of this check compared the raw link text against the relative form and
reported all 8 absolute ones as undeclared — a false positive rate of 28% on a
machine that is, in fact, clean. The check resolves each entry to a real path
and compares that against the resolved store directory. Nothing else is
acceptable: a category whose first run cries wolf is a category the user learns
to skip.

## Versions: report, never pin

The issue proposes pinning plugin versions in `integrations.json` and reporting
`installed, unpinned`. Research says pinning cannot work:

- `claude plugin install` has no version option. Its flags are `--config`,
  `--scope` and `--yes`. Nothing can honour a pin.
- Versions come from the marketplace catalog, which pins each plugin to a commit
  SHA and auto-updates in the background for official marketplaces.

A `version` field would therefore be unenforceable *and* would manufacture
permanent drift that no command could resolve — a worse failure than the silence
it replaces, because it trains the user to ignore the section.

The issue's actual complaint is that two machines on different versions both
report agreement, which is a *comparison* problem. So: `nortuscc status
--versions` expands the integrations section to one row per declared plugin with
its installed version, suppressing the `all declared / installed` collapse that
otherwise hides them. Informational, no declaration mechanism, no effect on the
exit code. Diff two machines' output and the answer is there.

```
integrations
  superpowers       installed     6.3.0
```

A plugin whose version cannot be read — the older `installed_plugins.json`
shape, or a Codex plugin, whose CLI reports no version — says `unknown` rather
than blank, so an absent version is never mistaken for a matching one.

## Modules

Split along the line `state.mjs` and `copy.mjs` already draw — pure derivation
apart from every read, so the part most worth getting right stays trivially
testable.

- **`src/inventory.mjs`** — pure, no I/O, no `node:fs` import.
  `declaredIds(integrations)` returns per-category Sets;
  `undeclared({ observed, declared, allow })` returns rows;
  `manifestDefects(integrations)` returns the undeclared-marketplace rows.
- **`src/inventory-probe.mjs`** — every read: the agents directory, the Claude
  skills directory, the plugin JSON files, the settings hooks. A failed read
  becomes an `errors[]` entry and never an exception, the same contract
  `readLinkExposure` already uses, so one unreadable directory cannot take a
  whole status run down.
- **`src/integrations/claude-plugins.mjs`** — export the currently-private
  `installedPlugins` and `knownMarketplaces`, so there stays exactly one reader
  of those two files.
- **`src/integrations/manifest.mjs`** — validate the new optional top-level
  `allow`.
- **`src/commands/status.mjs`** — the new section, `--strict`, `--versions`.
- **`bin/nortuscc.mjs`** — usage text for both flags.

The section honours `--target` like everything else in `status`: agents, skill
links and hooks are Claude-side categories and are not walked under
`--target codex`.

## Report

```
undeclared
  agents        awesome-claude-agents   -> ~/Developer/claude-agents/... (24 agents)
  plugins       claude-mem@thedotmack   installed, no longer declared
  marketplaces  thedotmack
  hooks         SessionStart            node ~/.claude/hooks/unknown.mjs
  skills        wayfinder               not a link into ~/.agents/skills
  manifest      foo@bar                 marketplace 'bar' is not declared

  6 finding(s). Declare them in integrations.json, or list them under "allow"
  to accept them. --strict makes this exit non-zero.
```

One count covers every row, including the `manifest` one, so the summary and
`--strict` can never disagree about what the section found.

Clean, printed rather than omitted, for the reason the file's existing comment
already gives — silence reads as "clean", which is the one thing it is not:

```
undeclared
  all categories  declared
```

A category that could not be read says so, and is never rendered as empty:

```
  agents          unknown       could not read ~/.claude/agents: EACCES
```

## Exit behaviour

The default exit code does not change: the issue asks that scheduled runs keep
passing, and adopting a whole machine's history of extras should not break a
login hook on day one.

But `everything is in agreement` is **suppressed** whenever anything is
undeclared. Printing it is exactly the false-green this issue exists to close,
and suppressing it costs nothing in automation.

`--strict` makes undeclared items and unreadable categories return 1, for CI or
a login hook that wants drift to be actionable.

## The allow list

```json
"allow": {
  "plugins": ["voltagent-lang@inline"],
  "marketplaces": [],
  "agents": ["awesome-claude-agents"],
  "skills": [],
  "hooks": []
}
```

Ids only, matching the file's existing "may name environment variables, never
their values" convention. Validation is fail-closed like the rest of
`validateIntegrations`: `allow` must be an object, its keys must be known
categories, and each value must be an array of non-empty strings. An unknown
category key is a manifest error, because the alternative is a typo that
silently allows nothing.

**Known limitation.** The issue calls these exceptions "intentional and
per-machine", but `integrations.json` is committed, so an entry accepts the
extra on *every* machine. Taking the issue's placement as specified; if a second
machine ever needs to differ, a machine-local override in nortuscc's own state
is the follow-up. Not built now, because nothing needs it yet.

## capture stays honest

`capture` gains nothing here. It still never reads plugin, hook or MCP state,
and discovering an extra must not write it into a manifest — that would convert
drift into policy behind the user's back. Locked in by a test asserting a
`capture` run with undeclared items present leaves `integrations.json`
byte-identical.

## Failure handling

Every probe degrades rather than throws. A missing directory is "nothing
present", which is honest — a machine that never placed an agent has none. A
directory that exists and cannot be read is an `errors[]` entry rendered as
`unknown`, never as empty, because reading a failed read as "nothing here" is
how a category goes silently unchecked. Malformed plugin JSON is already handled
this way by `claude-plugins.mjs` and keeps that behaviour.

## Verification

- `npm test` — 551 tests pass before the change; all must pass after.
- New: `test/inventory.test.mjs` (pure derivation: declared vs undeclared, the
  built-in exemption, allow filtering, manifest defects).
- New: `test/inventory-probe.test.mjs` against a fixture `HOME`: an agents
  symlink, a non-store skill directory, v1 and v2 `installed_plugins.json`
  shapes, non-user scopes, corrupt JSON, missing directories, an unreadable
  directory.
- Extended: `test/status.test.mjs` — the section renders, the clean case, the
  unknown case, `--strict` exits 1, agreement is suppressed, `--versions`
  expands.
- Extended: `test/integrations-manifest.test.mjs` — `allow` validation.
- Extended: `test/capture.test.mjs` — the no-adopt guard.
- Manual: run `nortuscc status` on this machine. Verified state as of
  2026-08-20 means every category is clean, so the section must print
  `all categories  declared` and nothing else. Specifically: one user-scope
  plugin (declared), one marketplace (`claude-plugins-official`, built-in), an
  empty `~/.claude/agents`, no `hooks` key in `settings.json`, and 29 skill
  links that all resolve into `~/.agents/skills`. Any row at all on this machine
  is a false positive, and the 21-relative/8-absolute link split makes that a
  live risk rather than a theoretical one.

Test-first per the repo's convention, committing after each task.

## Delivery

Branch `feat/status-undeclared-inventory`, worktree
`.claude/worktrees/status-undeclared-inventory`, PR against `main`. Do not
merge.
