# User Instructions

These instructions apply across all Claude Code sessions. They take priority over plugin skills per the superpowers:using-superpowers precedence order (user CLAUDE.md > skills > default system prompt).

## Superpowers Plugin Overrides

I manage git and session boundaries myself. Override the following default behaviors from the `superpowers` plugin:

### Execution routing — prefer same-session subagents

When I ask to execute a plan, prefer `superpowers:subagent-driven-development` (which runs in the current session, dispatching subagents) over `superpowers:executing-plans` (which runs in a separate session). I want execution to stay in the current session by default.

If I explicitly ask for separate-session execution, you may use `superpowers:executing-plans` — but never pick it on your own.

### Spec → plan handoff — auto-proceed when unblocked

After you produce a spec/design doc (the `superpowers:brainstorming` output) and self-review it, do NOT stop to ask "should I write the plan?" when both of these hold:

1. **Self-review passes** — no placeholders/TODOs, internally consistent, and scoped to what I asked for.
2. **No blocking user-facing question** — there is no open decision that genuinely requires my input (an ambiguity that changes the design, or a choice with no sensible default that only I can make).

When both hold, proceed straight into `superpowers:writing-plans` in the same turn. Announce the handoff in one line ("Self-review passed, no open questions — writing the plan") and continue; don't wait for me to say "go."

A blocking question means I *must* decide before the design is sound. These do NOT block — note them and proceed:
- Optional weigh-ins where you already picked a sensible default ("I left the exact mechanism to the plan, but tell me if you have a preference").
- Implementation details that the plan itself will resolve.
- FYI observations.

