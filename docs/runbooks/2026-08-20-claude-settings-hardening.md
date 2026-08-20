# Claude settings hardening — 2026-08-20

A config audit of `~/.claude/settings.json` found dead entries, unbounded write
grants, and one flag that cannot fire. This runbook records what changed, why,
and how to apply the same result on another machine.

`settings.json` is **not** synced by `nortuscc` — see *What is synced, and what
is not* in the README. That is deliberate and unchanged. This file is the
procedure, not the payload.

## Why these specific changes

Evidence came from 256 transcript JSONL files under `~/.claude/projects`
(37,248 events, 26 sessions, 2026-08-07 → 2026-08-20) and the T3 Code event
store at `~/.t3/userdata/state.sqlite`.

The governing fact: **every T3 Code thread runs `runtime_mode: full-access`,
which maps to Claude Code's `bypassPermissions`.** Zero approval events appear
across 51,091 T3 orchestration events. In that mode Claude Code "disables
permission prompts and safety checks so tool calls execute immediately,
including writes to protected paths."

So the allowlist is consulted only when `claude` is launched from a bare
terminal, never from T3. A large allowlist buys nothing in the common path and
still carries its full blast radius in the uncommon one. It shrinks to a
read-only core.

## Changes

### 1. `permissions.allow`: 35 rules → 17

Removed every `Write` and `Edit` rule, everything that mutates state, and every
rule that never matched.

| Removed | Hits in window | Why |
| --- | --- | --- |
| `Write(**/*.md)` | 155 | Unanchored — every markdown file on the machine, not just the repo in play |
| `Edit(**/*.md)` | 606 | Same |
| `Write(**/.git/**)` | 19 | Grants writes to `.git/hooks/*` in **any** repo on disk; a file dropped in `.git/hooks/pre-commit` executes on the next commit |
| `Edit(**/.git/**)` | 39 | Same code-execution path |
| `Write(.git/**)` | 0 | Dead relative-path duplicate |
| `Edit(.git/**)` | 0 | Dead relative-path duplicate |
| `Bash(sed:*)` | 218 | `sed -i` writes files |
| `Bash(mkdir:*)` | 35 | Mutates |
| `Bash(echo:*)` | 159 | Prefix rule does not bound `echo x > file` |
| `Bash(git -C:*)` | 14 | Any git subcommand in any directory, including `push` and `reset --hard` |
| `Bash(git config:*)` | 1 | Writes — can set `core.hooksPath` or a credential helper |
| `Bash(git submodule:*)` | 1 | Mutates |
| `Bash(dotnet build:*)` | 0 | Build scripts are arbitrary code execution |
| `Bash(dotnet test:*)` | 0 | Same |
| `Bash(dart analyze:*)` | 0 | Never matched |
| `Bash(sort:*)` | 0 | Never matched in 5,263 Bash calls |
| `Read(//tmp/**)` | 0 | Double-slash artifact of an old path-normalisation bug; cannot match |
| `Read(//private/tmp/**)` | 0 | Same |

Kept — read-only inspection only:

```
Bash(cd:*)  Bash(ls:*)  Bash(cat:*)  Bash(head:*)  Bash(tail:*)
Bash(wc:*)  Bash(grep:*)  Bash(find:*)
Bash(git status:*)  Bash(git diff:*)  Bash(git show:*)
Bash(git log:*)  Bash(git rev-parse:*)  Bash(git ls-files:*)
Read(/tmp/**)  Read(/private/tmp/**)
Read(~/.claude/plugins/cache/claude-plugins-official/superpowers/**)
```

`Bash(cd:*)` stays because `cd` alone cannot mutate anything. Note that
prefix rules match the **first token**; Claude Code decomposes compound
commands and evaluates each part, so `cd x && rm -rf y` is not auto-approved
by the `cd` rule.

Expect more approval prompts in bare-terminal sessions — `sed`, `mkdir` and
`echo` were carrying real traffic. That is the intended trade, not a
regression. Re-add individually if a specific one becomes noise.

### 2. `permissions.additionalDirectories`: removed

Held `/Users/nortus/Developer/emanageOne`. There is no `/Users/nortus` on this
machine — a leftover from the previous username. It could never match.

### 3. `agentPushNotifEnabled`: removed

Documented as *"When Remote Control is connected, allow Claude to send proactive
push notifications to your phone."* Remote Control has never been connected —
`~/.claude.json` carries `remoteControlUpsellSeenCount: 2` and no connection
state. The flag was inert. Default is `false`, so deleting the key and setting
it to `false` are equivalent; deleting keeps the file honest.

### 4. Unchanged

`enabledPlugins`, `extraKnownMarketplaces`, `effortLevel`, `tui`, `theme`, and
`hooks` were not touched. See the hook note below.

## Replicating on another machine

Back up first. Nothing here is destructive on its own, but the rule stands.

```bash
mkdir -p ~/.claude/backups/settings-audit-$(date -u +%Y-%m-%dT%H-%M-%SZ)
cp -p ~/.claude/settings.json \
  ~/.claude/backups/settings-audit-*/settings.json
```

Apply the same removals without hand-editing, so machine-specific keys survive:

