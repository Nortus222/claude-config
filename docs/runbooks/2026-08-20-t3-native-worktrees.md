# Adopting T3 Code's native worktrees — 2026-08-20

Feature work moves from agent-created git worktrees to the ones T3 Code creates
per thread. This records why, what changed, what still needs configuring by
hand, and **how to reverse the whole thing**.

Reversal is section [Backing this out](#backing-this-out). Nothing here is
one-way.

## Why

The audit found 14 worktrees across 79 repositories under three conventions
(`.claude/worktrees/` ×12, `.worktrees/` ×2, T3 native ×0), of which **6 were
orphaned** — fully merged, clean, and never cleaned up. Two dated to May and
June. Nothing in the old workflow ever removed a worktree.

The deciding requirement, though, was not tidiness. It was: *open the worktree
to launch an app and run things in it.*

### Why not Claude Code's `--worktree`

Rejected on evidence. `claude --worktree <name>` creates
`.claude/worktrees/<name>` on branch `worktree-<name>` with no way to override
the branch name — the docs send you to `git worktree add -b` for that.

Its automatic cleanup is an **interactive-exit** behaviour, and T3 launches
Claude non-interactively:

```
claude --output-format stream-json --input-format stream-json --effort high …
```

Per the worktree docs, non-interactive runs *"have no exit prompt, so Claude
doesn't clean up their worktrees, and Claude Code leaves the lock it took on
each one at creation in place."* Observed directly during cleanup: removing
`change_log_generator/.claude/worktrees/openai-luna-migration` was refused with
`cannot remove a locked working tree, lock reason: claude session … (pid 92779)`
— a live session holding exactly that lock.

So `--worktree` would cost the branch naming *and* not deliver the cleanup it
was traded for. Strictly worse than hand-rolling.

### Why T3's wins

| Capability | Hand-rolled | T3 native |
| --- | --- | --- |
| Terminal opens in the worktree | no — opens at project root, `cd` every time | **yes** — resolves `terminalLaunchLocation.worktreePath` |
| App launches on creation | no | **yes** — startup scripts, "Run automatically on worktree creation" |
| Preview opens automatically | no | **yes** — per-script preview URL |
| Cleanup | none — 6 orphans in 3 months | **yes** — thread deletion offers "Delete the worktree too?" |
| Branch name | full control | generated from the opening message, renameable |

T3's create endpoint is documented as *"Create a new git worktree for the
current project and run any configured startup scripts."* That is the
requirement, built in.

## What this costs

Stated plainly, because these are the reasons you might reverse:

- **The endpoint is `/experimental/worktree`.** Experimental, and it may change
  under you.
- **Branch names become model-generated**, via T3's `generateBranchName` using
  the `textGenerationModelSelection` model, rather than guaranteed `docs/`,
  `feat/`, `fix/` prefixes. `worktree-<thread-id>` is the fallback when
  generation is unavailable — if you start seeing UUID branches, that is what
  happened.
- **Worktrees live outside the repository** under T3's `worktreesDir`, not in
  `<repo>/.claude/worktrees/`. Different mental model; `git worktree list` in
  the main checkout still finds them.
- **`worktree.symlinkDirectories` does not apply to them.** See below.

## What you must configure by hand

**This is the step that makes it worth doing, and it is not done yet.** All 11
T3 projects currently have `scripts_json = []`. Without them a T3 worktree is a
bare checkout with no dependencies, and the adoption gains only the
terminal-cwd fix.

Per project, in T3's project settings, add the script below and enable
**"Run automatically on worktree creation"**.

### Ignore the preview URL

T3 scripts can open a URL in the in-app preview when they run. **No project here
needs it.** None of them is a web app: `telemetry-triage`'s `triage` script is
`bun run src/cli.ts`, `artpub` is a CLI, and the rest are Ansible, Flutter,
.NET, and an Xcode target. No Next, no Vite, no dev server anywhere. The value
of scripts here is dependency install, nothing more.

### On-create scripts

Ordered by how much a broken worktree costs. Commands are what the transcripts
show actually being run, over the 2026-08-07 → 08-20 window.

| Project | Script | Why |
| --- | --- | --- |
| `telemetry-triage` | `bun install` | Heaviest project in the window — 203 `bun run typecheck`, 129 `bun test`. Dead without `node_modules`. |
| `artpub` | `pnpm install` | pnpm workspace over `packages/`. 56 test, 53 typecheck, 12 build. |
| `pocketmanage` | `flutter pub get` | `pubspec.yaml` + `ios/` + `android/`. Non-functional until this runs. |
| `pocketmanage_partner` | `flutter pub get` | Same. |
| `pocketmanage_installers` | `flutter pub get` | Same. |
| `shared-mic` | `python -m pip install -e 'harness[dev]'` | 100 `python -m pytest`. `harness/pyproject.toml` declares `cryptography>=42` and a `dev` extra with `pytest>=8`. |
| `EMWS` | `dotnet restore` | `EMWS.sln`, five projects. |
| `change_log_generator` | `dotnet restore` | 19 `dotnet run --project`. |
| `homeserver` | `ansible-galaxy install -r requirements.yml` | An Ansible repo — `ansible.cfg`, `roles/`, `run.yml`. The `docker` calls in the window were inspecting test containers, not local services. |

### Deliberately no script

| Project | Why |
| --- | --- |
| `claude-config` | Zero dependencies by design, mandated by its own `CLAUDE.md`. `npm test` runs against stdlib `node:test`. An install step would be a no-op. |
| `agent-skills` | 48 `python3 -m unittest` runs, all standard library. Nothing to install. |
| `misc` | Not a project — it is the parent directory of `claude-config`, `shared-mic`, `artpub` and `agent-skills`. Worth removing from T3's project list rather than scripting. |

### Optional manual scripts

Separate from on-create, and purely for your own one-click use — the agent
shells out directly and will not use them. Worth having for the commands run
most often: `bun run typecheck` and `bun test` in `telemetry-triage`,
`pnpm test` and `pnpm typecheck` in `artpub`. Do **not** mark these
run-on-creation; they would slow every worktree.

### Two caveats

- **`symlinkDirectories: ["node_modules"]` may be wrong for `artpub`.** pnpm's
  `node_modules` is a symlink farm into `.pnpm` with workspace-relative links,
  so symlinking it wholesale can resolve to the wrong package roots. Fine for
  bun and npm. If `artpub` misbehaves inside a *Claude-created* worktree, this
  is the first suspect. It does not affect T3-created worktrees, which is why
  the install script is the real mechanism.
- **Flutter iOS builds may also need CocoaPods.** `flutter pub get` covers Dart
  dependencies only. If a fresh worktree fails on iOS, extend the script to
  `flutter pub get && (cd ios && pod install)`.

## Claude Code's own worktrees still exist

Two things are unaffected and should stay:

- **Subagent isolation.** Dispatching with `isolation: worktree` still gives a
  subagent a temporary Claude-created worktree, and Claude Code's periodic sweep
  removes them. This already works — the `agent-*` worktrees that appear in the
  transcripts are gone from disk without anyone cleaning them up.
- **`worktree.symlinkDirectories`.** Added to `settings.json`:

  ```json
  { "worktree": { "symlinkDirectories": ["node_modules", ".cache"] } }
  ```

  *"Directories to symlink from main repository to worktrees to avoid disk
  bloat. Must be explicitly configured — no directories are symlinked by
  default."* It applies to `--worktree`, `EnterWorktree` and agent isolation —
  **not** to T3-created worktrees, which have no equivalent setting and rely on
  startup scripts instead. It is here for the subagent case.

## What changed in `claude/CLAUDE.md`

The *Git and worktrees* section previously ordered the agent to create a
worktree at `.claude/worktrees/<slug>`. Under T3 that produces a second worktree
beside the one the thread already has. It now says the opposite:

- T3 creates the worktree; the agent works in the one it is given
- detect it with `git rev-parse --git-common-dir` — anything but `.git` means
  you are already in a linked worktree
- ask before creating one, and only as a fallback outside T3
- rename the branch in place rather than making a new worktree
- **do not remove worktrees** — T3 owns their lifecycle

Applies to a machine after the PR merges and `nortuscc apply` runs.

## Backing this out

Three independent pieces. Reverse any subset.

### 1. The policy

```bash
git revert <commit>          # restores the old Git-and-worktrees section
nortuscc apply               # push it back to the machine
```

Or edit `claude/CLAUDE.md` directly: restore *"Do feature work in a dedicated
worktree on a dedicated feature branch. Default location:
`.claude/worktrees/<slug>`"* and the removal clause that followed it. The full
prior text is in this commit's parent.

### 2. The T3 side

Nothing to uninstall — the feature was always present and unused. To stop using
it, create threads without the worktree option. Existing T3 worktrees are normal
git worktrees:

```bash
git -C <repo> worktree list           # they show up here like any other
git -C <repo> worktree remove <path>
```

If you also want the startup scripts gone, clear them in T3's project settings;
they are inert when no worktree is created.

### 3. `worktree.symlinkDirectories`

Independent of the rest — it only ever affected Claude-created worktrees.

```bash
python3 - <<'EOF'
import json, pathlib
p = pathlib.Path.home() / ".claude" / "settings.json"
s = json.loads(p.read_text())
s.pop("worktree", None)
p.write_text(json.dumps(s, indent=2) + "\n")
EOF
```

### Signals that you should back out

- Branch names arrive as `worktree-<uuid>` rather than readable slugs — the
  generation path is failing and every PR needs a manual rename.
- `/experimental/worktree` changes behaviour after a T3 nightly update.
- Worktrees accumulate anyway, meaning thread-deletion cleanup is not firing.
  Re-check with `git worktree list` across repositories; the survey that found
  the original 14 is worth re-running.

## Cleanup already done

14 worktrees → 8. Removed 6 whose branches had **no commits absent from `main`**,
deleting each local branch with them. Untracked planning docs from the two
oldest were salvaged to
`~/.claude/backups/worktree-cleanup-2026-08-20T19-45Z/` before removal.

`change_log_generator/.claude/worktrees/openai-luna-migration` was **not**
removed — a live Claude session held its lock. It remains, and can be removed
once that session ends.

The 8 remaining all hold live in-flight work: zero dirty, zero unpushed.

## Loose end

`homeserver` puts its worktrees in `.worktrees/`, not `.claude/worktrees/` — a
third convention, and pre-existing. Not addressed here. Under T3 it stops
mattering for new work, since T3 chooses the location.
