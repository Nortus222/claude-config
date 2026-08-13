# Add unslop implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add only `unslop` from `cursor/plugins` to the skills managed by `nortuscc`.

**Architecture:** Extend the source-grouped skill manifest. Keep the existing Claude Code and Codex install targeting and exposure inspection unchanged.

**Tech Stack:** Plain-text skill manifest and Node.js ESM tests.

## Global Constraints

- Do not vendor third-party skill content.
- Add no other skill from `cursor/plugins`.
- Preserve the existing source-grouped manifest format.
- Do not change installer behavior, target selection, or exposure inspection.

---

### Task 1: Add unslop to the managed manifest

**Files:**
- Modify: `skills-manifest.txt`

**Interfaces:**
- Consumes: the existing source-grouped skill manifest.
- Produces: a `cursor/plugins` group containing only `unslop`.
- Preserves: existing Claude Code and Codex install targeting.

- [ ] **Step 1: Add the exact manifest entry**

Ensure `skills-manifest.txt` contains:

```text
[cursor/plugins]
unslop
```

- [ ] **Step 2: Verify parsing and existing installer scope**

Run:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; import { parseManifest } from './src/skills.mjs'; import { buildCommand, agentIdsFor } from './src/skills-cli.mjs'; const group = parseManifest(readFileSync('skills-manifest.txt', 'utf8')).find(({source}) => source === 'cursor/plugins'); assert.deepEqual(group, {source:'cursor/plugins', skills:['unslop']}); const command = buildCommand({...group, agents:agentIdsFor('all')}); assert.deepEqual(command.args, ['-y','skills','add','cursor/plugins','--skill','unslop','--agent','claude-code','codex','--global','--yes'])"
```

Expected: exit 0. The group contains one skill and the command keeps the existing Claude Code and Codex selection.

- [ ] **Step 3: Run focused tests**

Run:

```bash
node --test test/manifest.test.mjs test/skills-cli.test.mjs test/fresh-machine.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 4: Run the full test suite**

Run:

```bash
npm test
```

Expected: all tests pass, 0 fail.

- [ ] **Step 5: Review and commit**

```bash
git diff HEAD
git add skills-manifest.txt docs/superpowers/plans/2026-08-12-add-unslop.md
git commit -m "chore: manage unslop skill"
```

Do not stage or modify production code.
