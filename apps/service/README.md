# Hosted metadata service

`@nortuscc/service` runs HTTP v1 on Node 24+, pinned Effect 4 and
`@nortuscc/hosted-protocol`. It includes a production GitHub device-flow adapter,
managed-identity Cosmos resources and an owned Node HTTP runtime. The memory Store
and unlistened HTTP core remain available for embedding. The service stores
metadata only; it never reads repositories or applies machine configuration.

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
recovery and paused writers. The executable and adapters are implemented. Real
OAuth, managed identity/RBAC, cloud provisioning, deployment and LIVE multi-machine acceptance remain unverified.

## Run the service

Install the workspace dependencies once with `npm ci`, then run from the repository
root using an existing GitHub OAuth app and existing Azure resources:

```bash
export NORTUSCC_SERVICE_GITHUB_CLIENT_ID=YOUR_PUBLIC_OAUTH_CLIENT_ID
export NORTUSCC_SERVICE_COSMOS_ENDPOINT=https://YOUR_ACCOUNT.documents.azure.com/
export NORTUSCC_SERVICE_COSMOS_DATABASE=metadata
export NORTUSCC_SERVICE_ALLOWLIST=YOUR_GITHUB_LOGIN
npm start -w apps/service
```

Replace the uppercase placeholders. Defaults bind loopback port 8080 and keep
signup closed. An empty allowlist denies new sign-ins while signup is closed.
The command performs no provisioning or native service installation. Put TLS and
any public routing in your hosting layer; explicitly set HOST to `0.0.0.0` only
when that layer needs it.

Enable device flow in a dedicated identity-only OAuth app before use. The adapter
requests no scope or client secret, requires an empty returned scope and bearer
token, and verifies the numeric identity through `GET /user` with REST version
`2026-03-10`. GitHub access tokens exist only during that exchange and lookup;
refresh tokens are ignored, with no token storage/cache/refresh or revocation API
call. "Transient" does not mean GitHub revokes the upstream token when its local
reference is discarded. The machine token returned by this service is separate;
only its hash is stored. [GitHub device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow),
[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps),
[API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions).

The Azure host needs a system-assigned managed identity, or the selected
user-assigned identity. Grant its Cosmos data-plane role metadata reads and item
read/query/create/replace/delete/batch access for the existing database. The
built-in Cosmos DB Data Contributor role is one documented option. Control-plane
Azure Contributor alone is insufficient. Require a Strong account, the container
settings below, and disabled local/key authentication in the production account.
The fixed 1000 RU/s account budget is an infrastructure prerequisite. Startup
reads metadata; it cannot prove write authorization, disabled key access or the RU
budget. [Cosmos data-plane RBAC](https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-connect-role-based-access-control).

