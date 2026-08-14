# User Instructions

These rules apply across Codex sessions. A repository's `AGENTS.md` supplies its project-specific
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

- Do feature work in a dedicated worktree on a dedicated feature branch. Default location:
  `.claude/worktrees/<slug>`; a repository may specify another location. The directory name is shared
  across agents so two agents never split one repository's worktrees between two roots.
- The repository's instruction file must name the branch that feature PRs target. Do not guess a missing
  target.
- Inside the task's worktree, agents may create the feature branch, stage and commit their own changes, push
  that branch, and open its PR without asking.
- Never use `git stash`, force-push, or merge a PR. The owner controls integration.
- After the owner merges the PR, the main checkout may be fast-forwarded and the task worktree and local
  feature branch may be removed. Never discard an unmerged or dirty worktree.
- Preserve unrelated changes and never stage files outside the task.

## Attribution

Anything you publish under my account should say what wrote it. Name the model and the harness you are
running as, never a generic "AI assistant".

- Every pull request you open ends with the model and harness as the last line of its body:
  `Model: <model> · Harness: <harness>`. Keep it last when you revise a PR body.
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

## Skills

Shared skills are installed into `~/.agents/skills` and exposed to Codex by the `skills` CLI. Invoke a
skill's scripts through the paths that installation exposes; do not reach into another agent's plugin cache.

## Completion

From the feature worktree, commit, push, and open the PR against the repository-declared target. Report the
branch, verification, and PR URL, then stop. Do not merge it.
