# `settings.json` is synced key by key, and the repo file's key set is the allowlist

`~/.claude/settings.json` mixes portable preferences with permissions, plugin state and
machine-specific paths. `claude/settings.keys.json` names the keys this repo owns and their
values; only those keys are read, compared (three ways, per key) and written. Nothing lists the
local file's keys, so a new secret-bearing field upstream is never picked up by default.

## Considered options

- Whole-file sync: carried permissions and dead per-machine paths between machines.
- A denylist: leaks any new field by default.
- Owning `hooks`: the hook installer already writes it, and two writers would fight.

## Consequences

- `permissions`, `enabledPlugins` and `hooks` stay user- or installer-owned.
- Removing a key from the repo file stops managing it; it is not deleted locally.
- Machine overrides may change an owned key's value but never add a key (ADR 0006).
