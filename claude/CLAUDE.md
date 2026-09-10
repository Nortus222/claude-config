# User Instructions

These rules apply across Claude Code sessions. A repository's `CLAUDE.md` supplies its project-specific
commands, PR target, and any stricter rules.

## Execution

- Keep plan execution in the current session with subagents unless I explicitly request a separate session.
- After a complete, self-reviewed design, proceed directly to planning when no decision genuinely requires me.
- Ask only blocking questions; note reasonable defaults and continue.

## Code taste

- Prefer the simplest solution that fully addresses the problem. Solve complex problems with clear code before adding architectural complexity.
- Apply YAGNI: add abstractions, layers, and extensibility only when current requirements justify them.
- Apply DRY with judgment. Keep small duplication when removing it would introduce a harder abstraction.
- Propose bold changes when they remove essential complexity and leave the system simpler. Explain why the change is worth its scope.
- Keep changes within the task's scope. Highlight worthwhile refactors or improvements, including why they matter, but do not implement them without the user's approval.

## Communication and comments

- Be concise. Focus explanations and progress updates on why a change matters.
- Write concise comments that state a function's purpose or contract, not a narration of its implementation.
- Update affected comments whenever code behavior changes.

## Git and worktrees

The main checkout is a read-only integration checkout. Keep it on its current integration branch. Do not
implement, stage, commit, switch branches, or merge feature work there.

Feature work happens in a worktree. **T3 Code creates it — you do not.**

- **Check before creating.** If the current directory is already a linked worktree, it is the one T3 made
  for this thread. Work in it. Run `git rev-parse --git-common-dir`; a path other than `.git` means you are
  in a linked worktree already.
- **Never create a second worktree beside the one you were given.** That is the failure this rule exists to
  prevent.
- If there is no worktree — a bare terminal, or a thread started outside T3 — say so and ask before creating
  one. Only then fall back to `git worktree add .claude/worktrees/<slug> -b <branch>`.
- The repository's `CLAUDE.md` must name the branch that feature PRs target. Do not guess a missing target.
- T3 names the branch, generated from the opening message. If it does not fit the repository's convention,
  rename it once at the start with `git branch -m <name>` rather than making a new worktree.
- Inside the task's worktree, agents may stage and commit their own changes, push that branch, and open its
  PR without asking.
- Never use `git stash`, force-push, or merge a PR. The owner controls integration.
- **Do not remove worktrees.** T3 owns their lifecycle and offers removal when its thread is deleted. Never
  discard an unmerged or dirty worktree.
- Preserve unrelated changes and never stage files outside the task.

Subagent isolation is separate and still yours to use: dispatching an agent with `isolation: worktree` gets
it a temporary worktree that Claude Code sweeps automatically. That does not conflict with T3's.

## Attribution

Anything you publish under my account should say what wrote it. Name the model and the harness you are
running as, never a generic "AI assistant".

- Every pull request you open ends with the model and harness as the last line of its body:
  `Model: <model> · Harness: <harness>`. Keep it last when you revise a PR body.
  Use this as the only attribution footer. Omit the "Generated with Claude Code" footer and its URL.
- Every comment you post — PR review, review reply, issue comment — opens with a GitHub note alert, so
  nobody reads it as me writing by hand:

      > [!NOTE]
      > <model> via <harness>, on behalf of Ihor.

- Do not add a `Co-Authored-By` trailer for the model to commit messages. The PR body carries the
  attribution; commits stay mine.

## Review and verification

- Before the first commit, review `git diff HEAD` plus untracked files.
- After commits exist, review the feature branch against the repository-declared PR target with
  `git diff <target>...HEAD`.
- Run targeted tests during implementation. Run a full solution build once at the end of a task batch, unless
  I explicitly request another full build.
- Report what was tested and what remains unverified. A successful build is not a passing test suite.

## Superpowers helpers

- Prefer `superpowers:subagent-driven-development` for same-session plan execution.
- Invoke a skill's scripts through the paths its native installation exposes; do not reach into a
  versioned plugin cache.
- Repository-specific skills may add orchestration, but they do not replace the Git rules above.

## Completion

From the feature worktree, commit, push, and open the PR against the repository-declared target. Report the
branch, verification, and PR URL. After completing the task and creating the PR, use the `show-me` skill
to explain the changes to the user, then stop. Do not merge it.
