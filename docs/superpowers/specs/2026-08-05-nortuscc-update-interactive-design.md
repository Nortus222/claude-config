# `nortuscc update`, interactive — adopt, refresh, and prune in one pass

Builds on `2026-08-05-nortuscc-update-design.md`, which delivered the read-only
check and the outdated-only update. That command answers "what has moved?".
This one answers "what do you want to do about it?".

## Problem

`update` today sees three kinds of drift and can act on only one.

- **outdated** — it updates these, all or nothing, behind a yes/no prompt.
- **gone** — deleted upstream. It reports them and tells you to run
  `npx skills remove` by hand.
- **available** — does not exist yet. Nothing tells you a source repo has
  skills you have not installed. Against the owner's machine there are 14.

So two of the three states are read-only dead ends, and the one actionable
state is all-or-nothing: there is no way to take six of eight updates.

## Shape

One command, one interactive pass. `update` gathers every pending decision,
presents them in a single grouped picker, and executes exactly what was ticked.

```
nortuscc update [--check] [--yes] [--add <names>] [--prune]
```

| Mode | Trigger | Behaviour |
| --- | --- | --- |
| Report | `--check` | Read-only. Refuses `--yes`, `--add`, `--prune` |
| Interactive | a TTY, no `--yes` | Grouped picker; flags pre-tick rows |
| Scripted | `--yes` | No picker. Acts on all outdated, plus `--prune` and `--add <names>` |

Without a TTY and without `--yes`, refuse with exit 2 — the existing rule,
unchanged. A picker nobody can answer is worse than a clean failure.

### Flags seed the picker rather than bypassing it

`--add wizard,wait-what` on a TTY pre-ticks those two rows and still shows you
everything else. The same flag with `--yes` acts on exactly those two without
asking. One mechanism serving both modes, rather than a scripted interface
bolted alongside a human one.

`--add` **requires explicit names**. There is deliberately no flag that adopts
every available skill: a curated skill set is the point, and `mattpocock/skills`
alone offers 14 today, six of them unfinished drafts under `skills/in-progress/`.

`--prune` takes no names. Every `gone` skill is equally dead — deleted upstream,
never updatable — so selecting among them would be typing without added safety.
In interactive mode the picker still lets you deselect individually.

## The picker

```
  update (8)
  ❯ ◉ ask-matt                  c7d5778 -> c9c83b1   mattpocock/skills
    ◉ grilling                  10b0db6 -> fd99bcb   mattpocock/skills

  remove (3)
    ◯ design-an-interface       gone upstream        mattpocock/skills

  add (14)
    ◯ wizard                    available            mattpocock/skills

  ↑↓ move · space toggle · a all in group · A all · n none in group · N none
  enter confirm · esc cancel
```

Defaults: **outdated ticked, gone and available unticked.** Refreshing what you
already have is what the command is for; removing and adopting are choices you
opt into. Group headers are labels, not rows — the cursor skips them.

Enter with nothing ticked is a no-op that exits 0, the same as declining today.

### Keys

| Key | Effect |
| --- | --- |
| `↑` `↓`, `k` `j` | Move, skipping group headers, wrapping at both ends |
| `space` | Toggle the row under the cursor |
| `a` / `n` | Select / deselect every row in the **current group** |
| `A` / `N` | Select / deselect **every row** |
| `enter` | Confirm the current selection |
| `esc`, `ctrl-c`, `q` | Cancel — changes nothing, exits 0 |

Group-scoped select-all is the one that earns its place: the groups *are* the
actions, so `a` means "update all of them" or "adopt all of them" depending on
where the cursor sits. That is a decision made after seeing the list, which is
why the picker offers it while the flags deliberately do not — `--add` still
requires explicit names, so no scripted run can adopt a repo wholesale.

## Modules

The existing command is a single orchestration function. Adding three action
paths through it would make it the place every concern meets. The work splits
along two seams instead: **a generic picker that knows nothing about skills**,
and **pure logic that turns a plan plus a selection into an action set**.

| Module | Responsibility | New? |
| --- | --- | --- |
| `src/select.mjs` | Generic grouped multi-select. Pure `reduce(state, key)` and `render(state)`, plus a thin raw-mode driver. No skill vocabulary at all | new |
| `src/skill-actions.mjs` | Pure. `choices(plan)` → picker rows; `actionsFrom(plan, selectedKeys)` → `{update, remove, add}`; `manifestEdits(actions)` | new |
| `src/git-trees.mjs` | `inspectSource(sourceUrl, paths)` → `{trees, skillPaths}` — both facts from the one clone. Replaces `resolveTrees` | changed |
| `src/skill-updates.mjs` | Adds pure `upstreamSkills(skillPaths)` and `availableSkills({upstreamBySource, installedNames})` | changed |
| `src/skills.mjs` | Adds pure `editManifest(groups, {add, remove})` | changed |
| `src/skills-cli.mjs` | Adds `buildRemoveCommand(names)` / `runRemove`. Adds reuse the existing `installGroups` | changed |
| `src/commands/update.mjs` | Orchestration only: gather, present, execute, report | changed |

`select.mjs` taking rows and returning keys — never skills — is what makes it
testable without a terminal and reusable by any later command. `skill-actions.mjs`
holds every decision about what a selection *means*, so `update.mjs` never
branches on a skill's state; it hands a plan in and gets an action set back.