Production constructs exactly one `ManagedIdentityCredential`, never
`DefaultAzureCredential`, a developer-credential chain, account key or connection
string fallback. Identity 4.13.3's supported managed-identity path uses the owned
HTTP transport, zero SDK retries and bounded token acquisition. Any configured
`AZURE_FEDERATED_TOKEN_FILE`, including an empty value, rejects production startup
before resources exist. AKS workload identity/token federation is unsupported
until an adapter can own that SDK path. The identity transport removes advertised
compression because the pinned default client's partial gzip/deflate decoder can
fail to join cancellation; unsolicited complete compressed token bodies fail
redacted parsing. [Azure authentication guidance](https://learn.microsoft.com/en-us/azure/developer/javascript/sdk/authentication/best-practices),
[supported identity transport options](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/tokencredentialoptions?view=azure-node-latest).

## Strict configuration

All names below have the `NORTUSCC_SERVICE_` prefix. Unknown variables in that
namespace reject startup. Other platform variables are ignored except the
production federation rejection above. Booleans accept exactly `true` or `false`;
integers accept canonical positive decimal without spaces, signs or leading zeros.
Configuration failures and startup errors contain no rejected values.

| Suffix | Default | Accepted value |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | Required | 1..100 ASCII letters, digits or underscores |
| `COSMOS_ENDPOINT` | Required | Credential-free HTTPS root URL, no query/fragment or loopback aliases in production |
| `COSMOS_DATABASE` | Required | 1..100 ASCII letters/digits/underscore/hyphen, starting with a letter/digit |
| `MANAGED_IDENTITY_CLIENT_ID` | System identity | UUID for an explicitly selected user identity; forbidden in emulator mode |
| `HOST` | `127.0.0.1` | `127.0.0.1`, `::1` or `0.0.0.0` |
| `PORT` | `8080` | 1..65535; zero is forbidden by the environment parser |
| `OPEN_SIGNUP` | `false` | Boolean |
| `ALLOWLIST` | Empty | Comma-separated GitHub logins, no spaces, empty entries or case-insensitive duplicates |
| `POLL_AFTER_SECONDS` | `900` | 1..86400 |
| `SWEEP_INTERVAL_SECONDS` | `60` | 1..3600 |
| `SWEEP_TIMEOUT_SECONDS` | `60` | 1..300; also bounds each startup validation, sweep and listener-bind phase |
| `SHUTDOWN_GRACE_SECONDS` | `10` | 1..60 |
| `LOCAL_EMULATOR` | `false` | Boolean; an explicit local-only mode |
| `EMULATOR_KEY` | Unset | Required only in emulator mode, 1..1024 characters without whitespace or controls; forbidden in production |

Emulator mode alone permits HTTP and only the exact root hosts `127.0.0.1` or
`[::1]`, with an optional port. It never constructs an identity credential, even
if unrelated Azure identity variables exist. It does not disable TLS certificate
verification. Production uses one Strong Cosmos client and an owned HTTP agent,
10-second SDK requests/token acquisitions, no endpoint discovery/background refresh,
no multiple write locations and no throttling retries. Automatic regional failover
is deferred. GitHub requests and body reads share a 10-second deadline and 64 KiB
body cap, refuse redirects and do not silently retry OAuth exchanges.

## Runtime operations

Startup validates existing Cosmos metadata and sweeps expired device sessions
before binding. Validation, recovery and binding each have the configured startup
deadline; failure disposes acquired resources and exits nonzero. Exact
`GET /readyz` returns `{ status: 'ok' }` when startup and the latest recovery
succeeded, and generic 503 when recovery fails or the runtime drains. It does not
read storage on demand or continuously prove connectivity. Other methods, bodies
and queries are rejected. `GET /v1/health` is the unchanged strict liveness
response and performs no storage read, even when readiness is unhealthy.

One serial recovery loop waits the configured interval after each completed
sweep. Failure or timeout marks unready, emits only a constant event and retries
on the next interval; success restores readiness. Multiple processes may run
CAS-safe recovery, but sweep timing and readiness are process-local. Replicas,
scale-to-zero and stopped services can leave sweep gaps. Durable bound claims
remain until a running worker can clean them. TTL is separate from the validity
deadline and does not promise hard physical erasure, including backups.

SIGINT/SIGTERM share idempotent shutdown. The runtime stops listening, marks
unready, cancels and joins recovery, drains requests for the grace period, then
aborts remaining handlers/uploads, closes owned sockets and disposes SDK resources.
Cancellation and a generic 503 are not rollback: an already sent Cosmos write may
commit. Durable claims, CAS and retries after restart resolve uncertain writes.
OAuth exchange or identity-lookup failures consume the pending flow; start a fresh
sign-in rather than retaining a token to retry verification. Runtime events and
request diagnostics contain no credential/error payloads; the executable emits
only constant lifecycle events. Before loading Azure SDK modules, the executable
disables SDK logging by clearing `AZURE_LOG_LEVEL`, `TYPESPEC_RUNTIME_LOG_LEVEL`
and `DEBUG` for its process lifetime. Importing the launcher or embedding the
service leaves the caller's logging configuration unchanged.

Service quotas are in-memory per process: 10 device starts per socket peer IP per
hour and 60 requests per machine token per minute. Forwarded IP headers are not
trusted, so a reverse proxy's socket address shares the start quota. Restart resets
these quotas and replicas do not share them. GitHub's adapter cooldown is likewise
process-local; upstream throttling returns bounded `Retry-After`. These mechanisms
are not distributed abuse controls. The 100-revisions/setup/day quota is stored.

## Cosmos configuration

The embedder owns the SDK client, credentials and database lifecycle. Before serving,
run the read-only `validateCosmosConfiguration(database)`, then construct
`makeCosmosStore({ database, now?, pageSize?, maxSnapshotAttempts? })` and inject it
as `Store` into `makeService`. Validation does not provision or modify resources.
The containers must already have these settings:

| Container | Partition key | Default TTL |
| --- | --- | --- |
| `accounts` | `/accountId` | Disabled, or `-1` |
| `setups` | `/setupId` | Disabled, or `-1` |
| `identities` | `/id` | `-1`, enabled without default expiry |

Production validation requires an account configured for Strong consistency;
an SDK override cannot strengthen a weaker account default. [Microsoft consistency configuration](https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-manage-consistency).
All adapter reads request Strong and bypass the integrated cache. Account/setup reads
collect every query page between marker point reads and accept only matching ETags.
They retry the whole snapshot at most five times by default, then return generic
503. `pageSize` defaults to 100. Reads cover one partition; they do not provide a
global snapshot across partitions.

Account/setup batches reserve one operation for their marker and permit at most
99 distinct document targets. The adapter rejects serialized mutations or batch
operations above 1,800,000 bytes, leaving room for SDK serialization. Cosmos can
still reject a smaller request. Its documented limits are 100 operations, a 2 MB
request and five seconds of transaction execution. An atomic write is never split
to evade those limits. [Microsoft transactional batch documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch).

Account/setup physical IDs reversibly encode logical IDs with forbidden Cosmos
characters. Their opaque `__partition` markers contain only the partition ID,
closed flag and SDK metadata. Since `/id` makes each identity partition a singleton,
its document ETag is its CAS token; identity partitions have no extra marker.
Conditional updates with an old non-null token never initialize a missing session.
SDK failures are redacted; throttling preserves a rounded-up `Retry-After`.

## Partition boundaries and recovery

Every atomic commit targets one approved partition: `accounts/accountId`,
`setups/setupId` or `identities/id`. Store snapshots have opaque concurrency tokens
and a `closed` flag, and must contain all pages under a stable token. The memory
adapter reproduces CAS conflicts, ownership checks and the maximum 99 distinct document mutations.
The Cosmos adapter reserves its hundredth operation for the marker.
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

## Device expiry and retained recovery claims

Every device session's persisted `expiresAt` is the authoritative validity deadline,
at most 900 seconds and capped by the upstream deadline. The service rejects an
expired session even while its storage document remains. Unbound sessions, including
an exchange claimed without an account claim, receive
`ttl = max(1, ceil((expiresAt - now()) / 1000))` on every Cosmos write. Refreshing a
session preserves its deadline and writes the remaining seconds. Cosmos TTL uses
the server's last-write `_ts`, so clock skew, rounding and a write delayed after TTL
calculation can extend retention beyond `expiresAt`. [Microsoft TTL configuration](https://learn.microsoft.com/en-us/azure/cosmos-db/how-to-time-to-live).

Bound claims use `ttl = -1` until cleanup succeeds. Their temporary device code and
machine token hash are needed to recover an interrupted issuance. Numeric GitHub
identities, issuance fences and account/setup markers have no item TTL. Closed
account/setup markers retain exactly the previously approved opaque deletion fence.
No permanent credential retention is intended.

The Cosmos Store additionally exposes `sweepExpiredDevices(): Effect<void,
ServiceFailure>`. The executable calls it at startup and periodically through its
owned runtime. An embedder must supply its own scheduling when using the unlistened
core directly. A sweep collects candidate IDs
from every page of a cross-partition identities query before cleanup mutates rows.
It then point-reads each current session, checks the persisted deadline and CAS-writes
`state: 'expired'` while preserving the current claim. This fences paused claim
attachment and pending resets before machine cleanup. Account cleanup fences delayed
issuance, deletes matching machine/status records, and deletes the session. An active
account's reservation is removed only after session deletion succeeds. A deleting or
closed account keeps its frozen reservation index for account deletion. Recovery
never initializes an absent account or session.

Conflicts retry within a bounded budget. An interrupted sweep returns a generic
failure; rerunning it through a fresh adapter resumes stored expired claims. Multiple
workers may repeat recovery safely. The candidate scan is not a global snapshot;
sessions that expire or bind after it must be handled by another sweep. If the
embedder stops sweeping, bound credentials remain for recovery. TTL can erase an
unbound session during a paused flow before its claim attaches, which rejects that
old CAS. A pre-claim account reservation can then remain harmless until account
deletion, as the existing reservation contract allows.
An interruption after physical session deletion but before reservation removal can
also leave a harmless active-account reservation; no claim or credential remains,
and account deletion erases it.

Cosmos deletes TTL items asynchronously using available request units. Microsoft
documents immediate query invisibility after TTL expiry, while actual deletion may
be delayed by RU availability; there is no hard physical deletion deadline. Point
and query absence are API observations, not evidence of forensic disk or backup
erasure. The service deadline is separate from both. [Microsoft TTL semantics](https://learn.microsoft.com/en-us/azure/cosmos-db/time-to-live).

The memory adapter removes sessions through expiry recovery on a poll or an explicit
`recoverExpiredDeviceSession(store, key, now)` call. Otherwise they remain until the
Store is discarded. Successful sessions and account-deletion claims follow the
explicit deletion paths described above.

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
# Requires the explicitly configured local emulator.
npm run test:cosmos -w apps/service
```

Checks use an actual loopback HTTP listener, fake upstream GitHub, an injected
clock, isolated memory Stores and Store fault/barrier wrappers. They do not sign
in to production, install a native service or touch a person's home. Cloud Cosmos,
real OAuth, managed identity/RBAC, deployment and LIVE acceptance are unverified.

For the tested local vNext release, run a fresh task-owned container and volume.
The pinned image digest is EN20260907; all published ports are loopback and telemetry
and explorer are disabled. Choose unique names and unused ports for another task.
Do not change an existing container's settings or remove another task's volume.

```bash
docker volume create ncc-hosted-runtime-20261008-data
docker run -d --name ncc-hosted-runtime-20261008 \
  -p 127.0.0.1:18081:8081 -p 127.0.0.1:18080:8080 \
  -e ENABLE_TELEMETRY=false -e ENABLE_EXPLORER=false \
  -v ncc-hosted-runtime-20261008-data:/data \
  mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator@sha256:2db1f9e74c506bcf6fc347aa937aea1c00fa756061296a5a9efba530ce86ec02
curl --fail http://127.0.0.1:18080/ready
export NORTUSCC_COSMOS_EMULATOR_ENDPOINT=http://127.0.0.1:18081
export NORTUSCC_COSMOS_EMULATOR_KEY=bG9jYWwtZW11bGF0b3Itb25seQ==
npm run test:cosmos -w apps/service
```

Wait for the readiness endpoint before testing. The key above is a local dummy SDK
key, not an Azure credential. This command sets `NORTUSCC_COSMOS_REQUIRED=1`, fails
on missing configuration and must finish with zero skipped tests. The harness
creates and deletes only unique `nortuscc-test-*` databases; it leaves the owned
container/volume for the operator. No production resources are created. For local
executable startup, first create a local database with the exact containers above,
then set `NORTUSCC_SERVICE_LOCAL_EMULATOR=true`, `NORTUSCC_SERVICE_EMULATOR_KEY`
and the three required service variables. An actual executable sign-in still uses
GitHub; integration checks instead inject fake upstream transport.

Configured Cosmos checks use the actual local vNext emulator and fresh SDK clients
after service restart. They run the shared Store, authentication and metadata
recovery contracts, force multiple query pages, and observe TTL with wall time.
SDK doubles test boundary error mapping separately and are labeled unit checks.
The harness rejects remote endpoints before creating a client and provisions only
isolated task-owned databases. The dedicated emulator command fails if configuration
is missing; ordinary package checks explicitly skip emulator scenarios when absent.
Set `NORTUSCC_COSMOS_EMULATOR_ENDPOINT` to literal loopback HTTP/HTTPS and
`NORTUSCC_COSMOS_EMULATOR_KEY` to the emulator's local SDK key.

The tested EN20260907 image advertises Eventual consistency. The harness permits an
explicit `localEmulator: true` validation exemption only for loopback while retaining
Strong request headers. This is not evidence of cloud distributed consistency. Its
TTL worker runs on a five-minute background cycle; local query and point APIs can
retain expired items until that purge, unlike Microsoft's documented cloud query
visibility. Observation test budgets do not promise a retention deadline. vNext
does not enforce authentication or request-unit limits, and collection updates are
no-ops; these checks do not establish production authorization, RU behavior or
configuration migration. [Microsoft emulator documentation](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-linux).

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

`checks/cosmos-runtime.spec.ts` runs the complete existing three-client contracts
through `startServiceRuntime`, production Cosmos resources and the production
GitHub adapter with recording fake transport. It checks same-port restarts with
fresh SDK clients, owned idempotent disposal, startup claim recovery, periodic
failure/readiness/retry and strict liveness. Existing embedded-memory/direct-core
checks remain. These are LOCAL runtime integration results, not LIVE acceptance.
The natural TTL test retains its 360-second observation budget without changing
the emulator's five-minute worker.
