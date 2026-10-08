# Hosted client

The agent's optional account client owns strict HTTPS metadata requests, private
machine credentials, account-scoped caches and a durable ordered outbox. It does
not grant repository trust or verify Git content. The agent and sync packages own
those operations. Local-only use constructs no hosted client.

`HostedClient.reportStatus(summary)` strictly validates the complete metadata body
and its 128 KiB cap under the client's account/request lock. It skips signed-out,
unauthenticated, reporting-disabled and durable-backoff states, accepts only HTTP
204, and records safe authentication/backoff failures. Status is ephemeral and does
not enter the outbox. The agent owns freshness and serializes account changes with
summary inspection and submission through its common apply/job boundary.
