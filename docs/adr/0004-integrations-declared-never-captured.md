# Integrations are declared by hand: never captured, version-pinned or pruned

`integrations.json` is public and lists hooks, plugins, marketplaces and MCP servers explicitly.
`capture` never reads local integration state, because finding an extra must not quietly turn it
into policy. `status` reports undeclared extras, and the committed `allow` list accepts known
ones. Plugin versions are shown, never pinned: `claude plugin install` has no version option, so
a pin could never be enforced.

## Consequences

- Removing an entry stops new machines being offered it; it uninstalls nothing. Record the
  uninstall commands where the removal is explained.
- `claude-plugins-official` is treated as built in, because Claude Code adds it itself.