### Why `resolveTrees` becomes `inspectSource`

Detecting available skills needs the repo's full `SKILL.md` list, which
`git ls-tree -r HEAD --name-only` yields from the blobless clone already being
made. Returning both facts from one call keeps it at one clone per source.
The alternative — a second exported function — would double the clones to save
renaming a function whose only caller is `update.mjs`.

## Deriving an available skill's name

A skill's installed name is its folder name: `skills/engineering/tdd/SKILL.md`
installs as `tdd`. Two edge cases:

- **Nested `SKILL.md`.** A `SKILL.md` beneath another skill's folder is a
  sub-resource, not a skill. Keep the shallowest path on any branch and drop
  its descendants. None of the three configured sources has one today; the rule
  exists so one appearing does not invent phantom skills.
- **Repo-root `SKILL.md`.** Its folder is the repo itself, so the installed
  name comes from the repo rather than the path. This listing has no reliable
  way to derive that, so a root `SKILL.md` is skipped. None of the configured
  sources has one.

Scope is the sources already being cloned — those with at least one installed
skill. A manifest source with nothing installed is not scanned. All three of
the owner's sources have installed skills, so this is not reachable today.

## The manifest

`update` writes `skills-manifest.txt` when it adopts or prunes anything, so the
machine and the manifest never disagree about a change `update` itself made.
This makes `update` the second command that writes to the repo. That is a
deliberate widening: a prune whose manifest entry survives is undone by the very
next `apply --skills`.

**It is a targeted edit, not a regeneration.** `capture` rebuilds the manifest
from `groupsFromLock(readSkillLock())`. That is wrong here for two reasons:

1. The lock outlives the folder. The owner's lock still carries `review` and
   `ubiquitous-language`, whose folders no longer exist on disk. A regeneration
   would silently *add* both to the manifest — the opposite of what a prune was
   asked to do.
2. `capture` refuses to write a manifest smaller than the one it read unless
   given `--allow-shrink`. A prune always shrinks it, so a regeneration would
   be refused outright.

So `editManifest(groups, {add, remove})` adds each adopted name under its source
group, drops each pruned name, and leaves every other line untouched. A source
group that empties is dropped; an adopted skill from a source not yet in the
manifest gets a new group. It is pure, so every case is testable without
touching the repo.

## Execution order

Prune, then update, then add — most destructive first, so a failure partway
through leaves the machine in the state that needed the least undoing.

1. Gather: read the lock and installed names, clone each source once, classify.
2. Present: the report, then the picker (or the flag-derived selection).
3. Back up every folder that prune or update will touch, into
   `~/.claude/backups/nortuscc-<stamp>/skills/`.
4. Execute prune → update → add, reporting each.
5. Edit the manifest if anything was adopted or pruned.
6. Re-read the lock and report what actually changed.

Step 3 covers removals as well as updates. `--prune` is the first thing
`nortuscc` does that deletes a skill outright, so `CLAUDE.md`'s
"nothing destructive without a backup" applies to it most of all.

## Exit codes

| Code | Condition |
| --- | --- |
| 2 | `--check` with `--yes`/`--add`/`--prune`; unknown flag; no TTY and no `--yes` |
| 1 | any executor failed; or, after the run, `gone` or `unknown` skills remain |
| 0 | everything satisfied, or the user selected nothing |

`available` never affects the exit code — a new upstream skill is an
opportunity, not drift, and counting it would leave `update --check`
permanently red against any active repo.

`gone` skills that were *pruned* no longer count toward exit 1: they are dealt
with. Only ones still present after the run do. This is what makes
`update --prune` able to bring a machine to a clean exit 0.

## Tests

`node:test` and `node:assert/strict` only, written before each module.

- `select.mjs` reduce: cursor movement skipping group headers, wrap at both
  ends, space toggling, enter, escape, and ctrl-c. All pure, no TTY.
- `select.mjs` group-scoped select-all: `a` ticks only the current group and
  provably leaves the others untouched; `A` ticks everything; `n` and `N`
  mirror them. A test must place the cursor in a middle group so a bug that
  ignores the cursor and ticks all rows cannot pass as `a`.
- `select.mjs` render: checked and unchecked marks, cursor position, group
  headers, and column alignment with a long label.
- `select.mjs` driver: returns `null` without a TTY, and restores raw mode and
  the cursor even when the caller throws.
- `upstreamSkills`: path → name, nested `SKILL.md` dropped, root `SKILL.md`
  skipped, duplicates across sources collapsed.
- `availableSkills`: excludes installed, includes uninstalled, and is empty
  when a source offers nothing new.
- `skill-actions`: every plan state maps to the right row and default tick;
  a selection maps to the right action set; an empty selection is a no-op.
- `editManifest`: add to an existing group, add creating a group, remove,
  remove emptying a group, and leave unrelated groups byte-identical.
- `buildRemoveCommand` produces the exact argv.
- `update.mjs` orchestration against injected fakes: interactive selection,
  `--yes` scripted, `--check` refusing the action flags, cancelled picker,
  partial executor failure, and the backup-precedes-destruction ordering.

No test spawns `npx skills`, clones, hits the network, writes to the real
`~/.agents`, or enters raw mode.
