# `nortuscc update` — refresh installed skills from their sources

## Problem

`nortuscc apply --skills` installs skills the machine is *missing*. Nothing
refreshes a skill that is already installed but has moved on upstream. A skill
installed in June is still the June copy in August, silently, and neither
`status` nor `apply` says a word about it.

The upstream `skills` CLI does have `skills update`, but it offers no dry-run
and no check-only mode: its only prompt is a scope prompt. Running it tells you
what changed after it has already changed it. That is the wrong order for a
tool whose entire premise is reporting drift before acting on it.

## The mechanism

`~/.agents/.skill-lock.json` records a `skillFolderHash` per installed skill.
That value **is the git tree SHA of the skill's folder in its source repo** at
install time, and installed folders are byte-identical copies of the upstream
folder.

Verified against `mattpocock/skills`:

```
$ git rev-parse HEAD:skills/engineering/codebase-design
7347168e8de2de105e2e55f07ecb33d25fd56f44
$ # lock skillFolderHash for codebase-design
7347168e8de2de105e2e55f07ecb33d25fd56f44
$ diff -r skills/engineering/codebase-design ~/.agents/skills/codebase-design
$ # (identical)
```

So detecting an available update needs no content diffing and no file
downloads — only the source repo's current tree SHA for that folder. A
blobless, no-checkout shallow clone supplies it:

```
git clone --depth 1 --filter=blob:none --no-checkout <sourceUrl> <tmp>
git -C <tmp> rev-parse HEAD:<dirname(skillPath)>
```

Measured on `mattpocock/skills`: **0.45s, 136K** on disk, no blobs fetched. A
path that no longer exists upstream exits non-zero with a clear message rather
than returning a wrong answer.

This is preferred over the GitHub trees API because it is host-agnostic, has no
unauthenticated rate limit, has no `truncated: true` edge case on large repos,
and matches the existing pattern of shelling out to `git` that `pull` and
`push` already use.

## Command

```
nortuscc update [--check] [--yes]
```

| Flag | Effect |
| --- | --- |
| `--check` | Report only. Never prompts, never writes. Exit 1 if anything is outdated |
| `--yes` | Skip the confirmation prompt |

`--check` never prompts, so `--yes` has nothing to skip. Passing both is
refused with exit 2, the way `apply` already refuses `--take-repo --take-local`
rather than silently ignoring one of them.

### Scope

Every installed skill carrying a recorded `source` in the skill lock — manifest
skills **and** locally added extras. Those are exactly the skills something is
able to update.

Skills with no recorded source are hand-authored, cannot be updated from
anywhere, and are reported as `local` and skipped. This matches how
`skills.mjs` already treats sourceless entries: never written to the manifest,
because nothing could install them.

`update` is about freshness. Manifest membership stays the concern of `status`
and `capture`.

### Flow

1. Read the skill lock and the installed skill list. Group in-scope skills by
   source.
2. Per source, clone blobless and resolve `HEAD:<dirname(skillPath)>` for each
   of that source's skills.
3. Classify each skill:

   | State | Meaning |
   | --- | --- |
   | `current` | remote tree SHA equals the recorded `skillFolderHash` |
   | `outdated` | they differ — an update is available |
   | `gone` | the path no longer exists in the upstream repo |
   | `unknown` | the source repo could not be reached |
   | `local` | no recorded source; nothing could update it |

4. Print the report. With `--check`, stop here: exit 1 if anything is
   `outdated`, `gone`, or `unknown`, else 0. This mirrors how `status` exits
   non-zero when something needs attention, so `update --check` can gate a
   scheduled job. `local` skills are informational and never affect the exit
   code.
5. Otherwise prompt `Update N skill(s)? [y/N]`. Answering no changes nothing
   and exits 0 — a declined update is not a failure.
6. On yes: copy each outdated `~/.agents/skills/<name>` into
   `~/.claude/backups/nortuscc-<stamp>/skills/<name>`, then run the updater.
7. Re-read the lock and report what actually moved, old SHA → new SHA.

Step 7 is the point of the whole ordering: the final report describes the state
that was observed after the fact, not the state the command intended to
produce.

