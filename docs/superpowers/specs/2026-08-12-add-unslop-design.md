# Add unslop to the managed skill set

## Goal

Make `unslop` part of the skill set managed by `nortuscc` without installing any other skill from `cursor/plugins`.

## Design

Add a `cursor/plugins` source group containing only `unslop` to `skills-manifest.txt`. Keep the upstream skill content out of this repository, consistent with the existing provenance-based manifest design.

The existing reconciliation flow will treat `unslop` as the only desired skill from that source. When it is missing, the existing command builder will invoke `npx skills add cursor/plugins --skill unslop` with global scope and non-interactive confirmation. It will not install the repository's other skills.

Skill targeting and exposure inspection remain unchanged. Default installs continue to name Claude Code and Codex explicitly, while explicit targets remain scoped to the requested provider.

## Verification

- Parse the updated manifest and confirm the `cursor/plugins` group contains exactly `unslop`.
- Confirm the command builder produces an install command scoped to `unslop` with the existing Claude Code and Codex agent selection.
- Run the full test suite.
