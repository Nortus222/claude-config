# Global Code Taste and Communication Design

## Goal

Add concise, matching guidance to the global Claude and Codex instruction files so agents favor simple solutions and explain why their changes matter.

## Files

- `claude/CLAUDE.md`
- `codex/AGENTS.md`

The policy text will be identical in both files. Existing platform-specific wording elsewhere remains unchanged.

## Code taste

Add a `Code taste` section after `Execution` with these rules:

- Prefer the simplest solution that fully addresses the problem. Solve complex problems with clear code before adding architectural complexity.
- Apply YAGNI: add abstractions, layers, and extensibility only when current requirements justify them.
- Apply DRY with judgment. Keep small duplication when removing it would introduce a harder abstraction.
- Propose bold changes when they remove essential complexity and leave the system simpler. Explain why the change is worth its scope.
- Keep changes within the task's scope. Highlight worthwhile refactors or improvements, including why they matter, but do not implement them without the user's approval.

## Communication and comments

Add a `Communication and comments` section before `Git and worktrees` with these rules:

- Be concise. Focus explanations and progress updates on why a change matters.
- Write concise comments that state a function's purpose or contract, not a narration of its implementation.
- Update affected comments whenever code behavior changes.

## Verification

- Confirm both files contain the same new policy text.
- Run the repository test suite to ensure configuration synchronization behavior remains intact.
