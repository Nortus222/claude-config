# Add unslop implementation plan

**Goal:** Add only `unslop` from `cursor/plugins` to the skills managed by `nortuscc`.

## Scope

- Add a `[cursor/plugins]` group containing only `unslop` to `skills-manifest.txt`.
- Do not vendor skill content or add another skill from that source.
- Leave existing Claude Code and Codex install targeting and exposure inspection unchanged.

## Verification

1. Parse `skills-manifest.txt` and assert the `cursor/plugins` group is exactly `{ source: 'cursor/plugins', skills: ['unslop'] }`.
2. Build an install command from that group with the existing `agentIdsFor('all')` selection. Assert the command includes `--skill unslop --agent claude-code codex --global --yes`.
3. Run the focused manifest and skills CLI tests.
4. Run `npm test`.

## Commit

Commit the manifest and documentation with the managed-skill change. Do not alter installer behavior.
