# Skills and AGENTS.md audit

Audit date: 2026-09-05. Model: GPT-6 · Harness: Codex.

The most useful changes are to resolve conflicting instructions and make workflows conditional on the task. Most project AGENTS.md files are already short. Deleting their repository facts would make them less useful.

This report applies Eric Provencher's [Rethinking skills and prompts for GPT-6 Astra](https://x.com/pvncher/status/2095991462416490862). The [source note](2026-09-05-skills-article.md) records retrieval and criteria. Findings below are judgments about the local files, not measured model performance improvements.

## Scope and method

- Enumerated `AGENTS.md` and `SKILL.md` recursively under `~/Developer` with `rg --files --hidden --no-ignore`, excluding only Git internals in the final scan. Found 32 paths, comprising 20 AGENTS.md files and 12 SKILL.md files, with 18 distinct file contents. Read each distinct content and compared worktree copies by SHA-256.
- Included nine dependency-owned files separately. Their presence on disk does not establish that an agent loads them.
- Also read all 29 installed `~/.agents/skills/*/SKILL.md` files because `misc/claude-config/skills-manifest.txt` declares these as the user's configured skills. All 29 manifest entries exist. Installed `explain` and `deploy-mobile-apps` match their main-checkout source files exactly.
- Checked relevant linked documents, the explanation template, release merge implementation, repository commands, and declared PR targets. This is an instruction audit, not a full review of every bundled script or supporting document.
- No skills, instructions, settings, or dependency files were rewritten, and existing worktree variants were preserved. Only this report and its source note were added in the existing dedicated feature worktree. System skills under `~/.codex/skills/.system` and other plugin caches are outside this audit.

Paths below beginning with a repository name are relative to `~/Developer`; installed skill references use `~/.agents/skills`. Line numbers describe the audited snapshot.

## Priority findings

### Resolve policy conflicts first

1. **Merge resolution can stage unrelated work.** `~/.agents/skills/resolving-merge-conflicts/SKILL.md:14` directs the agent to stage everything. This conflicts with `misc/claude-config/codex/AGENTS.md:41`, which preserves unrelated changes. Replace that step with staging only resolved task files and continuing the authorized merge or rebase. At line 10, replace the unconditional obligation to resolve incompatible intent with a stop for a genuinely blocking decision.

2. **Implementation can commit to the integration checkout.** `~/.agents/skills/implement/SKILL.md:15` says to commit to the current branch. The global file at line 28 makes the integration checkout read-only. Have the skill defer branch selection and completion to repository policy and require a task worktree before editing. This skill is marked `disable-model-invocation: true`, so the conflict matters when explicitly invoked, not as an assumed automatic trigger.

3. **Release automation contradicts the blanket merge prohibition.** The global file at line 38 prohibits PR merges, while `misc/agent-skills/skills/deploy-mobile-apps/SKILL.md:22` describes administrator promotion and release merges. Its `prepare` command actually performs a guarded promotion merge in `scripts/mobile_release_lib.py:1442`, before the later release approval snapshot. Decide the policy explicitly: either authorize the managed release workflow as a bounded exception, including promotion during preparation, or make preparation stop before merges. Keep approval of exact release heads. The article is not authorization to remove this boundary.

4. **Triage attribution conflicts with the owner's required opening.** `~/.agents/skills/triage/SKILL.md:13` requires a generic AI disclaimer first. The global file at line 50 requires the model, Codex, and the owner in a GitHub note alert. Have triage inherit the owner's attribution format rather than define its own.

### Remove work that does not help the requested outcome

5. **Ordinary explanations trigger a publication workflow.** `misc/agent-skills/skills/explain/SKILL.md:3` covers essentially any explanation, while lines 8, 66, and 130 require HTML production, an exact template, and a verification procedure. A small conceptual answer can therefore require a file, fixed sections, and command-line rendering. Keep a concise explanation route and make the HTML route conditional on an artifact request or a substantial walkthrough. Preserve the evidence rules and validate diagrams when generated. The template loads Mermaid and highlighting from a CDN, so its "self-contained" promise also needs clarification if offline use is intended.

6. **Global validation and completion lack task scope.** `misc/claude-config/codex/AGENTS.md:64` requires a full solution build for every task batch, including documents and repositories without builds. Lines 75 onward require commit, push, and PR without limiting the rule to repository changes. Condition builds on affected executable code and a configured build; condition PR completion on requested repository deliverables. Preserve targeted checks, honest reporting, worktree protection, and autonomous completion of authorized changes.

