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
health, account export and account deletion. The memory Store tests cover local
recovery and paused writers. Production adapters, deployment and live acceptance
remain separate work.

## Partition boundaries and recovery

Every atomic commit targets one approved partition: `accounts/accountId`,
`setups/setupId` or `identities/id`. Store snapshots have opaque concurrency tokens
and a `closed` flag, and must contain all pages under a stable token. The memory
adapter reproduces CAS conflicts, ownership checks and the maximum 99 distinct document mutations.
A future Cosmos adapter must reserve its hundredth operation for the marker.
`closePartition` conditionally closes an account or setup, including an absent
partition, in that partition alone. Closed partitions reject every upsert and
permit deletion-only batches. Empty closed markers retain only the opaque partition
ID, closed flag and concurrency version. IDs are never reused. Numeric GitHub
identity partitions cannot be closed and disappear when their documents are deleted.
There is no cross-partition transaction.

Setup registration first reserves an ID and immutable registration metadata in the
account partition. Reserved entries count toward the ten-setup limit. List, sync
and export repair interrupted materialization and mark reservations ready, so a
failed request does not lose the cleanup index or consume another slot during
recovery. Deletion closes every reserved setup ID before sweeping, fencing paused
null-CAS initializers.

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

## Account deletion and recovery

`DELETE /v1/account` first sets the account to deleting and captures its complete
setup reservation index in an account CAS. That CAS also freezes account-local
device reservation documents. Ordinary authentication is revoked immediately.
Deletion closes every setup, even an absent reservation target, before deleting
its metadata in batches of at most 99. Account deletion metadata and machine token
hashes remain until all indexed targets have been swept.

Device issuance reserves an existing random session ID in the account partition
before attaching any account claim. Deletion removes those indexed sessions,
including their temporary upstream credentials and claim hashes, before returning
204. Every later session claim write requires its old non-null concurrency version;
no poll or recovery path initializes an absent session. Each small reservation is
its own account document, so concurrent flows cannot grow an inline account array
past the database document size limit. Successful issuance or cleanup removes its
reservation only after physically deleting the session. Deleting accounts retain
all reservations for recovery; an interrupted pre-claim flow can leave a harmless
reservation until account deletion.

The numeric GitHub mapping becomes deleting before final account cleanup, blocking
fresh signup while old account metadata remains. The account is then closed and
swept, keeping its account document and at most 25 machine records for one final
atomic deletion. A conditional identity delete removes only a mapping still owned
by that old account. A stale cleanup worker cannot remove a fresh account mapping.
Paused setup/account initializers, publishers and machine issuers cannot resurrect
closed targets.

A failed deletion can be retried through exactly `DELETE /v1/account` using a token
whose hash remains in the deleting account. Hash verification and the ordinary
60-per-minute rate limit still apply. Payloads and query fields are rejected before
recovery, and deletion retries skip lastSeen updates. A fresh service instance can
resume from the stored cleanup index, including a closed but partially swept account.

A 503 after the final account batch may mean all metadata and token hashes are
already gone. The old token then returns 401, including on DELETE. A verified
GitHub device sign-in repairs an old deleting identity only after a point read
proves the old account is closed and empty, conditionally removes that mapping,
and creates a new account ID. This covers the final crash window without retaining
credentials or claiming a transaction across partitions.

Deletion deliberately retains one permanent opaque fencing marker per deleted
account and setup. Markers contain no identity, owner link, name, repository URL,
credential or content metadata, and never appear in export or diagnostics. This
owner-approved privacy tradeoff prevents arbitrarily paused creators from restoring
deleted data. It does not mean literal physical removal of every storage document.

Unbound device sessions have a validity deadline of at most 900 seconds, also
capped by the upstream deadline. They are not discoverable through an account
index and expire separately. The memory adapter physically removes them when an
expired session is polled; without another poll they remain in memory until the
Store is discarded. Successful sessions and indexed account claims are physically
removed as described above. A persistent expiry/TTL adapter and its physical
retention guarantee are deferred; the validity deadline alone is not such a guarantee.

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
codes, claims, device reservations, issuance fences, setup reservations, receipt
counters/order and concurrency markers. Explicit projection keeps storage discriminants and private fields out of every wire
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

`checks/client-integration.spec.ts` additionally connects the merged hosted client
and agent to that listener through the actual `httpTransport`. Its fetch adapter
rewrites only a fixed synthetic HTTPS origin to loopback HTTP and preserves the
request and response bytes, methods, headers and cancellation signals. Independent
temporary homes, fake keychains, a local bare Git origin and a fake connected
notification receiver keep owner state and native services untouched. Processes
permits only inert Git operations and refuses installers, OS registration,
keychain commands, native notifications and app launches.

These local checks cover explicit trust, person apply, inert auto apply, notify
waiting and History, actual private status, complete revision caches above50,
conditional polls, server receipt ordering, partial decision suffix retries,
revocation after account deletion on all three machines, local-state preservation
and account isolation. Hook registration still does not establish byte adoption in the merged client, so hooks remain waitingForPerson even after
a person copies their inert fixture text. The tests establish local service/client
interoperability; they do not establish production or native desktop acceptance.
