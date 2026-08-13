# Add unslop to the managed skill set

## Goal

Make `unslop` part of the skill set managed by `nortuscc` without installing any other skill from `cursor/plugins`.

## Design

Add a `cursor/plugins` source group containing only `unslop` to `skills-manifest.txt`. Keep the upstream skill content out of this repository, consistent with the existing provenance-based manifest design.

The existing reconciliation flow will treat `unslop` as the only desired skill from that source. When it is missing, the existing command builder will invoke `npx skills add cursor/plugins --skill unslop` with global scope and non-interactive confirmation. It will not install the repository's other skills.

Default `--target all` installs will pass `--agent '*'`, exposing each selected skill to every agent supported by the upstream installer, including Claude Code, Codex, and Cursor. Explicit `--target claude` and `--target codex` runs remain scoped to `claude-code` and `codex` respectively.

Agent exposure inspection remains scoped to Claude Code and Codex because those are the configuration targets nortuscc owns. The `*` value is an install selector, not an agent identity that status can inspect. A separate install-agent helper keeps those two meanings explicit, and setup, apply, update adoption, and update exposure repair all use it.

Update the Skills documentation to state that default all-target installs expose managed skills to every agent recognized by the installer, while explicit targets remain scoped.

## Verification

- Parse the updated manifest and confirm the `cursor/plugins` group contains exactly `unslop`.
- Add a failing unit test that requires default installs to target `*` while scoped installs keep their existing agent IDs.
- Confirm setup, apply, update adoption, and exposure repair use the install-agent selection.
- Confirm the command builder produces an install command scoped to `unslop` while targeting `*`.
- Run the full test suite.
