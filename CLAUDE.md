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
| `claude/settings.json`, `claude/CLAUDE.md` | Rewritten in place by Claude Code — synced by copy |
| `claude/bin/`, `claude/hooks/` | Never written by an agent — synced by symlink |
| `skills-manifest.txt` | Desired skill set, grouped by source repo |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | Designs and implementation plans |

## Conventions

- Node 18+, plain ESM `.mjs`, no build step, and **zero dependencies** — including test
  tooling. Tests use `node:test` and `node:assert/strict` only.
- Use `node:`-prefixed builtin imports throughout.
- Test-first: write the failing test, then the module. Commit after every task.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Nothing destructive runs without a backup to `~/.claude/backups/` first.

## Tests

```bash
npm test          # node --test test/
```
