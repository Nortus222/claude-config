# Deploy mobile skill nortuscc integration plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `deploy-mobile-apps` to the shared `nortuscc` skill set and replace this machine's standalone Codex copy with the CLI-managed installation.

**Architecture:** `skills-manifest.txt` remains the desired-state source and points at `Nortus222/agent-skills`. The existing `nortuscc` installer writes the skill to `~/.agents/skills`; a temporary backup protects the current standalone copy until the shared installation passes validation.

**Tech Stack:** Node.js 18+, `nortuscc`, `npx skills`, Git, Python skill validator

## Global constraints

- Keep skill content in `Nortus222/agent-skills`; this repository stores only the manifest entry.
- Install the shared copy at `~/.agents/skills/deploy-mobile-apps`.
- Preserve the existing Codex-only copy until the shared installation succeeds.
- Target pull requests at `main`; do not merge them.
- Keep the main checkout unchanged and perform repository writes in `feat/add-deploy-mobile-skill`.

---

### Task 1: Declare the shared skill

**Files:**
- Modify: `skills-manifest.txt:6-8`
- Reference: `docs/superpowers/specs/2026-08-17-deploy-mobile-skill-nortuscc-design.md`

**Interfaces:**
- Consumes: the existing `[Nortus222/agent-skills]` source group.
- Produces: a desired-state entry named `deploy-mobile-apps` with source `Nortus222/agent-skills`.

- [ ] **Step 1: Run the acceptance check before the manifest change**

Run:

```bash
rg -n '^deploy-mobile-apps$' skills-manifest.txt
```

Expected: exit 1 with no match.

- [ ] **Step 2: Add the skill to the existing source group**

Change the group to:

```text
[Nortus222/agent-skills]
deploy-mobile-apps
explain
```

- [ ] **Step 3: Run the focused checks**

Run:

```bash
rg -n '^deploy-mobile-apps$' skills-manifest.txt
NORTUSCC_REPO_DIR="$PWD" node bin/nortuscc.mjs status
```

Expected: `rg` prints one match. `nortuscc status` reports `deploy-mobile-apps` as missing rather than reporting a satisfied manifest.

- [ ] **Step 4: Run the full test suite**

Run:

```bash
npm test
```

Expected: 550 tests pass and 0 fail.

- [ ] **Step 5: Commit the desired-state change**

```bash
git add skills-manifest.txt
git commit -m "feat: manage mobile deployment skill"
```

### Task 2: Reconcile this machine through nortuscc

**Files:**
- Read: `skills-manifest.txt`
- Create through the existing installer: `/Users/nortus/.agents/skills/deploy-mobile-apps`
- Replace: `/Users/nortus/.codex/skills/deploy-mobile-apps`

**Interfaces:**
- Consumes: the Task 1 manifest entry and the `Nortus222/agent-skills` repository.
- Produces: one shared installed skill and valid Codex exposure, either native discovery or a symlink to the shared directory.

- [ ] **Step 1: Protect the standalone Codex copy**

Verify that the backup path does not exist, then move the current copy:

```bash
test ! -e /Users/nortus/.codex/deploy-mobile-apps-direct-backup
mv /Users/nortus/.codex/skills/deploy-mobile-apps /Users/nortus/.codex/deploy-mobile-apps-direct-backup
```

- [ ] **Step 2: Install only missing skills through nortuscc**

Run from the feature worktree:

```bash
NORTUSCC_REPO_DIR="$PWD" node bin/nortuscc.mjs apply --install --yes --no-hooks --no-mcp --no-plugins
```

Expected: the command installs `deploy-mobile-apps` from `Nortus222/agent-skills` and exits 0.

If it fails, restore the original copy and stop:

```bash
mv /Users/nortus/.codex/deploy-mobile-apps-direct-backup /Users/nortus/.codex/skills/deploy-mobile-apps
```

- [ ] **Step 3: Validate the shared installation**

Run:

```bash
python /Users/nortus/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/nortus/.agents/skills/deploy-mobile-apps
diff -qr /Users/nortus/Developer/misc/agent-skills/skills/deploy-mobile-apps /Users/nortus/.agents/skills/deploy-mobile-apps
NORTUSCC_REPO_DIR="$PWD" node bin/nortuscc.mjs status
```

Expected: validation passes, the source and installed directories match, and `nortuscc` reports the manifest satisfied.

- [ ] **Step 4: Verify Codex exposure and remove the backup**

Run:

```bash
if test -L /Users/nortus/.codex/skills/deploy-mobile-apps; then
  test "$(realpath /Users/nortus/.codex/skills/deploy-mobile-apps)" = "/Users/nortus/.agents/skills/deploy-mobile-apps"
else
  test ! -e /Users/nortus/.codex/skills/deploy-mobile-apps
fi
rm -r /Users/nortus/.codex/deploy-mobile-apps-direct-backup
```

Expected: Codex has no independent skill copy. The shared installation remains at `~/.agents/skills/deploy-mobile-apps`.

### Task 3: Verify and publish the config change

**Files:**
- Verify: `skills-manifest.txt`
- Verify: `docs/superpowers/specs/2026-08-17-deploy-mobile-skill-nortuscc-design.md`
- Verify: `docs/superpowers/plans/2026-08-17-deploy-mobile-skill-nortuscc.md`

**Interfaces:**
- Consumes: the committed manifest change and reconciled local installation.
- Produces: a reviewed branch and pull request against `main`.

- [ ] **Step 1: Run final verification**

```bash
npm test
NORTUSCC_REPO_DIR="$PWD" node bin/nortuscc.mjs status
python /Users/nortus/.codex/skills/.system/skill-creator/scripts/quick_validate.py /Users/nortus/.agents/skills/deploy-mobile-apps
git diff --check main...HEAD
```

Expected: 550 tests pass, `nortuscc` reports agreement, the skill validates, and the diff check is clean.

- [ ] **Step 2: Review the branch**

```bash
git status --short --branch
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: only the approved spec, plan, and manifest entry differ from `main`; the worktree is clean.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin feat/add-deploy-mobile-skill
gh pr create --repo Nortus222/claude-config --base main --head feat/add-deploy-mobile-skill
```

The pull request body must end with:

```text
Model: gpt-5.6-sol · Harness: T3 Code
```

Stop after reporting the branch, verification results, and pull request URL. Do not merge the pull request.