7. **Review advertises work-in-progress support but excludes uncommitted work.** `~/.agents/skills/code-review/SKILL.md:3` includes WIP; lines 21 through 23 use only `<fixed-point>...HEAD` and reject an empty committed diff. Add distinct routes for a branch or PR and for staged, unstaged, and untracked changes. Missing issue-tracker configuration at line 13 should not prevent a local review. Missing specs should produce an explicit coverage limitation while the standards review continues.

8. **Several workflows manufacture approval stops.** Installed `grilling`, `tdd`, `to-spec`, and `to-tickets` contain fixed approval gates. Keep them where the user requested a decision or publication requires authorization. Otherwise recognize decisions and authorization already supplied in the session. `research` also always delegates and produces a repository note, even for a small lookup. Use that workflow for substantial research; answer narrow lookups directly.

9. **Always-on style guidance is expensive by design.** `~/.agents/skills/unslop/SKILL.md:3` says it always applies, then supplies 31 editing rules. This is consistent with the user's current preference, but makes the full editorial procedure relevant to every response. A possible owner-approved revision would put a few durable style preferences in global instructions and reserve the complete skill for editing prose. Do not silently disable it.

## Project files

| File or identical group | Judgment | Recommended change |
| --- | --- | --- |
| `misc/claude-config/codex/AGENTS.md`, 642 words, five identical copies | Tune scope | Apply findings 3 and 6. Keep explicit authorization, worktree protection, attribution, and PR target requirements. Compress the overlapping simplicity rules only if that improves readability. |
| `homeserver/AGENTS.md`, 20 words, three identical copies | Keep router; fill policy gap | It already links context conditionally on operations work. `context.md` provides useful verified context and uncertainty. Neither file declares a feature PR target, which the global policy requires. Record the owner's target without guessing it. |
| `nortus-software/comfy-studio-ui/AGENTS.md`, 45 words | Narrow trigger; fill policy gap | Limit the Next.js docs instruction to Next.js APIs, routing, configuration, and framework changes rather than any code. The local `node_modules/next/dist/docs/` exists. `CLAUDE.md` only imports AGENTS.md; neither declares a PR target. |
| `eManageOne/telemetry-triage/AGENTS.md`, 160 words, six identical copies | Keep with small routing edit | Bun commands match `package.json`; target `main` is explicit. Make domain vocabulary reading conditional on terminology and domain behavior work. The linked domain document currently says to read context before exploring. Keep canonical labels and issue routing. |
| Two telemetry-triage agent-worktree variants, 159 words each | Keep branch-specific variant | They reference both phase contracts rather than Phase 1 alone. Do not overwrite them from main merely to make copies identical. |
| `pocketmanage_installers` and `pocketmanage_partner` AGENTS.md files in `bump-min-ios-version` worktrees, 21 words each | Keep | Both forward to an existing CLAUDE.md with target `dev`, release semantics, and telemetry closure rules. The wrappers exist only in these worktrees in this scan. Do not assume they are integrated into main. |
| `misc/agent-skills/skills/deploy-mobile-apps/SKILL.md`, 528 words | Keep operational detail; resolve policy | Exact app inventory, state, recovery, and release-head approval are useful constraints. Resolve finding 3 and the ambiguity between one build starting at line 46 and all configured check links at line 71. |
| Deploy skill in `cm-observation` worktree, 544 words | Preserve pending refinement | Its no-build row correctly distinguishes an unobserved check from proof that no build exists. Record this difference; do not discard or copy over the worktree. |
| `misc/agent-skills/skills/explain/SKILL.md`, 1,402 words, two identical copies | Split routes | Apply finding 5. Keep `gathering.md` as task-specific reference material. |

Both `misc/claude-config` and `misc/agent-skills` lack a root AGENTS.md in this scan. The former declares its target and commands in CLAUDE.md, so a small AGENTS.md forwarding file would improve discovery for agents that consult AGENTS.md. The latter README does not declare a PR target. Supply that policy before an implementation task needs it.

## Installed skill inventory

