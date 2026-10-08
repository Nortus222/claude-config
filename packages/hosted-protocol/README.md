# Hosted protocol

`@nortuscc/hosted-protocol` defines the HTTP v1 metadata contract under `/v1`.
It contains Effect schemas, inferred TypeScript types, strict decoders, item and
repository identity helpers, and sync query helpers. It depends only on pinned
Effect and has no build step. It does not access a machine, make HTTP requests,
authenticate tokens, store data, implement an outbox, or project local agent status.
Hosted HTTP v1 is separate from the local IPC protocol and its version envelope.
Strict unknown-field rejection means incompatible wire changes require an API
version change or an explicitly coordinated compatible rollout.

Use `decodeHosted(schema, value)` for incoming JSON responses and
`decodeRequestBody(schema, value)` for request bodies. Both reject unknown fields
recursively and return generic errors without rejected values or causes. The
request decoder checks the UTF-8 size of the serialized JSON value. The HTTP server
must also enforce 128 KiB on the original received bytes before parsing JSON. A
serialized value cannot recover discarded whitespace or duplicate JSON object keys.
Responses have no overall request-size cap.

## Values and limits

IDs contain 1..100 ASCII letters, digits or hyphens; `local` is reserved. Revision
numbers are positive safe integers. Sequence numbers, revision cursors, drift counts
and `revisionApplied` are nonnegative safe integers. Timestamps require a timezone
and a valid ISO calendar datetime. Policies are `auto-apply`, `notify`, `manual`;
OS families are `macos`, `linux`, `windows`; agent kinds are `claude`, `codex`.
Agent arrays are unique subsets and may be empty before an agent is configured.
Display names contain 1..100 Unicode characters with visible text, without controls,
line separators or surrounding whitespace.

Commit hashes are lowercase full SHA-1 or SHA-256. Tags follow Git ref-name
restrictions, exclude `refs/` names and leading `-`, and name tags rather than
branches. Environment names are identifiers, never values. Item IDs use the
`setting`, `skill`, `integration` or `file` prefix and 1..200 allowed suffix
characters `[A-Za-z0-9._:/#@-]`, plus the logical structure checked by `parseItemId`.
For example, `setting:claude:settings.json#effortLevel`,
`skill:Nortus222/agent-skills/explain`, `integration:superpowers-codex`, and
`file:claude:CLAUDE.md`.

`RepoUrlSchema` permits credential-free HTTPS, SSH with an optional `git` user,
SCP-style `git@host:path`, and normalized host/path references. It rejects local
paths, traversal, credentials, queries and fragments. Decoding never rewrites the
reference. `normalizeRepoUrl` remains a comparison helper compatible with inert
local Git fixtures. It grants no permission to fetch a repository.

| Export | Limit |
| --- | --- |
| `MAX_MACHINES` | 25 per account |
| `MAX_SETUPS` | 10 per account and sync query |
| `MAX_ITEMS` | 500 per revision |
| `MAX_DECISIONS` | 500 per decision request and corresponding response |
| `MAX_REVISIONS` | 50 per revision-list page, never a sync limit |
| `MAX_CHANGELOG_BYTES` | 16 KiB UTF-8 |
| `MAX_REVISION_BYTES` | 64 KiB encoded JSON per full revision record |
| `MAX_REQUEST_BODY_BYTES` | 128 KiB encoded JSON per request |

The service also enforces the source design's operational limits of 100 revisions
per setup per day, 60 requests per machine token per minute, and 10 device starts
per IP per hour. Those require service state; schemas cannot enforce them.
`utf8ByteLength` and `jsonByteLength` measure byte limits without machine access.

## Body shapes and responses

Each named schema has a corresponding inferred type with the `Schema` suffix
removed. Objects are exact shapes, including nested objects. These are explicit
wire projections, not storage documents. No document `type`, storage `version`,
token hash or speculative visibility field belongs in them. Setups are private in
this phase.

