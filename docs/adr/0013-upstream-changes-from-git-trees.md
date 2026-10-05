# Upstream skill changes are detected from Git trees in a local partial clone

`npx skills update` has no dry run: it reports changes only after making them. A skill's recorded
folder hash is the Git tree SHA of its upstream folder, so the author-only Sources watcher keeps
a blobless bare clone per source, compares the pin with `HEAD`, and reads changes without
downloading content or touching any pin. Ignoring a revision is an authoring decision committed
in `source-ignores.json` as one full SHA per source.

## Considered options

- GitHub's trees API: GitHub-only, rate-limited without auth, and it truncates large repos.
- Ignoring by tag or branch: tags move.

## Consequences

- Git runs without a shell or prompts but keeps the user's credential helpers, so private sources
  work; credentials are redacted from every URL and message.
- Moving a pin moves every skill from that source, so a pin-impact preview comes first.
