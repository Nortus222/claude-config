# Global Code Taste and Communication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add matching code-taste and communication guidance to the global Claude and Codex instruction sources.

**Architecture:** Insert the same two policy sections into both tracked instruction files, preserving their platform-specific rules. Validate textual parity directly, then run the existing synchronization test suite.

**Tech Stack:** Markdown, POSIX shell, Node.js `node:test`

## Global Constraints

- The policy text must be identical in `claude/CLAUDE.md` and `codex/AGENTS.md`.
- Existing platform-specific wording must remain unchanged.
- Keep all changes within the approved instruction-policy scope.

---

### Task 1: Add matching global instruction policies

**Files:**
- Modify: `claude/CLAUDE.md`
- Modify: `codex/AGENTS.md`

**Interfaces:**
- Consumes: The existing `Execution` and `Git and worktrees` section boundaries in both Markdown files.
- Produces: Identical `Code taste` and `Communication and comments` policy sections for Claude and Codex.

- [ ] **Step 1: Insert the approved policy text in both files**

Add this section immediately after the final bullet in `Execution`:

```md
## Code taste

- Prefer the simplest solution that fully addresses the problem. Solve complex problems with clear code before adding architectural complexity.
- Apply YAGNI: add abstractions, layers, and extensibility only when current requirements justify them.
- Apply DRY with judgment. Keep small duplication when removing it would introduce a harder abstraction.
- Propose bold changes when they remove essential complexity and leave the system simpler. Explain why the change is worth its scope.
- Keep changes within the task's scope. Highlight worthwhile refactors or improvements, including why they matter, but do not implement them without the user's approval.
```

Add this section immediately before `Git and worktrees`:

```md
## Communication and comments

- Be concise. Focus explanations and progress updates on why a change matters.
- Write concise comments that state a function's purpose or contract, not a narration of its implementation.
- Update affected comments whenever code behavior changes.
```

- [ ] **Step 2: Verify policy parity and inspect the focused diff**

Run:

```bash
diff \
  <(sed -n '/^## Code taste$/,/^## Git and worktrees$/p' claude/CLAUDE.md) \
  <(sed -n '/^## Code taste$/,/^## Git and worktrees$/p' codex/AGENTS.md)
git diff --check
git diff -- claude/CLAUDE.md codex/AGENTS.md
```

Expected: `diff` and `git diff --check` produce no output; the Git diff contains only the two approved sections in each file.

- [ ] **Step 3: Run the full test suite**

Run:

```bash
npm test
```

Expected: 505 tests pass with zero failures.

- [ ] **Step 4: Commit the instruction changes**

```bash
git add claude/CLAUDE.md codex/AGENTS.md
git commit -m "docs: add global code taste guidance"
```
