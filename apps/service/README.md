# Hosted service core

`@nortuscc/service` is an embeddable HTTP v1 metadata service on Node 24+,
pinned Effect 4 and `@nortuscc/hosted-protocol`. It has no executable launcher,
production GitHub adapter, cloud adapter or environment access. Its memory Store
is for local embedding and tests. It does not read repositories or apply machine
configuration.

Construct `makeService({ now, config, diagnostic })` with injected `Store` and
`GitHub` Effect services, then pass the captured handler to
`createServiceServer(handler)`. The returned Node server is unlistened; the caller
chooses its host, port and lifecycle. `config` supplies `allowlistedLogins`,
`openSignup` and positive integer `pollAfter` seconds, normally 900. All approved
metadata handlers are wired by default. The optional `metadata` callback replaces
that dispatch for embedding tests; callers do not need to supply it.

The current batch implements device authentication, machine lifecycle, setup
registration/listing, revision publication/listing, decisions, sync, private status,
health and account export. Account deletion and the final partition-closure
contract belong to Task 3B and remain unimplemented. In particular, this core does
not claim crash-safe account deletion concurrent with a reserved initializer.
The current Store physically removes empty partitions; a paused null-CAS creator
can still recreate one. No production deployment or deletion guarantee follows
from these memory checks.

## Partition boundaries and recovery

Every atomic commit targets one approved partition: `accounts/accountId`,
`setups/setupId` or `identities/id`. Store snapshots have opaque concurrency tokens
and must contain all pages under a stable token. The memory adapter reproduces
CAS conflicts, ownership checks and the maximum 99 distinct document mutations.
A future Cosmos adapter must reserve its hundredth operation for the marker.
There is no cross-partition transaction.

Setup registration first reserves an ID and immutable registration metadata in the
account partition. Reserved entries count toward the ten-setup limit. List, sync
and export repair interrupted materialization and mark reservations ready, so a
failed request does not lose the cleanup index or consume another slot during
recovery. This recovery alone does not solve the deferred deletion race.

Publication commits the immutable revision, new setup head and UTC daily quota in
one setup CAS. Its account checkpoint follows separately. A **503 after publication
may mean the revision committed**. The caller must reconcile through revision
reads if retry reports a revision conflict. No rollback is attempted. Checkpoint
repair advances seq only for an unseen revision range and never regresses a newer
checkpoint. Existing-partition publication never initializes an absent setup.

Structurally valid decision and machine-patch requests reserve a private account
receipt ticket in account CAS before asynchronous processing. That durable
authenticated receipt defines service arrival order across replicas, without a
global socket-arrival clock. Reservation does not advance public seq. Decision
writes prevalidate all references before changing decision records. A chunk contains
at most 99 request positions and 98 distinct decision targets plus the account
update. Duplicate positions are processed in order and coalesced only at the
storage boundary. Revision precedence comes first; equal revisions use receipt
ticket and original request position, so a delayed earlier request cannot overwrite
a later reversal after a CAS retry. Each new HTTP retry gets a new receipt. Older
revisions and superseded equal-revision receipts are stale. Machine patches keep
receipt order per field, allowing an older partial patch to change a field untouched
by a later patch. Only changed public settings advance seq. Counter exhaustion
fails closed with generic 503. A transient chunk failure returns a 200 response with the processed prefix and an unprocessed
suffix. Consumers must correlate every result with its original position using
`decodeDecisionsResponse` before removing queued entries.

## Complete sync and privacy

Sync returns every immutable record after each setup cursor, including more than
50. Missing cursors mean zero; revision-list pages alone have the 50-record cap.
The advertised head never exceeds the complete returned range. Account seq and
decisions come from one account snapshot. Setup snapshots follow that account read;
these independent checkpoints are not a global transaction.

Sync reads setup partitions even for conditional requests. It repairs account
checkpoints when possible, then selects a fresh account snapshot. If checkpoint
writes remain temporarily unavailable, it still exposes committed setup heads.
The ETag hashes the normalized query and complete response, including actual heads
and pollAfter. LastSeen and private status do not affect it. An invalid assembled
wire projection fails generically instead of advancing a client checkpoint past
omitted decisions.

All incoming metadata is recursively strict. Original HTTP bodies are bounded to
128 KiB before parsing. Under that request bound, malformed or unknown fields
return 400 before semantic limit classification. Structurally valid counts over
500 items or decisions return 409 limit_reached. Valid changelogs over 16 KiB or
full revision records over 64 KiB, including server-added metadata, return 413
payload_too_large. Count overflow takes precedence when a valid publication exceeds
both a count and a byte bound. Other-account resources return 404. Status accepts only
known setup-history item IDs, including removed items, and published revision
cursors. Reporting optout deletes the stored summary and later uploads return
409; decision sync continues.

Health is exactly `{ status: 'ok' }` and performs no Store reads. Account export
uses the strict `AccountExportSchema` projection:

- `account` contains accountId, numeric githubId, login, seq, defaultPolicy and createdAt.
- `machines` contains public machine records and their enabled status summaries.
- `setups`, `revisions` and `decisions` contain every public record for the account.

Export has no revision-page cap. It excludes token hashes, OAuth tokens, device
codes, claims, issuance fences, reservations, receipt counters/order and concurrency
markers. Explicit projection keeps storage discriminants and private fields out of every wire
response. Diagnostics contain only request ID, sanitized route template, status,
duration and an optional account hash. Failures and diagnostic callback errors
never expose request values or causes.

## Verification

```bash
npm test -w apps/service
npm test -w packages/hosted-protocol
npm run typecheck -w apps/service
npm run typecheck -w packages/hosted-protocol
```

Checks use an actual loopback HTTP listener, fake upstream GitHub, an injected
clock, isolated memory Stores and Store fault/barrier wrappers. They do not sign
in to production, install a native service or touch a person's home. Production
Cosmos, emulator, OAuth, deployment, TTL retention and live acceptance are deferred.
