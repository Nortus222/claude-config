---
status: accepted (designed in #51, not built)
---

# The hosted service stores metadata only, holds no repo credentials, and is never on the apply path

The service syncs accounts, machines, revision records and accept/skip decisions across a user's
machines. It runs on Azure Container Apps (scaling to zero) with Cosmos DB's free tier. Sign-in is
GitHub's device flow, run by the service with no scopes; it keeps the user id and discards the
token. The author's machine registers each revision as a tag and commit SHA, and the service never
reads Git, so public and private repos work the same and the service holds no secrets. Agents
poll with ETags.

## Considered options

- Push through Azure Web PubSub: the free tier allows about 20 connections; a 15-minute poll is
  enough.
- Accepting a GitHub token from the client: tokens issued to other apps could be replayed.
- The service reading setup repos: it would need private-repo credentials.
- Value digests on items: a hash of a low-entropy value such as `"medium"` reveals it.

## Consequences

- The agent verifies every revision: its tag must resolve to the recorded SHA in the setup's
  repo (GitHub serves a fork's commits by SHA from the parent), then it recomputes the items.
- Sign-up starts behind a server-side allowlist.
