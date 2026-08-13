# Add unslop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add only the linked `unslop` skill from `cursor/plugins` to the skill set managed by `nortuscc`.

**Architecture:** Extend the source-grouped manifest with one skill. Split install targeting from exposure inspection so default `all` installs use the upstream `*` selector while status still checks the two providers nortuscc owns.

**Tech Stack:** Plain-text skill manifest, Node.js 18+ ESM verification.

## Global Constraints

- Do not vendor third-party skill content.
- Add no other skill from `cursor/plugins`.
- Preserve the existing source-grouped manifest format.
- Default `--target all` skill installs must use `--agent '*'`.
- Explicit Claude and Codex targets must remain scoped to `claude-code` and `codex`.

---

### Task 1: Install managed skills across providers

**Files:**
- Modify: `src/skills-cli.mjs`
- Modify: `src/install-sections.mjs`
- Modify: `src/commands/apply.mjs`
- Modify: `src/commands/update.mjs`
- Modify: `test/skills-cli.test.mjs`
- Modify targeted command tests only if their existing assertions require the new install selector.
- Modify: `skills-manifest.txt`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing target selection and `buildCommand({ source, skills, agents })`.
- Produces: `installAgentIdsFor(target)`, returning `['*']` for `all`, `['claude-code']` for `claude`, and `['codex']` for `codex`.
- Preserves: `agentIdsFor(target)` for exposure inspection.

- [ ] **Step 1: Write the failing install-target test**

Add assertions to `test/skills-cli.test.mjs`:

```js
assert.deepEqual(installAgentIdsFor('all'), ['*']);
assert.deepEqual(installAgentIdsFor('claude'), ['claude-code']);
assert.deepEqual(installAgentIdsFor('codex'), ['codex']);
```

The production mutation this catches is default installs reverting to the two-provider list instead of using the upstream all-agent selector.

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `node --test test/skills-cli.test.mjs`

Expected: FAIL because `installAgentIdsFor` is not exported.

- [ ] **Step 3: Add the install-agent selector and use it in every install path**

Implement `installAgentIdsFor(target)` in `src/skills-cli.mjs`. Keep `agentIdsFor(target)` unchanged for status and exposure inspection.

Use the new helper for installer calls and command descriptions in setup, apply, update adoption, and update exposure repair. In update, inspect exposure with `agentIdsFor(target)` and repair it with `installAgentIdsFor(target)`.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
node --test test/skills-cli.test.mjs test/apply.test.mjs test/setup.test.mjs test/update.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Add the exact manifest entry**

Ensure `skills-manifest.txt` contains:

```text
[cursor/plugins]
unslop
```

- [ ] **Step 6: Verify parsing and exact installer scope**

Run:

```bash
node --input-type=module -e "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; import { parseManifest } from './src/skills.mjs'; import { buildCommand, installAgentIdsFor } from './src/skills-cli.mjs'; const group = parseManifest(readFileSync('skills-manifest.txt', 'utf8')).find(({source}) => source === 'cursor/plugins'); assert.deepEqual(group, {source:'cursor/plugins', skills:['unslop']}); const command = buildCommand({...group, agents:installAgentIdsFor('all')}); assert.deepEqual(command.args, ['-y','skills','add','cursor/plugins','--skill','unslop','--agent','*','--global','--yes'])"
```

Expected: exit 0. The group contains one skill and the command combines `--skill unslop` with `--agent '*'`.

- [ ] **Step 7: Run the full test suite**

Before running tests, update `README.md` to document the default all-provider skill exposure and the scoped behavior of explicit targets.

Run: `npm test`

Expected: all tests pass, 0 fail.

- [ ] **Step 8: Review and commit**

```bash
git diff HEAD
git add README.md skills-manifest.txt src/skills-cli.mjs src/install-sections.mjs src/commands/apply.mjs src/commands/update.mjs test/skills-cli.test.mjs test/fresh-machine.test.mjs docs/superpowers/plans/2026-08-12-add-unslop.md
git commit -m "chore: manage unslop skill"
```