Each row covers `~/.agents/skills/<name>/SKILL.md`. All 29 are declared in the manifest. 14 files declare `disable-model-invocation: true`; these are explicit-invocation workflows, not assumed automatic triggers. Whether a runtime honors that field was not tested. Word counts include frontmatter.

| Skill | Words | Judgment | Finding or recommendation |
| --- | ---: | --- | --- |
| `ask-matt` | 1801 | Simplify router | Keep the map of available skills. Replace the mandatory setup, fresh-session, and context-clearing itinerary with task-dependent routes; session continuity should follow owner policy. |
| `code-review` | 1090 | Fix routing | Finding 7. Shorten the lengthy description to the review trigger. Keep independent standards/spec review when useful and put the long smell catalog in a reference. |
| `codebase-design` | 865 | Tune reference | Keep depth and interface reasoning. The glossary bans ordinary repository terms such as service and API; use the repository vocabulary when it is more precise. |
| `deploy-mobile-apps` | 528 | Resolve policy | Finding 3 and the project table. Keep exact inventory, approval snapshots, recovery states, and truthful build observation. |
| `diagnosing-bugs` | 1430 | Narrow and bound | The description includes any broken or slow behavior. Keep the full loop for hard bugs; allow source inspection and provisional hypotheses to construct a repro. Bound minimization and hypothesis counts to what distinguishes causes. |
| `domain-modeling` | 503 | Keep with scope edit | The trigger correctly distinguishes changing a domain model from reading it. Preserve lazy file creation and selective ADRs. Do not impose the glossary-only CONTEXT.md convention on repositories using that filename differently. |
| `explain` | 1402 | Split routes | Finding 5. Shorten the repeated trigger synonyms and make the HTML publication workflow conditional. |
| `find-skills` | 846 | Narrow trigger | Generic how-to and can-you prompts should not initiate a skill search. Trigger on requested discovery or installation; inspect task fit and source content instead of treating stars and install counts as quality gates. |
| `grill-me` | 22 | Keep wrapper | A 22-word explicit-invocation wrapper around grilling. No separate pruning needed; it inherits the grilling completion issue. |
| `grill-with-docs` | 35 | Keep wrapper | A 35-word explicit-invocation wrapper for grilling plus domain modeling. Keep documentation writes within the agreed design task. |
| `grilling` | 302 | Bound interview | Keep asking unresolved decisions and researching facts. Line 22 requires every branch to be visited and another final confirmation. Stop when the requested decision is resolved; reuse already-confirmed decisions. |
| `handoff` | 138 | Keep | Clear temporary output, redaction, and references to existing artifacts. Explicit invocation suits its use. No broad rewrite needed. |
| `implement` | 70 | Fix branch policy | Finding 2. Replace regular typechecking with checks justified by the change; inherit task completion and repository commands. |
| `improve-codebase-architecture` | 919 | Tune output | Keep scope-first exploration and an owner decision before implementing refactors. Make rich HTML and mandatory diagrams conditional on the requested review format; avoid forcing one architecture vocabulary onto every project. |
| `prototype` | 495 | Keep router; tune completion | LOGIC.md and UI.md are useful conditional branches. Rule 6 automatically folds decisions into real code; a prototype request should end with evidence and its answer unless production implementation is also authorized. |
| `research` | 133 | Tune scale | Primary sources and citations are worth keeping. A background agent and repository artifact fit substantial investigations, but should not be mandatory for a narrow factual lookup. |
| `resolving-merge-conflicts` | 134 | Fix staging | Finding 1. Preserve intent, stage only task files, and allow a blocking decision when conflicting intent cannot be reconciled. |
| `setup-matt-pocock-skills` | 1038 | Tune setup | Keep existing-configuration discovery and selective templates. Reuse existing tracker choices; avoid serial reconfirmations. Its preference for editing CLAUDE.md must account for which instruction file the active agent actually reads. |
| `tdd` | 569 | Tune gates | Keep independent behavioral assertions and red-before-green when TDD is requested. Line 22 requires confirmation before any test; accept boundaries already settled by the task or design. Avoid rereading every section on every cycle. |
| `teach` | 1490 | Split routes | Explicit invocation helps. The body assumes a multi-session workspace and HTML lessons for any topic; distinguish a one-off lesson from a course. Remove exact equal-word-count quiz answers and speculative reusable components. |
| `to-questionnaire` | 477 | Keep; reuse context | The recipient, knowledge gap, and output are clear. Do not repeat the two interview exchanges when the user already supplied those answers. |
| `to-spec` | 496 | Tune synthesis | Its description promises no interview, but the body requires test-boundary confirmation. Reuse agreed testing decisions and scale the mandated extensive user-story list to the actual feature. |
| `to-tickets` | 912 | Tune planning | Keep dependency edges and verifiable slices. Limit slices to affected layers and avoid automatic prefactoring. A second breakdown approval is unnecessary when that exact breakdown was already approved. |
| `triage` | 1010 | Fix attribution | Finding 4. Keep role mapping and prior-note reuse. Route queue listing, direct state overrides, and full investigation separately so a simple authorized label change does not inherit an interview. |
| `unslop` | 981 | Owner preference to revisit | Finding 9. Keep the current always-on preference until the owner changes it. Consider a short global style rule plus optional detailed editing reference. |
| `wait-what` | 49 | Keep small command | A 49-word explicit request to re-explain. Treat plain-language clarity as the outcome; do not require CONTEXT.md when absent or strict standards terminology for an ordinary clarification. |
| `wayfinder` | 2052 | Split routes; bound work | Keep the decision map, dependencies, and scoped destination. Move charting and working instructions to separate references. The one-ticket-per-session rule at line 105 conflicts with continuing authorized work in the current session. |
| `wizard` | 686 | Keep human-only boundary | The trigger excludes work the agent can perform. Keep static checks and irreversible-action confirmation. Read only configuration needed for the chosen setup, and reuse already-agreed stages. |
| `writing-for-agents` | 1806 | Keep principles; prune theory | Conditional context pointers and progressive disclosure match the article. Reduce repeated terminology and rigid claims about identical process or exhaustive criteria; preserve outcome-specific constraints and test behavioral assumptions. |