| Schema | Shape | Endpoint response |
| --- | --- | --- |
| `HealthResponseSchema` | `{ status: 'ok' }` | `200` from `GET /health`, no data reads |
| `DeviceStartRequestSchema` | `{ name, os, agents }` | Request to `POST /auth/device/start` |
| `DeviceStartResponseSchema` | `{ pendingId, userCode, verificationUri, interval, expiresIn }` | `200`, successful device start |
| `DevicePollRequestSchema` | `{ pendingId }` | Request to `POST /auth/device/poll` |
| `DevicePollPendingSchema` | `{ interval }` | `202`, authorization pending or slow down |
| `DevicePollSuccessSchema` | `{ accountId, login, machineId, token, defaultPolicy }` | `200`, signed in |
| `SetupRegistrationSchema` | `{ name, repoUrl }` | Request to `POST /setups` |
| `SetupRecordSchema` | `{ setupId, name, repoUrl, latestRevision, createdAt }` | `201`, successful setup registration |
| `SetupsResponseSchema` | `{ setups: SetupRecord[] }` | `200` from `GET /setups` |
| `RevisionPublicationSchema` | `{ number, commitSha, tag, changelog, items, requiredEnv }` | Request to `POST /setups/:id/revisions` |
| `RevisionRecordSchema` | Publication fields plus `{ setupId, publishedAt, machineId }` | `201`, successful revision publication |
| `RevisionsResponseSchema` | `{ revisions: RevisionRecord[], nextAfter }` | `200` from `GET /setups/:id/revisions?after=<n>` |
| `DecisionsRequestSchema` | `{ decisions: Decision[] }` | Request to `PUT /decisions` |
| `DecisionsResponseSchema` | `{ seq, results: DecisionResult[] }` | `200`, successful decision write |
| `MachinePatchSchema` | Any nonempty subset of `{ name, policy, reportStatus }` | Request to `PATCH /machines/:id` |
| `MachineRecordSchema` | `{ machineId, name, os, agents, policy, reportStatus, createdAt, lastSeenAt, status }` | `200`, successful machine patch |
| `MachinesResponseSchema` | `{ machines: MachineRecord[] }` | `200` from `GET /machines` |
| `SyncResponseSchema` | `{ seq, decisions, revisions, machine, setups, pollAfter }` | `200` from `GET /sync` |
| `StatusSummarySchema` | `{ reportedAt, policy, agents, setups, drift }` | Request to `PUT /machines/self/status` |
| `AccountExportSchema` | `{ account, machines, setups, revisions, decisions }` | `200` from `GET /account/export` |
| `ErrorResponseSchema` | `{ error, message }` | Non-success error body |

The source designs leave several success statuses unspecified. This foundation
sets `200` for device start, reads, decision writes and machine patches, and `201`
for setup and revision creation. These are explicit contract refinements for the
later service and client.

Device-start intervals and expiry durations are positive safe integer seconds.
`userCode` is uppercase ASCII letters/digits/hyphens, 1..100 characters;
`verificationUri` is the credential-free HTTPS GitHub `/login/device` URL.
`MachineTokenSchema` requires `nmt_<accountId>_<machineId>_<secret>`, with a
43-character base64url secret. Consumers treat it as opaque. Sign-in success checks
that both embedded IDs match the response IDs. No upstream OAuth token or device
code may appear in these bodies. The account's default policy is `notify`; the
success body's `defaultPolicy` initializes a new machine, while an existing local
person-chosen policy wins.

Setup and machine lists have unique IDs. `latestRevision` may be zero before the
first publication. A revision item, `RevisionItemSchema`, is `{ id, kind, change }`.
`change` is `added`, `changed` or `removed`; its kind must agree with its ID. Items
are unique by ID, and `requiredEnv` names are unique. Items contain no values or
digests. Revision publication describes the diff from the previous published
revision, with the first compared against empty. The publication request's route
supplies its setup ID; the returned full record includes that ID. Byte limits cover
full records, including publication metadata and setup ID. Publication and sync
projections also enforce the 64 KiB ceiling. Revision pages are oldest first for
one setup, without duplicate numbers. `nextAfter` is the final returned number
when another page remains and `null` on the last page. An empty page has
`nextAfter: null`.

`DecisionSchema` is `{ setupId, itemId, revision, decision }`, with `accept` or
`skip`. `DecisionResultSchema` is `{ setupId, itemId, outcome }`, with `stored`,
`stale` or `unprocessed`. Requests and results contain 1..500 entries. Duplicate
setup/item keys are allowed, preserving offline accept/skip reversals in order.
`unprocessed` results must form a suffix. `decodeDecisionsResponse(request, value)`
checks one result per sent entry in exactly the sent setup/item order, including
duplicates. A client may remove `stored` and `stale` entries only after this check.
Malformed, missing or reordered responses preserve the batch for reconciliation.
This helper does not implement retry or removal. Because results carry only the
setup/item key, entries with identical keys are correlated by their array position.

A machine record's `status` is a `StatusSummary` or `null`. Reporting is owner-only
and defaults to `reportStatus: true`. Setting it to false deletes the stored
summary, so a machine with reporting disabled must return `status: null`. Decision
sync continues. Team sharing requires a separate future opt-in. Local-only mode
keeps working without an account.

Status writes, sign-out, machine deletion and account deletion return `204` without
a JSON body. Conditional sync returns `304` without a body. There is no schema for
either empty body. Health uses the minimal `HealthResponseSchema`. `AccountExportSchema` contains
account identity and public metadata records. Its account object is exactly
`{ accountId, githubId, login, seq, defaultPolicy, createdAt }`, with a positive
safe numeric GitHub ID and `defaultPolicy: notify`. Machines include enabled
status summaries. Revision and decision export arrays contain all records without
a revision-page cap. Export excludes hashes, device sessions, claims, issuance
fences, account reservations and concurrency markers; storage documents must
never be decoded or spread directly into this projection.

## Sync query and complete response

