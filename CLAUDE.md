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
| `claude/settings.keys.json` | The keys of `~/.claude/settings.json` this repo owns, and their values. Its key set *is* the allowlist — nothing reads the machine's own keys — so `permissions` and `enabledPlugins` stay user-owned. Synced key by key, never as a whole file |
| `integrations.json` | Plugins, marketplaces, hooks and MCP servers a machine should have. Public: it may name an environment variable, never its value. May also carry an `allow` list of extras that are present on purpose |
| `skills-manifest.txt` | Desired skill set, grouped by source repo |
| `src/`, `bin/`, `test/` | The `nortuscc` CLI that does the reconciling |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | Designs and implementation plans |
| `docs/runbooks/` | One-off procedures, recorded with the commands that undo them |

Nothing is synced by symlink. Directory links were retired once native installers
took over their own layouts — `~/.claude/skills` is populated by the skills
installer, and plugins live wherever Claude Code puts them.

## Conventions

- Node 18+, plain ESM `.mjs`, no build step, and **zero dependencies** — including test
  tooling. Tests use `node:test` and `node:assert/strict` only.
- Use `node:`-prefixed builtin imports throughout.
- Test-first: write the failing test, then the module. Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Nothing destructive runs without a backup to `~/.claude/backups/` first.

## Tests

```bash
npm test          # node --test
```

`node --test test/` reports `pass 0 / fail 1` on Node 25 — pass no path and let
the runner find `test/` itself, exactly as `package.json` does.