If there IS a genuine blocking question, stop and ask it via `AskUserQuestion` (don't bury it in prose) — then, once answered, resume into `writing-plans` without a second approval gate. Surface any non-blocking notes alongside the handoff so I can still interject, but they never hold up plan-writing.

### No git worktrees

Do NOT invoke or follow `superpowers:using-git-worktrees`. Do NOT run `git worktree add`, `git worktree remove`, or create any `.worktrees/` or `worktrees/` directory. Treat every mention of "REQUIRED: Set up isolated workspace" in other skills as satisfied — I have already set up my workspace.

If a skill says it requires a worktree, skip that step and proceed as if it were done.

### Branch handling — work on the current branch

Work on the currently checked-out branch. Do NOT create, switch, rename, or check out branches (`git checkout`, `git switch`, `git branch <name>`, `git checkout -b`, etc.). I put myself on the correct branch before asking you to work.

Treat the `subagent-driven-development` red flag "Never start implementation on main/master branch without explicit user consent" as already waived — I have chosen the branch deliberately, so do not pause to ask for consent or offer to create a feature branch.

Exception: if I explicitly ask you to create or switch branches, you may — but never on your own initiative.

### No automatic git commits or staging

Do NOT run `git commit`, `git add`, `git stage`, or any other command that stages or commits changes. This overrides step 4 ("Commit your work") of the implementer-prompt in `subagent-driven-development`, and any other skill step that stages or commits on its own.

When dispatching implementer subagents (and any reviewer/fix subagents), strip the "Commit your work" instruction — and any staging step — out of their prompt entirely. Leave ALL changes unstaged in the working tree so I can review, stage, and commit them myself.

Exception: if I explicitly ask you to commit or stage, you may — but never on your own initiative.

### No git stash

Do NOT run `git stash` (or `git stash pop`/`apply`/`drop`). Because commits are disabled, ALL of your work lives as uncommitted changes in the working tree — stashing silently moves my work off the tree and makes it look like it vanished. This applies to controller and all subagents.

If a subagent thinks it needs a clean working tree (e.g. to run tests or a build), it must NOT stash. Work with the tree as-is, or report the situation as a blocker so I can decide. Never relocate my uncommitted changes.

### No worktree-cleanup plumbing

The `finishing-a-development-branch` skill's environment-detection and cleanup steps (Steps 2, 5, 6) run `git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel` plus `cd`/`git worktree remove`/`git branch -d` to clean up worktrees for Options 1 and 4. Since worktrees are off and Option 3 is the default, do NOT run any of that plumbing — skip the environment detection and cleanup entirely. Read-only `git status`/`diff`/`log`/`rev-parse` (with or without `-C`) are fine; the state-changing worktree/branch/merge commands are already forbidden above.

### Code review uses the working tree, not commit SHAs

Because per-task commits and staging are disabled (above), the SHA-based review flow in `subagent-driven-development` and `requesting-code-review` does NOT work as written. `code-quality-reviewer-prompt.md` and `requesting-code-review/code-reviewer.md` ask for `BASE_SHA`/`HEAD_SHA` and run `git diff BASE_SHA..HEAD_SHA` — but `HEAD` never advances and all work stays uncommitted, so that range reviews nothing.

When dispatching the code-quality reviewer (per task) or the final code reviewer (per batch), do NOT pass a `BASE_SHA..HEAD_SHA` range. Instead point the reviewer at the uncommitted working tree:

- Tracked changes: `git diff HEAD` — scope a single task with `git diff HEAD -- <files from the implementer's report>`.
- New/untracked files: these do NOT appear in `git diff HEAD` (nothing is staged). List them with `git status --porcelain` (or use the implementer's reported "Files changed" list) and have the reviewer read those files directly.
- Per-task isolation comes from the implementer's reported file list — with no intermediate commits, git cannot bracket a single task on its own.
- The final whole-batch review covers the full working-tree diff vs the pre-batch `HEAD` (`git diff HEAD` plus all untracked files).

The spec-compliance reviewer (`spec-reviewer-prompt.md`) is unaffected — it reads code directly and needs no git range. Tell every reviewer the diff is uncommitted and that staging/committing is mine to do — they review, they never commit.

**Building the review-package file — always use the wrapper, never inline redirects.** Do NOT assemble review/ledger package files with inline shell redirects (`{ echo …; git diff HEAD …; } > file.md`). Inline brace-group-with-redirect commands can never be allow-listed (Claude Code gates `> file` writes), so each one prompts. Instead call the pre-allow-listed wrapper:

```
bash ~/.claude/bin/sdd-pkg.sh <output-file> [--title "Task N review"] <file1> [file2 ...]
```

It writes the working-tree package (git status + `git diff HEAD` for the listed files, plus full contents of any untracked NEW files), `mkdir -p`s the output dir, and prints a one-line summary. This applies to controller and all subagents — pass the implementer's reported file list as the arguments. If the package needs content the wrapper doesn't produce, extend the wrapper rather than falling back to an inline redirect.

**Invoking superpowers skill scripts — use the version-agnostic `sp` launcher.** Do NOT call superpowers skill scripts by their hard-coded cached path (`~/.claude/plugins/cache/.../superpowers/<version>/skills/<skill>/scripts/<script>`) — the embedded version breaks allow-rules on every plugin update. Instead use the pre-allow-listed launcher:

```
bash ~/.claude/bin/sp <skill> <script> [args...]
# e.g. bash ~/.claude/bin/sp subagent-driven-development task-brief PLAN.md 2
```

`sp` resolves the highest installed superpowers version and execs the script, so it survives updates with no re-allow-listing. Controller and all subagents should use it.

### No per-task builds — build once at the end

Do NOT run a full project/solution build (e.g. `dotnet build`, `msbuild`, compiling the whole solution) after every task. This overrides the per-task "Verify implementation works" expectation in the implementer-prompt and the per-task review loop in `subagent-driven-development` / `executing-plans`.

- When dispatching implementer subagents, tell them to verify only their own task's scope. They MAY compile the specific project(s) their task touches in order to run that task's own tests — but they must NOT build or compile the entire solution per task/todo.
- Run the full solution build exactly once per batch of tasks, AFTER the entire batch is complete — as part of the final verification/review step before handing the branch back to me. Never run a full-solution build after an individual task/todo.
- If the final build fails, dispatch a fix subagent (or fix per the debugging skill); do not re-introduce per-task builds.

Exception: if I explicitly ask for a build after a specific task, you may run it — but never on your own initiative between tasks.

### No automatic git pushes or PRs

Do NOT run `git push`, `gh pr create`, or any remote-affecting git command. In the `superpowers:finishing-a-development-branch` skill:

- Skip Option 1 (merge locally) — do not run `git checkout <base>` + `git merge`.
- Skip Option 2 (push + PR) — do not push or create PRs.
- Skip Option 4 (discard) — do not delete branches.
- Default to Option 3 (keep branch as-is): report that implementation is complete, tests pass, and hand the branch back to me for merge/push/cleanup.

Do not present the 4-option menu at all. Just announce completion and stop.

### Summary

Across the superpowers workflow, stop at the point where code is written, tested, and verified. Git state (commits, branches, worktrees, merges, pushes, PRs) is mine to manage.