### Non-TTY

If stdin is not a TTY and `--yes` was not given, refuse with a message naming
`--yes` and exit 2. Never hang waiting on a prompt nothing will answer. A
scheduled `nortuscc update` that blocks forever is worse than one that fails.

### Partial failure

- A source that fails to clone marks **only its own** skills `unknown`. Every
  other source is still checked, and the run exits 1.
- `gone` skills are excluded from the update batch and reported with a pointer
  to re-add them or run `nortuscc capture`. A run whose only finding is `gone`
  still exits 1: a skill whose upstream folder has vanished needs a decision,
  and reporting it as success would bury it.
- If the updater exits non-zero, say so and exit 1. The backup taken in step 6
  is the recovery path, and its location is printed.

## Modules

I/O stays at the edges, following the discipline `skills-cli.mjs` already sets:
one file spawns `npx skills`, and everything else deals in names and hashes.

| Module | Responsibility |
| --- | --- |
| `src/skill-updates.mjs` | Pure. `planUpdates({lock, installedNames, remoteTrees})` → `{current, outdated, gone, unknown, local}` |
| `src/git-trees.mjs` | I/O edge. `resolveTrees(sourceUrl, paths)` → `Map<path, sha \| null>`; owns the temp dir, clone, and cleanup |
| `src/skills-cli.mjs` | Add `buildUpdateCommand(names)` and `runUpdate`, keeping `npx skills` invoked from one place |
| `src/prompt.mjs` | `confirm(question, { input, output, isTTY })` over `node:readline/promises`, streams injectable |
| `src/backup.mjs` | Add `preserveCopy(absPath, relative)` |
| `src/commands/update.mjs` | Orchestration and the report, via `formatRow` / `section` |

`backup.mjs` needs a new function rather than reusing `backupOnce`, which
*moves* its target. Moving a skill folder aside would delete it out from under
the updater; the backup here must be a copy that leaves the original in place.

`planUpdates` takes `remoteTrees` as data, so the entire classification —
including every partial-failure case — is testable without a network, a clone,
or a temp directory.

## Tests

`node:test` and `node:assert/strict` only, written before each module.

- Classification: every state, including a source present in the lock but
  absent from `remoteTrees` (→ `unknown`), and a path resolving to `null`
  (→ `gone`).
- Path derivation: `skillPath` → containing folder, including a `SKILL.md` at
  a repo root.
- Malformed lock entries degrade to "nothing known" rather than throwing, as
  `readSkillLock` and `groupsFromLock` already do.
- `buildUpdateCommand` produces the exact argv.
- `confirm`: accepts `y`/`yes` case-insensitively, treats empty and anything
  else as no, and refuses on a non-TTY.
- `preserveCopy` leaves the source in place.
- `update.mjs` orchestration against injected fakes for clone and spawn:
  outdated-then-confirmed, outdated-then-declined, `--check`, unreachable
  source, and updater failure.

No test spawns `npx skills` or touches `~/.agents`. The README already
documents why — `NORTUSCC_AGENTS_DIR` does not sandbox the installer — and that
constraint is unchanged here.

## Also changed

- `bin/nortuscc.mjs`: add `update` to `VERBS` and to `USAGE`.
- `README.md`: add `update` to the command table and describe the check.

## Decisions taken as defaults

- **No `--skill NAME` filter.** Nothing needs it yet.
- **`status` stays offline.** It is the fast, read-only, no-network report and
  should remain safe to call from a shell prompt. The network check lives only
  in `update`.
- **Scope is all sourced skills, not manifest-only.** A skill installed outside
  the manifest still goes stale.

## Unverified

`skills update <names…> --global --yes` is assumed to update **only** the named
skills and to run without prompting. Its `--help` implies both, but confirming
it requires actually running it. This gets verified against a throwaway skill
before step 6 is wired up.

If it turns out to update everything global, or to prompt anyway, the fallback
is `skills add <source> --skill <names> --global --yes` — the command
`apply --skills` already uses, whose per-skill precision is known good. Only
`buildUpdateCommand` changes; the classification, prompt, backup, and report
are unaffected either way.