```bash
python3 - <<'EOF'
import json, pathlib

DROP_RULES = {
    "Write(**/*.md)", "Edit(**/*.md)",
    "Write(**/.git/**)", "Edit(**/.git/**)",
    "Write(.git/**)", "Edit(.git/**)",
    "Bash(sed:*)", "Bash(mkdir:*)", "Bash(echo:*)",
    "Bash(git -C:*)", "Bash(git config:*)", "Bash(git submodule:*)",
    "Bash(dotnet build:*)", "Bash(dotnet test:*)", "Bash(dart analyze:*)",
    "Bash(sort:*)",
    "Read(//tmp/**)", "Read(//private/tmp/**)",
}

p = pathlib.Path.home() / ".claude" / "settings.json"
s = json.loads(p.read_text())

perms = s.get("permissions", {})
before = len(perms.get("allow", []))
perms["allow"] = [r for r in perms.get("allow", []) if r not in DROP_RULES]
perms.pop("additionalDirectories", None)
s.pop("agentPushNotifEnabled", None)

p.write_text(json.dumps(s, indent=2) + "\n")
print(f"allow: {before} -> {len(perms['allow'])}")
EOF
```

The script is idempotent — verified byte-identical after a second run. It
preserves the original rule order rather than rewriting it, so the result is
the same 17-rule set in whatever order that machine already had. Order among
`allow` rules does not affect evaluation.

Verify:

```bash
python3 -c "
import json,pathlib
d=json.loads((pathlib.Path.home()/'.claude/settings.json').read_text())
a=d['permissions']['allow']
assert not [r for r in a if r.startswith(('Write','Edit'))], 'write rules remain'
assert 'additionalDirectories' not in d['permissions']
assert 'agentPushNotifEnabled' not in d
print('ok —', len(a), 'allow rules')
"
```

### Machine-specific values — do not copy verbatim

- `permissions.additionalDirectories` on another machine may hold a **valid**
  path. Check before removing; only the `/Users/nortus/...` entry was dead.
- `hooks.SessionStart` embeds an **absolute path** to
  `~/.claude/hooks/context-mode-cache-heal.mjs`. Never hand-copy it between
  machines — it self-installs with the correct path (see below).

## The SessionStart hook — what it actually is

`hooks.SessionStart` runs
`"/Users/ihor/.claude/hooks/context-mode-cache-heal.mjs"`. It was left in place
pending a decision. The facts:

**You did not write it.** The context-mode plugin does. On every boot,
`~/.claude/plugins/cache/context-mode/context-mode/<version>/start.mjs`:

1. Writes the script to `$CLAUDE_CONFIG_DIR/hooks/context-mode-cache-heal.mjs`
   if it is missing *or its content differs* from the version the plugin
   expects.
2. Re-asserts the shebang and exec bit on Unix.
3. Reads `settings.json`, checks whether any `SessionStart` entry contains
   `context-mode-cache-heal`, and **appends one if not**, writing the file back.

That third step is why it reappeared after the 2026-08-12 manual cleanup, and
why `claude/hooks/context-mode-cache-heal.mjs` was deleted from this repo in
the codex-targets change — syncing a file that redeploys itself is pointless.

**What it fixes.** `anthropics/claude-code#46915`: when Claude Code
auto-updates, `plugins/installed_plugins.json` can keep an `installPath`
pointing at a version directory that no longer exists. `CLAUDE_PLUGIN_ROOT`
then resolves to nothing and the plugin's hooks and MCP server silently fail to
load. The script re-points that stale path at the highest version directory
actually present in the cache. Issue #727 added normalisation of stale version
segments baked into an existing `hooks.json`.

**Blast radius.** Narrow by construction. The loop is guarded by
`if (k !== "context-mode@context-mode") continue;` — it will not touch any
other plugin's install state.

**Cost.** 53 fires in the 13-day window, no stdout, no measurable duration.
It is the cheapest entry in the entire hook table; the two expensive hooks
(context-mode's `PreToolUse:Agent` at 187.6s, claude-mem's `Stop` at 235.6s)
both belong to plugins and are unrelated to this one.

### The decision

It is not really independent. Removing the `settings.json` entry does not stick
— context-mode re-adds it on the next session start. The only way to be rid of
it is to disable the context-mode plugin, at which point the hook becomes moot
anyway.

So: **keep context-mode → keep the hook.** There is no third option, and at
zero measured cost there is no reason to want one.

The one thing worth knowing: a third-party plugin writes to your global
`settings.json`. On a fresh machine, install context-mode *before* auditing
`settings.json`, or the audit will flag a hook that is about to reappear.

## Open items

Not addressed in this pass:

- **`permissions.ask`, not `permissions.deny`.** An earlier draft recommended a
  `deny` list for secrets. That was wrong for this setup: `bypassPermissions`
  skips deny rules along with everything else. Explicit **`ask`** rules *do*
  still prompt in bypass mode, as do `rm`/`rmdir` against critical paths. If a
  real guardrail is wanted under T3 full-access, `ask` is the only mechanism
  that survives.
- `attribution.commit` / `attribution.pr` — 129 of 370 commits since 2026-07-01
  carry a `Co-Authored-By: Claude` trailer that `CLAUDE.md` forbids.
- `cleanupPeriodDays` — default 30; the audit window was 13 days.
- `skillOverrides` — 29 skills installed, 14 invoked in the window.
- `~/.claude/agents/awesome-claude-agents` — 30 agent definitions, symlinked
  2025-07-31, invoked zero times against 230 `general-purpose` dispatches.
- 18 project-level `.claude/settings.local.json` files under `~/Developer`
  holding 151 distinct allow rules, several dating to 2025-11.
