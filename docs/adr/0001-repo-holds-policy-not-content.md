# The repo declares what a machine should have; native installers own the content

Skills, plugins and MCP servers come from many upstreams, each with a native installer that owns
its layout and updates. This repo stores only policy: a skill manifest grouped by source,
`integrations.json`, instruction files and owned settings keys. It installs through
`npx skills`, `claude plugin` and `codex mcp` rather than copying content, so machines keep their
own locally written skills and never drift from a vendored copy.

## Considered options

- Vendoring skill content: forces one identical set on every machine and fights local skills.
- Reimplementing the skills installer: we would own its layout and update bugs.

## Consequences

- Provenance lives in the repo (the manifest is grouped by source), because the installer's lock
  file is machine-local and empty on a fresh machine.
- Skills on a machine but missing from the manifest are reported, never deleted.