## Suggested follow-up order

First fix the concrete staging, branch, attribution, and release-policy conflicts. Then narrow `explain`, route WIP review correctly, and scope global validation and completion. Review fixed approval gates next. Keep repository facts and operational checks that encode real constraints.

Make installed third-party skill changes in a maintained source or deliberate fork and update the manifest. Local installation edits can disappear on update. Do not patch dependency-owned files or bulk-rewrite existing worktrees. No cleanup recommended here has been implemented.

## Verification and limits

The file census, content comparisons, manifest presence checks, and Markdown link existence checks for the user-owned target files completed. Linked Markdown paths in those files resolved. The Next.js documentation directory exists, and telemetry commands match its package manifest.

Ran the configuration repository's `npm test` once: 669 tests, 664 passed, five failed. All failures are in `test/cli-version.test.mjs`; its fixture does not create `codex/openrouter-glm/config.toml` before the sync loop attempts to copy it. The failure occurs with unchanged application and test code. This audit does not repair that separate issue. The repository declares no build step.

No live release, SSH operation, deployment, behavioral model comparison, or other repository's application tests were run. Word counts describe source files, not tokens actually injected by a particular runtime. Installed does not mean loaded in every session.

## Dependency instruction audit

Read all nine dependency-owned files in the inventory, eight Redux Toolkit skills and Fastify AGENTS.md. No dependency files changed and no instructions or commands from these files executed. These are package contents, not the user's maintained instruction sources. Recommendations below are upstream observations or reasons to avoid adopting these copies unchanged.

The Redux skills generally meet the supplied article criteria. Each has a domain-specific trigger and concrete library guidance. They are reference guides rather than mandatory end-to-end workflows, so the absence of a completion checklist is not itself a defect. Repeated examples make them longer than necessary, but length alone does not justify deleting API constraints. Five relative reference links were checked and all exist.

Paths below abbreviate `/Users/ihor/Developer/eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/` as `RTK/`.

