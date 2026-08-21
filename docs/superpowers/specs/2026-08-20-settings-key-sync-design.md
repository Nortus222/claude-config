# Sync portable settings at key level

Closes [#15](https://github.com/Nortus222/claude-config/issues/15).

## Goal

`SYNC` in `src/manifest.mjs` manages two instruction files and nothing else.
The comment above it explains why whole settings files are excluded — they mix
portable rules with permissions, UI preferences and machine-specific state —
and that reasoning holds. The consequence is that the portable *parts* have no
path at all, so `nortuscc status` can report agreement while two machines
behave differently.

Sync at key level instead. An entry declares the keys it owns; everything else
in the target file is left exactly as it was.

## Scope

**`~/.claude/settings.json` only.** The issue was triggered by drift in
`~/.claude-mem/settings.json`, but that directory no longer exists on this
machine — claude-mem was removed entirely on 2026-08-20, and PR #14 dropped it
from `integrations.json`. Adding a second destination would mean teaching
`resolveEntry` about paths outside the two agent directories, for a file
nothing installs any more. If a future tool needs it, the mode built here
extends to it without change.

**Owned keys: `effortLevel`, `tui`, `theme`, `worktree`.** Portable scalars
plus the T3 worktree configuration, which is
`{"symlinkDirectories": ["node_modules", ".cache"]}` — no paths, no machine
state, no secrets.

**Left user-owned:** `permissions` (its `additionalDirectories` still points at
a path that does not exist on this machine, and allow-lists grow per machine),
and `enabledPlugins` (already `integrations.json`'s concern).

### `hooks` is deliberately excluded, against the issue's own list

Issue #15 names `hooks` as a candidate owned key. It should not be one.

`claudeHookAdapter.installHook` in `src/integrations/claude-hooks.mjs` already
owns hook registration: it appends to `settings.hooks[event]`, backs the file
up first, and refuses to touch a file it cannot parse. Making `hooks` an owned
sync key would give one field two writers with different models. The concrete
failure is `nortuscc apply` overwriting the registration that
`nortuscc apply --install` created minutes earlier.

The visibility gap the issue was worried about is also already closed. Since
#16, `status` reports every hook registration that `integrations.json` does not
declare, so an unmanaged hook is no longer silent — it is reported by a
mechanism that has exactly one writer.

## The repo file is the allowlist

`claude/settings.keys.json` holds the owned keys **and their values**:

```json
{
  "effortLevel": "high",
  "tui": "fullscreen",
  "theme": "auto",
  "worktree": { "symlinkDirectories": ["node_modules", ".cache"] }
}
```

Its key set *is* the allowlist. Nothing enumerates the local file's keys, so a
key that exists only on the machine is never read, never hashed, and never
written back. That satisfies the issue's constraint — "a synced key list must
be an allowlist, not a denylist, so a new upstream secret field can never be
picked up by default" — by construction rather than by rule.

Defence in depth on top of that: the file is validated before use, and refused
outright if any key *name* looks like a credential or any value *matches* a
credential shape. Those two pattern sets already exist in
`src/integrations/manifest.mjs` as `SECRET_FIELD` and `SECRET_VALUE`. They move
to a new `src/secrets.mjs` that both modules import — the alternative is a
second copy of the same regex list, which is exactly the duplication that lets
one copy fall behind.

## The manifest entry

```js
{ target: 'claude', src: 'claude/settings.keys.json', dest: 'settings.json', mode: 'merge-keys' },
```

`mode` is already dispatched on by `apply`, `capture` and `status`, each of
which currently treats anything other than `copy` as `unknown-mode`. Adding a
second mode is what that branch was built for.

Being in `SYNC` also means `--skills-only` gates it automatically: a machine
that keeps its own instruction files keeps its own settings too, with no extra
wiring.

## Three-way, per key

Baselines are recorded per key, under `claude:settings.json#effortLevel` and
siblings, beside the existing whole-file entries in the same state file.

Each key's hash is taken over a **canonical serialization** — JSON with object
keys sorted recursively — so `worktree`'s object does not read as drift merely
because its keys were written in a different order. Scalars are unaffected.

With a baseline, a repo value and a local value per key, the existing pure
`fileState()` in `src/state.mjs` runs unchanged and yields `clean`,
`repo-ahead`, `local-ahead`, `unmanaged` or `conflict` per key. Nothing new is
invented: `apply --take-repo` and `capture --take-local` resolve a per-key
conflict exactly as they resolve a whole-file one, and the same
`NEEDS_APPLY` / `NEEDS_CAPTURE` / `BLOCKED` sets classify the result.

`apply` writes only keys whose state calls for it, and leaves the rest of the
local document untouched. `capture` reads only owned keys back into the repo
file. Neither ever writes a key the repo file does not name.

## Deletion is not supported in v1

A key is owned only while it appears in the repo file. Delete it there and it
stops being managed; the local value stays where it is.

Syncing deletions needs state this design does not keep — with only a baseline
hash you cannot distinguish "this machine never had the key" from "this machine
deleted it", and guessing wrong either resurrects a key the user removed or
removes one they added. Nothing needs it yet, so it is not built. Baselines for
keys no longer named in the repo file are pruned on the next `apply` or
`capture`, so a removed key leaves no stale record behind.

## Reporting

The config section reports per key, because one row per file is the false-green
this issue exists to close:

```
config
  CLAUDE.md          clean
  AGENTS.md          clean
  settings.json      3 keys      effortLevel repo-ahead, theme local-ahead, tui conflict
```

A file whose owned keys are all clean reports `clean`, exactly as a copied file
does. A local `settings.json` that cannot be parsed reports `blocked` with the
reason, and nothing is written — the same treatment `inspectHook` already gives
that case.

## Failure handling

The local file is the user's, and most of it is none of this tool's business:

- **Unparseable local file:** report `blocked`, write nothing. Never replace a
  file that could not be read; a mid-edit `settings.json` is not ours to
  discard.
- **Absent local file:** every owned key reads as `unmanaged`, so `apply`
  creates the file with the owned keys and nothing else.
- **Missing or unparseable repo file:** `missing-repo`, which the existing
  state machine already reports and which every command already refuses to act
  on.
- **Before the first write,** the local file is preserved to the backup
  directory via `preserveCopy`, matching what `installHook` does and the repo's
  standing rule that nothing destructive runs without a backup first.

Writing serializes with `JSON.stringify(next, null, 2)` and a trailing newline,
the same as `claude-hooks.mjs`. This normalises the whole document's
formatting on first write, which is already this repo's behaviour for that file
and is worth stating rather than discovering.

## capture stays honest

`capture` reads exactly the keys the repo file names, from the local file, and
writes them back to the repo file. It never enumerates local keys, so it cannot
adopt one the repo does not already declare — the same discipline
`integrations.json` keeps, and the reason no `--capture-settings` opt-in is
needed. A test pins it: a local `settings.json` carrying an unowned key and a
credential-shaped value leaves `claude/settings.keys.json` naming only the
declared keys.

## Verification

- `npm test` — 605 tests pass before the change; all must pass after.
- New `test/settings-keys.test.mjs`: canonical serialization (key order, nested
  objects, arrays), per-key state derivation, the secret refusal, prune of
  stale baselines.
- New `test/merge-keys.test.mjs`: apply and capture against a fixture home —
  unowned keys survive, absent local file, unparseable local file writes
  nothing, conflict refused without a force flag, `--take-repo` and
  `--take-local` resolve.
- Extended `test/status.test.mjs`: the per-key config row, the clean case, the
  blocked case.
- Extended `test/capture.test.mjs`: the no-adopt guard.
- Manual: `nortuscc status` on this machine, whose four owned keys are
  `effortLevel: high`, `tui: fullscreen`, `theme: auto` and
  `worktree.symlinkDirectories: ["node_modules", ".cache"]`. After
  `nortuscc capture` seeds the repo file from them, status must report
  `settings.json  clean`, and `permissions` and `enabledPlugins` must be
  byte-identical in the local file.

Test-first per the repo's convention, committing after each task.

## Delivery

Branch `feat/settings-key-sync`, worktree `.claude/worktrees/settings-key-sync`,
PR against `main`. Do not merge.