`SyncQuerySchema` is `{ since, setups: SetupCursor[] }`; each `SetupCursorSchema`
is `{ setupId, revision }`. `parseSyncQuery(URLSearchParams)` accepts only `since`
and `setups=<id>:<revision>,...`, each at most once. It rejects malformed/unsafe
integers, unknown fields, duplicate setup IDs and more than ten cursors. Missing
`since` defaults to zero; missing or empty `setups` defaults to an empty array.
`formatSyncQuery(query)` returns `URLSearchParams`, sorts opaque setup IDs by
ASCII/code-unit order, writes `since`, and omits empty `setups`. Parsing preserves
input order; formatting does not mutate it.

The source design's slimmer sync projections are deliberate:

- `SyncedDecisionSchema` adds `decidedAt` and `machineId` to decision fields. It
  excludes local `source`, commit IDs and local decision bookkeeping. Keys are
  unique in the authoritative response.
- `SyncRevisionSchema` adds `setupId` to publication fields, without requiring
  `publishedAt` or publisher `machineId`.
- `SyncMachineSchema` contains only `{ policy, reportStatus }`. It contains no
  default policy or trust.
- `SyncSetupSchema` contains only `{ setupId, name, repoUrl, latestRevision }`.

Sync revisions are ordered oldest first within each setup, without duplicates.
Revisions and decisions must reference a returned setup and cannot exceed its
advertised latest revision. `pollAfter` is a positive safe integer duration in
seconds; its service default is 900, with client jitter of +/-20%.

V1 sync is complete, not a paginated feed. It delivers every revision after each
supplied setup cursor, including more than 50 records. A client durably stores the
contiguous record range before advancing its setup cursor to `latestRevision`.
Truncated or incomplete responses must not advance that cursor. The schema alone
cannot prove query-relative completeness. A future paginated sync needs an explicit
delivered cursor and cannot silently cap v1 responses. Account `seq` and per-setup
revision cursors are separate checkpoints.

## Status privacy and adoption

`SetupStatusSchema` is `{ setupId, revisionApplied, adopted, skipped, pending,
waitingForPerson }`. Each list contains item IDs. All four lists are individually
unique and mutually disjoint, and linked setup IDs are unique. `DriftCountsSchema`
is `{ setting, skill, integration, file }`, counts only. `revisionApplied` is zero
before the first successful hosted baseline, then the latest successfully recorded
baseline. It does not claim every change was adopted; the lists describe adoption.

`pending` is permitted only under `auto-apply`, for inert, unpaused items that will
apply without a person. Notify/manual policy, pause, or classifier holds map to
`waitingForPerson`. This follows the source design's explanatory rules and the
local-agent status table. Its illustrative notify-policy JSON with a nonempty
pending list is inconsistent with those rules. The shared schema follows the rules.
The schema can check policy but cannot infer pause or classifier state. The client
must report after reinspection instead of treating pre-apply `AgentStatus.pending`
as adoption.

The 500-item revision limit does not cap cumulative status lists. IDs may span many
revisions. If a complete summary exceeds the 128 KiB request limit, the client
must decline that upload locally and keep local operation working. It must not
truncate the adoption lists. The previous hosted summary remains visibly dated by
`reportedAt`; richer overflow reporting is deferred until needed.

No extra local keys, paths, file contents, setting/environment values, hashes,
reasons, errors, commands or trust flags belong in status or revision metadata.
Freeform names and changelogs are user-authored metadata, never automatically
captured diagnostics.

## Error statuses and checks outside the package

`ErrorCodeSchema` is closed over `ERROR_CODES`. `ERROR_STATUS` maps those codes:

| Error code | HTTP status |
| --- | --- |
| `unauthenticated` | 401 |
| `not_allowlisted`, `forbidden` | 403 |
| `not_found` | 404 |
| `invalid` | 400 |
| `payload_too_large` | 413 |
| `revision_conflict`, `status_disabled`, `limit_reached` | 409 |
| `sign_in_expired` | 410 |
| `rate_limited` | 429 with `Retry-After` |
| `unavailable` | 503 with `Retry-After` |

The service must authenticate tokens, derive account identity from authentication,
check hosted resource ownership, and enforce account/rate limits. Another
account's resource returns `not_found`, never `forbidden`. Publication requires
`number === latestRevision + 1`. Decision items must exist in the named revision.
Status items must belong to the setup's revision history, including removed items.
These checks require service data and are separate from structural validation.

The client accesses repositories and fetches each tag using its own Git credentials,
verifies tag-to-SHA agreement, and recomputes revision items before applying. The
service never reads Git or holds private repository credentials. Repository
normalization and a valid schema do not prove content integrity or local trust.

Decision revisions older than stored ones are stale. Otherwise service arrival
order wins, including equal-revision accept/skip reversals. Decisions carry forward
when a later revision leaves the item unchanged; a later item change needs a new
decision. The hosted client must adapt the local timestamp replacement rule to
this authoritative ordering. A partial processing failure leaves an unprocessed
suffix so retry cannot move an older decision after a later successful one.
