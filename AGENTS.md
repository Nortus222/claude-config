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
| `src/`, `bin/`, `test/` | The `nortuscc` CLI that does the reconciling |
| `packages/profile-engine/` | Shared TypeScript/Effect engine that resolves a machine's desired configuration — base profile, revision pins, machine overrides — with per-value provenance |
| `packages/machine/` | Shared TypeScript/Effect package that inspects a machine, plans against the engine's desired configuration, and executes plans with backups, progress and cancellation. Used by the CLI and the desktop app |
| `packages/source-watch/` | Author-side watcher of the skill sources a setup uses: upstream revisions, `SKILL.md` diffs, pins and ignores |
| `apps/desktop/` | Tauri 2 desktop app with a bundled Bun backend over `@nortuscc/machine` |
| `src/main.ts`, `src/commands/` | The CLI. Ported commands are TypeScript; unported ones are legacy `.mjs` until #59 removes them |
| `docs/adr/` | Architecture decision records: one short file per decision |

Nothing is synced by symlink. Directory links were retired once native installers
took over their own layouts — `~/.claude/skills` is populated by the skills
installer, and plugins live wherever Claude Code puts them.

## Conventions

- npm-workspaces monorepo on **Node 24+**, which runs TypeScript directly: no build step.
  New code is erasable-syntax TypeScript with `.ts` import extensions; legacy `.mjs` is only
  edited, never added. The one runtime dependency is `effect` (pinned).
- Machine access goes through `@nortuscc/machine`'s services (`MachinePaths`, `Fs`,
  `Processes`, stores). Nothing below `pathsFromEnvironment` reads `process.env` or the home
  directory, so tests pass temporary paths explicitly.
- Use `node:`-prefixed builtin imports throughout.
- Test-first with `node:test` and `node:assert/strict`. Package tests are
  `packages/<name>/checks/*.spec.ts`; CLI tests are `test/*.test.{mjs,ts}`. Commit after every task.
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
the runner find `test/` itself, exactly as `package.json` does. The root suite can
still rewrite `skills-manifest.txt` from this machine's skills; check `git status`
after a run and restore it.
