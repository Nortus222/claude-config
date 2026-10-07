# claude-config

Personal Claude Code configuration, synced across the owner's machines. This repo holds
**policy and config**, never third-party content: `claude/` carries the files that land in
`~/.claude`, and `skills-manifest.txt` names which agent skills a machine should have
without vendoring any of them.

Companion repo: [Nortus222/agent-skills](https://github.com/Nortus222/agent-skills) holds
locally authored skills and is public so others can install them. This repo decides which
skills — from any source — belong on a machine.

## PR target

Feature branches target **`main`**.

## Layout

| Path | Purpose |
| --- | --- |
| `claude/CLAUDE.md`, `codex/AGENTS.md` | The agents' instruction files. Each agent rewrites its own in place, so both are synced by copy against a recorded baseline |
| `codex/openrouter-glm/config.toml` | Public GLM 5.3 Flash provider configuration installed into a separate Codex home; the API key remains machine-local |
| `claude/settings.keys.json` | The keys of `~/.claude/settings.json` this repo owns, and their values. Its key set *is* the allowlist — nothing reads the machine's own keys — so `permissions` and `enabledPlugins` stay user-owned. Synced key by key, never as a whole file |
| `integrations.json` | Plugins, marketplaces, hooks and MCP servers a machine should have. Public: it may name an environment variable, never its value. May also carry an `allow` list of extras that are present on purpose |
| `skills-manifest.txt` | Desired skill set, grouped by source repo |
| `bin/` | The dependency-free launcher. A checkout runs `src/main.ts`; an npx copy clones a checkout for `setup` and hands every other verb to the recorded one |
| `src/` | The CLI: `src/main.ts` dispatches every verb to `src/commands/<verb>.ts` |
| `packages/profile-engine/` | Shared TypeScript/Effect engine that resolves a machine's desired configuration — base profile, revision pins, machine overrides — with per-value provenance |
| `packages/machine/` | Shared TypeScript/Effect package that inspects a machine, plans against the engine's desired configuration, and executes plans with backups, progress and cancellation; it also keeps History, decisions and backup pruning. Used by the CLI and the desktop app |
| `packages/source-watch/` | Author-side watcher of the skill sources a setup uses: upstream revisions, `SKILL.md` diffs, pins and ignores |
| `packages/agent/` | The local agent: scheduler, job, fail-closed classifier and apply policy, run as a per-user login service (`nortuscc agent install`) that serves IPC on `agent/agent.sock` (Unix only; `nortuscc agent status`, `review`, `resume`, `policy`) |
| `packages/sync/` | Machine sync: setup items, held items (`sync.json`) composed over the checkout with `desiredFor`, and the agent's `SetupSource` (`setupSourceLayer`). Owns the contract the agent codes against; the CLI depends on it, never on the agent |
| `apps/desktop/` | Tauri 2 desktop app with a bundled Bun backend over `@nortuscc/machine` |
| `docs/adr/` | Architecture decision records: one short file per decision |

Nothing is synced by symlink. Directory links were retired once native installers
took over their own layouts — `~/.claude/skills` is populated by the skills
installer, and plugins live wherever Claude Code puts them.

## Conventions

- npm-workspaces monorepo on **Node 24+**, which runs TypeScript directly: no build step.
  `bin/*.mjs` is the dependency-free launcher; everything else is erasable-syntax TypeScript
  with `.ts` import extensions. The one runtime dependency is `effect` (pinned).
- Machine access goes through `@nortuscc/machine`'s services (`MachinePaths`, `Fs`,
  `Processes`, stores). Nothing below `pathsFromEnvironment` reads `process.env` or the home
  directory, so tests pass temporary paths explicitly.
- Use `node:`-prefixed builtin imports throughout.
- Test-first with `node:test` and `node:assert/strict`. Package tests are
  `packages/<name>/checks/*.spec.ts`; new CLI tests are `test/*.test.ts`, with black-box runs
  through the harness in `test/support/cli.ts` (temp home, temp repo, fake agent CLIs).
  Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Nothing destructive runs without a backup to `~/.config/nortuscc/backups/` first.

## Decisions and working documents

Git keeps **decisions**, not designs. Read `docs/adr/` before changing architecture, and add
`docs/adr/NNNN-slug.md` (next number, a short title and one paragraph: context, decision, why)
when a decision is hard to reverse, surprising without context, and the result of a real
trade-off. Change an ADR when its decision changes.

Specs, implementation plans and research are working documents. Write them under
`docs/superpowers/` or `docs/research/`, which git ignores, and put what a reviewer needs in
the PR body. Issues carry scope; ADRs carry the reasons.

## Tests

```bash
npm ci              # once per checkout; installs every workspace
npm test            # the CLI suite (node --test)
npm run test:packages
npm run typecheck
```

`node --test test/` reports `pass 0 / fail 1` on Node 25 — pass no path and let
the runner find `test/` itself, exactly as `package.json` does.