| File | Keep | Tune if maintaining upstream |
| --- | --- | --- |
| `RTK/build-modern-redux-apps/modern-redux/SKILL.md` | Lines 4-7 give a clear setup/modernization trigger; lines 144 and 263 describe concrete store-lifetime failures. | Lines 4-7 overlap the dedicated migration skill. Route legacy migration there and conditionally load SSR examples at 112-144 and 232-265 only for server rendering. The reference link at 304 exists. |
| `RTK/build-modern-redux-apps/redux-dataflow/SKILL.md` | Lines 124, 165 and 211 explain reducer ownership and immutability with actual failure modes. | The broad debugging trigger at 4-6 overlaps the diagnosis skill. Repeated setup and wrong/right examples can be moved behind topic-specific references. The update example at 87 checks truthiness, so it silently prevents an empty title. If copied into production, distinguish absent title from an empty string. |
| `RTK/evolve-and-diagnose-redux-apps/debug-redux-toolkit-apps/SKILL.md` | Lines 4-7 identify concrete failure symptoms; line 135 directs a cache investigation to subscription status. | Line 85 makes action-first diagnosis unconditional even when evidence has already isolated another layer. Make this an initial heuristic. The supposed stable selection example at 260-264 still creates a fresh default empty array while data is undefined. Use a stable empty constant if preserving this example. Add a short outcome requirement for an actual debugging task: reproduce the symptom, verify the fix, report remaining uncertainty. |
| `RTK/evolve-and-diagnose-redux-apps/migrate-to-modern-redux/SKILL.md` | Lines 108-115 provide exact codemods plus manual review; lines 139-157 favor incremental migration; lines 161-184 preserve a version-specific incompatibility. | Line 106 mandates migrating every reducer as soon as it is edited. Scope that to an authorized migration or a change for which the migration is justified. A touched reducer during a small bug fix should not silently expand the task. |
| `RTK/manage-server-data/adopt-rtk-query/SKILL.md` | Lines 248-276 cover necessary store wiring; 356-381 explain the subscription condition behind invalidation; the reference at 385 exists. | Lines 100-120 and 198-246 repeat the same API-slice guidance. Move optimistic-update and persistence details behind conditional references so basic adoption does not load all examples. Retain the specific cache constraints. |
| `RTK/model-redux-state/build-slices-and-selectors/SKILL.md` | Lines 172 and 334 are useful conditional and version-specific guidance; the reference at 364 exists. | The trigger bundles ordinary slices, async creators, entity adapters and lazy injection. The initial example at 26-85 introduces an async slice factory even for an ordinary slice task. Lead with basic createSlice and route advanced features to the existing reference only when needed. Lines 174-214 also couple adapters to lazy injection without a requirement for both. |
| `RTK/model-redux-state/design-state-ownership/SKILL.md` | The trigger at 4-6 is a bounded decision; lines 127, 152 and 287 preserve context-dependent ownership and resizing advice; the reference at 322 exists. | The form-state section labels Redux editing state wrong at 156-176 even though line 176 itself says this data only usually lives in one tree. State the condition explicitly so shared drafts are not rejected by a blanket rule. |
| `RTK/orchestrate-side-effects/handle-side-effects/SKILL.md` | Lines 4-7 define the tool-choice trigger; lines 83, 124 and 163 explain when each tool fits; 265 preserves the middleware-order constraint; the reference at 271 exists. | The setup at 24-59 creates listener middleware before deciding whether the task needs it. Put tool selection first and load the chosen setup conditionally. No broad workflow mandate found. |
| `/Users/ihor/Developer/nodeProjects/ytmdesktop/node_modules/fastify/AGENTS.md` | Keep exact package scripts and constraints such as public type parity at 187-190 and profiling hot paths at 201-204. | Confirmed drift: line 14 says 5.7.1, installed package.json says 5.7.4. Paths `lib/req-res.js` at 42/160 and `lib/plugin.js` at 44/144/183 do not exist; `lib/request.js`, `lib/reply.js`, and `lib/plugin-utils.js` do. The universal checklist at 220-224 repeats lint and type checks already included in npm test. Its broad overview, dependency tour and repeated workflow sections are candidates for references, not always-loaded context. |

Fastify validation was read-only against the installed package.json and filesystem. All command names sampled from the file exist, including unit, coverage, test:watch, test:typescript, test:ci, lint, lint:fix, benchmark and lint:markdown. The installed `test` script is `npm run lint && npm run unit && npm run test:typescript`, proving the checklist repetition. No dependency test suite or build was run because this was a document audit.

The Redux example concerns are direct JavaScript observations, not a full verification of the SDK guidance. API examples were not compiled, and package-published source claims were not independently checked against current upstream docs. Avoid presenting these observations as a complete Redux correctness review.

## Complete Developer inventory

Paths are relative to `~/Developer`. SHA-256 prefixes identify identical contents; worktree copies are counted as paths, not independent maintained policies.

| Path | Words | SHA-256 prefix |
| --- | ---: | --- |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/build-modern-redux-apps/modern-redux/SKILL.md` | 889 | `92ccadd334b3` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/build-modern-redux-apps/redux-dataflow/SKILL.md` | 789 | `ef30b339f090` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/evolve-and-diagnose-redux-apps/debug-redux-toolkit-apps/SKILL.md` | 745 | `9a39ffa45df6` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/evolve-and-diagnose-redux-apps/migrate-to-modern-redux/SKILL.md` | 754 | `8c7504ced75e` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/manage-server-data/adopt-rtk-query/SKILL.md` | 1072 | `31559f085f52` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/model-redux-state/build-slices-and-selectors/SKILL.md` | 1069 | `d1de9d58af06` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/model-redux-state/design-state-ownership/SKILL.md` | 974 | `b6e0b4d7c401` |
| `eManageOne/emws_docs/emws_api_docs/node_modules/@reduxjs/toolkit/skills/orchestrate-side-effects/handle-side-effects/SKILL.md` | 733 | `857824c04586` |
| `eManageOne/pocketmanage_installers/.claude/worktrees/bump-min-ios-version/AGENTS.md` | 21 | `4df1f14c89f2` |
| `eManageOne/pocketmanage_partner/.claude/worktrees/bump-min-ios-version/AGENTS.md` | 21 | `4df1f14c89f2` |
| `eManageOne/telemetry-triage/.claude/worktrees/agent-a5ce006cb04db5bee/AGENTS.md` | 159 | `7fac0b9773d6` |
| `eManageOne/telemetry-triage/.claude/worktrees/agent-a86ebdb70e0c1712d/AGENTS.md` | 159 | `7fac0b9773d6` |
| `eManageOne/telemetry-triage/.claude/worktrees/dedicated-web-route-binding/AGENTS.md` | 160 | `7f333ab41a0d` |
| `eManageOne/telemetry-triage/.claude/worktrees/environment-coverage/AGENTS.md` | 160 | `7f333ab41a0d` |
| `eManageOne/telemetry-triage/.claude/worktrees/open-issue-triage/AGENTS.md` | 160 | `7f333ab41a0d` |
| `eManageOne/telemetry-triage/.claude/worktrees/phase2-incident-evidence/AGENTS.md` | 160 | `7f333ab41a0d` |
| `eManageOne/telemetry-triage/.claude/worktrees/phase2-sandcastle-openrouter/AGENTS.md` | 160 | `7f333ab41a0d` |
| `eManageOne/telemetry-triage/AGENTS.md` | 160 | `7f333ab41a0d` |
| `homeserver/.worktrees/apple-home-presence/AGENTS.md` | 20 | `8fb38238d92b` |
| `homeserver/.worktrees/cloudflare-access-hardening/AGENTS.md` | 20 | `8fb38238d92b` |
| `homeserver/AGENTS.md` | 20 | `8fb38238d92b` |
| `misc/agent-skills/.claude/worktrees/cm-observation/skills/deploy-mobile-apps/SKILL.md` | 544 | `e5b3d9edafa7` |
| `misc/agent-skills/.claude/worktrees/cm-observation/skills/explain/SKILL.md` | 1402 | `6965461ead1e` |
| `misc/agent-skills/skills/deploy-mobile-apps/SKILL.md` | 528 | `2f35604a06a0` |
| `misc/agent-skills/skills/explain/SKILL.md` | 1402 | `6965461ead1e` |
| `misc/claude-config/.claude/worktrees/fix-layout-table/codex/AGENTS.md` | 642 | `542af632fb40` |
| `misc/claude-config/.claude/worktrees/layout-settings-row/codex/AGENTS.md` | 642 | `542af632fb40` |
| `misc/claude-config/.claude/worktrees/settings-key-sync/codex/AGENTS.md` | 642 | `542af632fb40` |
| `misc/claude-config/.claude/worktrees/status-undeclared-inventory/codex/AGENTS.md` | 642 | `542af632fb40` |
| `misc/claude-config/codex/AGENTS.md` | 642 | `542af632fb40` |
| `nodeProjects/ytmdesktop/node_modules/fastify/AGENTS.md` | 1285 | `bf18363f0773` |
| `nortus-software/comfy-studio-ui/AGENTS.md` | 45 | `e3447d842518` |
