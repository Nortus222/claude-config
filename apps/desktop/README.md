# Claude Config desktop

The React renderer inspects, previews, applies and cancels through the local agent. The Tauri 2 Rust host connects to `<stateRoot>/agent/agent.sock`, reads `agent.token` fresh, authenticates with protocol v3 as `app`, and subscribes to status and progress events. Closing the window closes its connection and leaves the agent running.

The app ships a standalone Bun runtime and an agent bundle. A short-lived helper registers the per-user login service on first run, records `installedBy: 'app'`, and replaces its registration when the app moves or ships different agent code. Upgrades wait for idle status and a free shared apply lock, send `shutdown`, and restart through the service manager. Policy, pauses, trust, History and decisions persist. The renderer sends only opaque report keys and plan ids through Rust's fixed request allow-list.

## MCP connections

Install and configure the macOS arm64 app, then use Settings > MCP connections to connect
Claude Code or Codex. The app registers its own installed executable with the fixed `--mcp`
argument and maintains the owned registration and machine instruction block. Existing foreign
registrations or edited owned blocks require resolving the displayed conflict. Disconnect removes
only unchanged owned content; retry instruction cleanup when a registration is already absent.
Unrelated host configuration and instruction prose remain user-owned.

The hidden entry runs without a window and connects to the app-owned background agent. Closing
the app window or an MCP client leaves accepted runs executing. A configured standalone CLI agent
is insufficient. The entry derives resources from its installed app and resolves the configured
state root through the app's read-only login-environment helper. It never selects the current
project as its setup or uses a PATH runtime. Agent ownership, runtime identity and relocation are
checked on every invocation. Open the app to finish setup, repair ownership or restart its agent
when connection diagnostics request it. Pending app maintenance blocks mutations until the
app completes or recovers the update; MCP cannot repair that fence.

Registration and instruction status describe saved local configuration. The app cannot observe
whether a coding host has loaded it. Reload the host or start a new session after connecting,
relocating or upgrading the app, then inspect context in that session. App relocation repairs only
owned registrations through the app lifecycle. The installed app is required for upgrades and
maintenance; MCP is not a standalone engine or remote installation service. Other desktop
packaging targets are unvalidated, and Windows has no supported agent IPC.

The app exposes twenty-one machine operations:

| MCP tool | Behavior |
| --- | --- |
| `nortuscc_get_context` | App/agent identity, targets, account/setup prerequisites and capabilities |
| `nortuscc_resolve_skill_candidate` | Resolve a bounded exact selector or canonical name to a reviewed public GitHub source and revision |
| `nortuscc_agent_status` | Bounded status, pending, drift and conflicts |
| `nortuscc_list_backups` | Generated backup dates, IDs and latest History reference; exact retention cleanup uses preview/apply, at most 100 folders per batch |
| `nortuscc_account_state` | Account, setups and machine metadata with queued versus confirmed persistence |
| `nortuscc_inspect_setups` | Known setup identities and trust status |
| `nortuscc_incoming_changes` | Verified exact revision and incoming item identities, held and conflict flags |
| `nortuscc_prepare_trust_request` | Existing app repository trust action; grants no consent |
| `nortuscc_watch_sources` | Up to eight declared sources, including trusted configured checkout edits, with bounded observation continuation |
| `nortuscc_inspect_source_diff` | Exact revision diff or observed local skill diff selected by `localObservation`, with bounded text continuation |
| `nortuscc_pin_impact` | Source-wide read-only pin impact with resolved revisions |
| `nortuscc_draft_changelog` | Read-only draft with validated added and ignored selections |
| `nortuscc_inspect_updates` | Bounded source-qualified update offers, target/revision policy and precise legacy or verified addition repair route |
| `nortuscc_inspect_intent` | Effective owned values, provenance, enablement, required targets and source policy with bounded pages |
| `nortuscc_inspect` | Inspected items, drift, conflicts and reconcile keys |
| `nortuscc_preview_change` | Preview typed machine intent, selected reconciliation/update, author capture/source edits, config restoration, sync decisions, account/policy changes, backup pruning or a reviewed skill addition |
| `nortuscc_apply_change` | Apply a reviewed `planId` with a caller-chosen durable `requestId` |
| `nortuscc_get_run` | Recover a run's attributed intent, installation evidence, terminal outcome and follow-up prerequisites |
| `nortuscc_list_runs` | List retained runs with bounded pagination |
| `nortuscc_cancel_run` | Cancel an authorized run at a safe boundary |
| `nortuscc_history` | Read bounded safe decision, setup, revision, policy, pause and backup details with actor, request, scope and run attribution |

Every mutation uses the same preview, apply and durable run owner. Capture and selected manifest
updates bind the configured author checkout, HEAD and exact bytes; observation snapshots are never
author destinations. Source pins and ignores edit author documents and do not change machine
policy. Publication and standalone pull remain CLI workflows. General physical skill/integration
removal, selected-backup restoration, user pause, personal distribution and profile follow/promotion
require owners that are not available through MCP.

The connected app discovers accepted and changed runs through bounded run-ID notifications and
reads the current safe receipt through its existing controller. Changes shows a machine run's
progress, committed and remaining effects and recovery; Publish shows author runs. Device
sign-in success means initiation only. The controller treats a human challenge as current only
until its expiry; notifications never carry the code or URI. Metadata runs report local queueing separately
from confirmed hosted state. History uses the shared bounded projection with constant fallback for
unknown events and closed summaries for historical diagnostics.

Source reads use declared identities only. Public GitHub names stay readable; other declared URLs
and the trusted configured file checkout use stable opaque IDs. An extra local checkout requires
an existing owner/trust mapping. Source pages contain at most eight sources with two concurrent
readers. Cursors expire after ten minutes and invalidate after a conflicting observation or machine
inspection; pages do not promise an atomic snapshot of several remotes. Diff and changelog text
are bounded to 32 KiB. A limited or unavailable read never authorizes a source edit. Cleanup
uncertainty retains the source cache's ownership marker and refuses reuse until it is inspected.

Machine scope is the default. Review the preview before applying, retain the same `requestId`
when acceptance is uncertain, and query runs after reconnecting. Reconciliation repairs existing
declarations with their current consent, pin and installer rules. It saves no new declaration.
Machine intent sets or resets owned settings, targets and enablement, or removes an explicit machine skill declaration. It backs up and saves choices and releases owned routing for unmanaged targets; it does not run installers or delete skill content.
stdout contains MCP JSON-RPC records only; bounded results and stderr carry diagnostics.

Skill additions resolve a candidate, preview its exact machine declaration and revision policy,
then apply the reviewed plan. Select explicit required targets from setup context; the current
coding host is a default hint and grants no permission. Skills use the shared `~/.agents/skills`
store, which Codex also scans, even for Claude-only requests. Targets require usable exposure,
not exclusive visibility. The app does not change user-owned Codex enablement settings.

A verified installation requires accepted content integrity and effective native model-catalog
discovery for every selected target. Claude catalog evidence does not attest invocation
authorization or the selected source path; it covers the requested environment and managed
startup remains active. Disabled, restricted, missing, ambiguous or incomplete native evidence
cannot produce verified success. Supported installer mappings use the canonical home shared
store and absolute Claude/Codex config roots. Alternate shared stores and nonempty XDG lock
roots are refused before effects.

Saved intent and observed installation appear separately in the app and MCP run receipts.
When intent has been saved, a failed, cancelled or interrupted addition retains its declaration
for inspection and repair, without a success claim or sharing offer. Repair through resolve, preview `addSkill`, and apply;
generic legacy update/apply plans report a prerequisite for addition-touched entries so required
targets and source policy survive. Reconnects recover the same durable result; uncertain
acceptance retries retain the same caller-chosen `requestId`.

Only verified installation returns `share_with_my_machines` and `promote_to_profile` suggestions.
The coding agent should ask "Do you want to share it with your other machines?" and mention
promotion to an owned profile. Both actions report readiness, required destination and prerequisite
reason. They remain blocked until the personal sharing or profile publication workflow and its
destination are available. Ignoring a suggestion keeps machine scope; neither suggestion
authorizes publication or promotion. Each concerns only the accepted declaration.

Automated fixtures cover authenticated MCP preview/apply, arbitrary chat working directories,
lost-reply/reconnect retries, terminal outcomes and shared app result rendering with isolated
installer/catalog services. Scripted transport success does not establish natural-language model
routing. Actual Codex and Claude conversation checks require a disposable authorized installed-app
environment. This milestone does not claim those host/model checks or untested native/platform
combinations. The packaged MCP smoke checks inert reconciliation and connection recovery, not
native skill installation or model conversations.

The [checked engine inventory](../../packages/agent/src/operations/coverage.ts) maps every audited
behavior to the implemented operations or its remaining workstream. Source inspection, diffs,
pin impact and changelog drafts have bounded reads.
`previewChange(sourceDecision)` and `applyChange` support backed-up pin/unpin/ignore/unignore
edits in the configured author checkout. They bind fresh source revisions and exact dirty document,
HEAD and index evidence. Previews distinguish author intent from current machine policy and include
all affected declared skills. Ignore suppresses a source notification without disabling a skill.
A source that exists only as a machine addition needs an author declaration before author policy edits.
Account/policy/metadata operations, richer History and backup pruning remain pending. Author
commit/push, general restoration, personal sharing and owned-profile publication
require their owning workflows and separate authority. New registry operations and advertised
capabilities must update the checked inventory before claiming availability.

## Local setup

This package targets macOS arm64. It needs Node 24+, npm, Bun 1.3+, Rust, Xcode command line tools, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Other packaging targets are not validated. Windows agent IPC remains unsupported under ADR 0019.

The bundler accepts only a standalone Bun executable whose linked libraries are in macOS system directories. Obtain `LICENSE.md` from the matching `bun-v<version>` tag of [oven-sh/bun](https://github.com/oven-sh/bun) and set `DESKTOP_BUN_LICENSE`. Installed-app startup downloads no code.

```sh
npm ci
export DESKTOP_BUN_LICENSE=/absolute/path/bun-LICENSE.md
# Optional: export DESKTOP_BUN_RUNTIME=/absolute/path/standalone/bun
npm run desktop:dev -w apps/desktop
```

Development native startup manages the real login service and configuration unless HOME and all configuration overrides are isolated. For a safe browser preview, use `npm run dev -w apps/desktop`; native actions are disabled. Automated checks use temporary homes and fake service managers.

## Verification

```sh
npm run resources -w apps/desktop
DESKTOP_AGENT_RESOURCES="$PWD/apps/desktop/src-tauri/resources/darwin-arm64" npm test -w apps/desktop
npm run test:bun -w apps/desktop
npm run typecheck -w apps/desktop
cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run smoke -w apps/desktop
npm run typecheck
npm run test:packages
npm test
# After one normal local desktop build, use the finished app, without GUI/service startup:
app="$PWD/apps/desktop/src-tauri/target/release/bundle/macos/Nortuscc.app"
node apps/desktop/scripts/verify-runtime.mjs "$app" 0.1.6
npm run smoke -w apps/desktop -- "$app"
npm run smoke:mcp -w apps/desktop -- "$app"
```

The desktop Node checks cover v3 schemas, renderer event ordering and recovery, lifecycle ownership and upgrades with fake Processes, and the login environment. `DESKTOP_AGENT_RESOURCES` enables the resource and smoke checks after bundling; without it these checks skip. `test:bun` runs schemas and controller checks under Bun, then runs `test:resources` against a temporary bundled Bun fixture. Rust tests use fake Unix socket servers and helpers for handshake, framing, timeouts, disconnect and generation behavior.

Installed MCP acceptance uses the exact app's native `--mcp` entry and bundled foreground agent
with a temporary HOME, local Git origin and inert file copies. It verifies all eighteen tools, durable
acceptance/retry, disconnect recovery, MCP History attribution, terminal cancellation lookup and
unavailable-agent diagnostics, then joins its owned subprocesses before deleting the fixture. It installs no service
and opens no GUI. This smoke does not establish host reload, natural-language skill addition,
launchd behavior, signing/notarization or real updater installation. Resource generation must
finish before resource-consuming checks; build only after those checks finish.

On Windows and Linux, prepare temporary test resources independently of macOS release packaging:

```sh
npm test -w apps/desktop
npm run test:resources -w apps/desktop
```

`test:resources` bundles the agent into a temporary directory, copies the installed Bun runtime and license notices, records its version and independent Bun, agent and MCP hashes, and removes the fixture after the checks. It downloads the matching Bun license unless `DESKTOP_BUN_LICENSE` names a local copy; `DESKTOP_BUN_RUNTIME` can select a runtime. Windows runs the resource contents, hash and real `bun.exe --version` checks. Unix socket, POSIX shell and smoke checks report explicit Windows skips because those desktop behaviors are unsupported under ADR 0019. Lifecycle checks still use temporary state paths and fake service managers on Windows.

Unknown local setup displays **Opening Nortuscc**; first-run consent appears only after a validated setup-needed reply. Existing installations wait for genuine connection and initial reads. `status` may answer `NO_REPORT` before the first inspection; this remains connected with a waiting explanation and a read-only **Recheck agent status** action. A current report completes that wait, and an active apply exposes the existing Cancel control. Actual transport, setup and inspection failures remain visible with explicit recheck or Settings recovery; they are not treated as startup progress. Startup uses one focused loading card with confirmed Local setup, Agent connection and Local inspection milestones. Activity is indeterminate, announced politely and respects reduced motion. Updates remain available in a secondary disclosure independently of agent readiness; update activity, availability and retry open it automatically, while idle checks start compact. `UNAUTHORIZED` or a lost connection shows offline with Restart agent. Paused automatic apply remains visible and does not prevent a person applying. Cancel remains available when a reopened window sees active application; a refusal leaves activity visible until the agent reports idle.

Every JSON line is bounded to 1,048,576 bytes. Inspect/apply time out after 60 seconds, preview after 10, cancel after 30, and shutdown after 5. The shared `<stateRoot>/apply.lock` keeps the agent and standalone CLI from changing the machine together. An apply re-inspects and returns a replacement preview when the plan is stale.

The root test suite can modify `skills-manifest.txt`; inspect its diff after running. A successful native build does not establish that tests pass.

The `macos` CI workflow runs on macOS arm64 for pull requests and pushes to `main`. It prepares resources with Bun 1.3.14 and its matching license, runs the resource-enabled Node checks, Bun checks and locked Rust tests using the runner's installed toolchain, then builds the release app and runs the packaged temporary-HOME smoke. It does not open a window, register a service or post OS notifications.

## Release package

```sh
npm run desktop:build -w apps/desktop
npm run smoke -w apps/desktop -- src-tauri/target/release/bundle/macos/Nortuscc.app
```

Resources are Bun, `agent.mjs`, `runtime.json` with the app version, bundled agent hash and maintenance protocol, and runtime licenses under `Contents/Resources/agent-runtime`. Runtime and build output are git-ignored. The version identifies the packaged bundle's contents rather than the installed setup checkout.

Both smoke modes create a compact temporary HOME with an inert local Git setup and bare origin. The fixture has no skills or integrations and applies only config. The agent starts in the foreground with an empty inherited PATH; a temporary login shell exposes only the fixture's Git wrapper. Checks exercise inspect, preview, apply and progress, a live cancel held at a deterministic Git gate, malformed and oversized records, strict unknown fields, unknown keys and plan ids, bad tokens, and a missing hello. Closing a client leaves the agent running. JavaScript sends shutdown, waits for exit, checks lock and socket cleanup, then removes HOME. Automated smoke checks also record their agent and native child PIDs outside HOME; independent fixture teardown stops and joins those owned children before deleting files if the smoke parent times out or an assertion fails.

Packaged mode uses Rust's `--smoke <temporary HOME>` without registering a login service or opening a window. That path refuses a HOME outside the canonical system temporary directory. After the native child exits, JavaScript reconnects and inspects to prove the agent survived, then owns its shutdown. No smoke should run with `NORTUSCC_SMOKE=1` or against the owner's real state root.

## Paths and manual verification

The agent resolves configuration from HOME, machine overrides and `state.json`'s recorded repository without a bundled-checkout fallback. The login shell environment supplies installer tools; its output and installer diagnostics stay off the helper's stdout and the socket protocol. Each job builds domains from its own verified snapshot, as ADR 0016 requires.

Tauri setup creates the native owner and launches one owned startup worker before returning.
The window can show the existing checking state while machine and lifecycle commands await
validated readiness. Update commands await the coordinator's earlier milestone, after preferences
have been read from the validated state root; ordinary checks do not wait for agent connectivity.
Successful interrupted recovery publishes its first update snapshot after native health validation,
so startup reads the recovery result and can perform an eligible automatic check. Failed recovery
retains its diagnostic and permits explicit metadata checks without requiring an online agent.
No enabled provisional coordinator or inferred machine data is exposed during startup.

The worker invokes one fixed `--startup --app <absolute executable>` helper with bounded
native-owned `{appVersion}` input. The helper resolves the login environment once, keeps it private,
validates existing setup and maintenance, then uses the existing ensure or health-gated recovery.
It returns only the strict state root, setup, maintenance and fixed outcome. Native update preferences
use that root even if ensure fails; an invalid root disables updater initialization. Startup never
bootstraps a missing or failed setup. Native connects directly and validates the bundled runtime
identity. Closing signals cancellation to the helper, its login probe and native readiness retries;
waiting commands refuse and late publication is fenced. The owned worker is joined after the Tauri
event loop returns, outside UI callbacks. Closing leaves a successfully launched persistent agent
running. Forced kills and crashes can still bypass cleanup. The first renderer setup read consumes the initial display snapshot once; subsequent reads
are fresh, and restart, bootstrap or Git installation invalidate it. Explicit lifecycle actions retain
their existing helpers and locks. The read-only paths and setup-state helpers and native readiness
have 30-second outer deadlines, allowing the 15-second login-shell probe and bounded overhead to finish.
A successful probe remembers only its PATH, in the private file `agent/login-path` under the state
root; a later timeout or failure uses the app's environment with that PATH, and its message says which.

On a disposable machine, verify inspect, selection, preview, apply, cancellation, offline recovery and Restart agent. Close the window during apply and reconnect to the continuing service. Check relocation and an upgrade while a run is active. Real launchd behavior, notifications and GUI interaction need manual verification; socket fixtures and fake Processes do not exercise the OS service manager.

## Startup diagnostics

Normal macOS GUI startup writes local timings to
`~/Library/Logs/com.nortuscc.desktop/startup.log`. The foreground login service writes its
timings to the existing `<stateRoot>/agent/agent.log`, normally
`~/.config/nortuscc/agent/agent.log`. Fixed helper timings go to stderr; the native host
persists only recognized structured records from its startup, setup, paths, ensure and restart helpers.
Maintenance-session stderr is still discarded; native `maintenance_state` timings cover the
total duration of that startup step. Release verification, hidden notification and packaged
smoke modes do not initialize the native log.

Lines beginning `[nortuscc-startup] ` contain schema version 1, a component, operation,
PID, run start timestamp, sequence, fixed phase/status names and monotonic milliseconds.
Group a process run by `(pid, startedAt)`. `elapsedMs` is time since that run's diagnostic
start; terminal phase records also include `durationMs` when the phase has a start record.
Native timings distinguish `app_setup`, which returns after scheduling, from `startup_worker`,
which includes helper execution and authenticated agent readiness. `runtime_ready` records Tauri's
Ready event. It does not prove renderer paint. Maintenance and runtime-identity timings remain;
time before Tauri setup and the first JavaScript instruction is not measured.

The bundled entry records `module_load` before dynamically evaluating its implementation, then
passes the same trace into the helper or foreground agent. It remains one hashed `agent.mjs` resource.
This phase measures module evaluation after the first JavaScript instruction; it cannot attribute
OS/runtime delay before that instruction or prove that cold-start delay has been eliminated.

For a slow login probe, `shell_ready` measures reaching the first fixed marker after shell
startup; `environment_ready` measures the bundled runtime's environment capture after that
marker. `timed_out` followed by `login_probe: fallback` records the 15-second
fallback. Captured shell output is limited to one MiB and is never logged. Agent phases
include lock acquisition, log rotation, service construction, scheduler/session creation,
IPC readiness and shutdown. `shutdown: started` followed by `ipc_closed: completed` without
`stopped` distinguishes a cleanup wait after IPC removal from never reaching IPC readiness.
IPC closure is reported only after successful initialization. No startup timeout is shortened
and these records do not establish the cause of an intermittent reboot failure.

`running: started` means IPC is accepting requests. The separate `first_job` phase measures
the initial scheduled job through its first returned status, including any fetch, inspection
and policy-controlled apply. It records `failed` when that status reports a job error and
`cancelled` when the request is interrupted. Completion does not prove every item is healthy;
the genuine status and inspection carry those outcomes. This timing does not change scheduling
or make native runtime health wait for the initial job.

Structured records accept only fixed enums and safe integers, excluding environment values,
tokens, paths, URLs and arbitrary error text. Existing unstructured agent diagnostics retain
their prior behavior; review them for credentials before sharing. Native logging uses a
bounded nonblocking queue, private directory/file permissions, and a nonblocking exclusive
file lock. Unsafe or unwritable storage, a full queue, or another GUI writer can drop records
without blocking startup. The native active file stays within one MiB and retains three
backups before truncation; the agent retains its existing one-MiB periodic rotation and
three archives, which can grow beyond the threshold between checks. Abrupt termination can
lose queued records. No logs are uploaded automatically.

## Agent notifications

The Rust host posts macOS notifications through UserNotifications under the installed app's identity. Ordinary startup requests permission; `--notify <id>` never prompts. Posting requires authorized notifications with alerts or Notification Center enabled. The OS add-request completion, rather than sending a socket event or launching the app, determines the delivery acknowledgment. The delegate stays retained before app launch finishes, presents foreground notifications, and routes a default click to the Changes screen (Home when the agent reports an error or pause). A pending review request survives renderer startup; clicks refresh the inspection without previewing or applying automatically.

Hidden delivery branches before Tauri creates a window. Its fixed `--paths` helper resolves the same configured state root without registering or restarting the service. It reads the current token, authenticates as an app without subscribing, fetches the exact id and active receipt, posts, acknowledges and exits. Invalid ids, expired receipts and malformed payloads fail closed. Unbundled executables decline native posting. Native posting on non-macOS platforms returns unavailable so the agent can try Linux `notify-send`; packaging remains macOS arm64 only.

Native work has a three-second budget from event enqueue or hidden-mode entry, including authorization settings and submission, followed by a bounded acknowledgment. The agent allows five seconds for each connected app's receipt and tries a fixed snapshot of subscribers sequentially. The total delivery deadline allows those per-app budgets plus five seconds for scheduling and cleanup. Late native completions cannot acknowledge an expired generation. OS acceptance followed by a lost acknowledgment can still cause a later repeat; acceptance does not prove a banner appeared.

Rust checks exercise fake posting success/refusal, strict payloads, direct hidden connections, the read-only helper, startup events before session publication, off-reader acknowledgments, stale generations and queued clicks. They never initialize the notification center or show a window. On a disposable macOS machine, manually verify permission grant/denial, Notification Center with banners disabled, foreground presentation, warm and cold clicks, hidden posting with the app closed, no permission dialog in hidden mode, and exit after posting. Also verify the hidden path leaves service registration and machine state unchanged. These OS behaviors are not established by automated tests or a successful native build.

The bundled foreground agent uses the reviewed public hosted API root by default, with
`NORTUSCC_HOSTED_URL` in its login environment overriding it. Custom roots must be HTTPS
and end in `/v1`; invalid overrides remain visible as configuration errors.
Account/device-flow, setup trust and machine-reporting commands use the existing agent IPC through
fixed native commands. Native arguments accept public display names, policies, booleans and opaque
setup IDs, with unknown fields and renderer paths, commands or URLs rejected. Account credentials
remain agent/keychain-owned. The renderer exposes these controls in Settings.
See the [agent README](../../packages/agent/README.md#optional-hosted-client).

### First-run helper

The fixed bundled helper supports `--setup-state`, `--bootstrap --app <absolute native executable>`
(with a strict `{ "configTargets": ["claude", "codex"] }` stdin record, maximum 4096 bytes), and
`--install-git`. Read-only state checks never invoke Apple's Git shim or open an installer. The
explicit installer action invokes only `xcode-select --install`; finish Apple's dialog before rechecking.
Bootstrap clones the fixed public Nortus222/claude-config repository into an exclusively owned state
subdirectory, validates its origin and profile, and records choices with backups under the shared
apply lock. It leaves configuration unchanged and preserves the clone if subsequent agent registration
fails. The native app runs its existing ensure helper after bootstrap. Existing or corrupt recorded
setups are never silently replaced.

The whole bootstrap has a 110-second cancellation deadline, beginning before login probing and
prerequisite checks. This leaves cleanup time before the native 120-second timeout. If that outer
timeout fires, native sends SIGTERM and waits up to five seconds for the helper to cancel and join
its detached Git child, remove its owned incomplete directory, and release the lock before killing
the helper group. Ensure/restart retain their existing timeout behavior. A forced kill or OS crash
can bypass finalizers and leave an incomplete directory or detached child; the dead-owner lock is
recoverable on retry, but cleanup after a crash is not guaranteed.

Desktop foreground agents use the public hosted API root when `NORTUSCC_HOSTED_URL` is absent.
Explicit URL overrides, including invalid values, retain their meaning. Set the desktop-only
`NORTUSCC_DESKTOP_LOCAL_ONLY=1` to create no hosted client; any other defined value is rejected.
CLI defaults remain local-only. Resource tests and packaged smoke set this explicitly because a
temporary HOME does not isolate the OS keychain. Pure setup schemas live in `shared/setup-protocol.ts`.

The native first-run bridge exposes `desktop_setup_state`, `setup_desktop`, and `install_git`.
Startup checks setup state before invoking ensure; new or corrupt setups wait for the first-run flow.
`setup_desktop` bootstraps then ensures in one lifecycle reservation and returns the current hello
with its generation. Account commands are `hosted_state`, `sign_in`, `sign_out`, `sync_now`,
`trust_setup`, `machine_settings`, `set_policy`, and `resume_agent`. `open_device_login` opens only
`https://github.com/login/device` after an explicit action. All results use the normal generation/data
wrapper. New command argument records are strict and bounded to 4096 bytes; helper output is one
strict JSON line under the existing one MiB framing limit. Helper timeouts stop their owned process
group and join their pipe readers before returning.

`sign_in` accepts optional local `reportStatus`, which never enters the HTTP device-start body.
An explicit choice is saved in the durable machine outbox before credentials and job completion.
A reporting-off patch survives invalid PATCH responses and acknowledgements still reporting true,
so interrupted sign-in or restart cannot issue a first status upload before false is acknowledged.
Omitting the choice preserves the CLI behavior. Native display-name Unicode predicates are generated
without dependencies using `node apps/desktop/scripts/display-name-categories.mjs` on Unicode17.0,
such as Node24.19. The parity check verifies every code point against the shared predicates; deliberate
Unicode contract updates should regenerate the table and review shared/native compatibility together.


## Desktop screens

The renderer starts with a read-only setup check before it requires an agent connection.
New installations show the fixed setup repository and Claude, Codex, both or neither choices.
Missing Git exposes an explicit Apple installer request and recheck. Bootstrap retries preserve
completed native-owned checkouts; existing recorded setups are inspected without bootstrap.
Setup prepares the agent and does not apply configuration changes.

The sidebar, under the Nortuscc brand, groups THIS MAC (Home, Changes, Skills) and MY PROFILES
(Profiles, Upstreams, Publish), then Settings. Badges count undecided incoming changes on Changes and
unpublished drafts on Publish, and flag an app update on Settings. Home names what this Mac follows
and what needs attention, each line with its next action. Changes holds the one preview and Apply for
incoming changes, this Mac's own items (a durable `reconcile`) and profile switches; its Details keep
layer/source provenance. Item notifications open Changes and agent failures open Home, without
applying. A lost connection or failed inspection shows one banner above every screen with Reconnect
or Check again. Browser preview shows empty real states with native actions disabled.

Settings offers optional GitHub Device Flow and defaults status sharing off before sign-in.
The code lives only in renderer memory. Open GitHub is an explicit fixed native action.
Pending-state reads use bounded injected timers, independently of the service sync cadence.
Expiry clears the code and reads authoritative account state; only explicit Cancel or Sign out
revokes credentials. Serial account operations fence replies and timers on sign-out, account
change, disconnect, restart and disposal. Strict decoding failures use generic bounded errors.

Machine name/reporting updates acknowledge queued local changes rather than claiming server
persistence. Policy updates keep any automatic-apply pause until explicit Resume. Offered setup
repositories require separate unchecked consent before sending an opaque setup ID for trust;
account membership supplies no trust badge. Sync displays returned freshness, errors and retry time.
Authoring, fleet, restoration, publishing and discovery remain unfinished.

Controller checks use fake Bridge implementations and injected clocks. Rendered-view fixtures
use the existing React server renderer with tsx. These tests do not establish actual macOS
installer dialogs, service registration, browser/device authorization, notification behavior or
native GUI interaction. Release/resource checks and packaged smoke remain separate verification.

## Signed stable desktop releases

The manual `desktop-release` workflow targets only macOS arm64. The owner dispatches it from
`main` with its exact reviewed SHA, stable version and plain release notes. By default it validates
the signed distribution and retains workflow artifacts without publishing. Selecting `publish`
on that manual dispatch is the release approval. The workflow checks the repository, current main SHA, matching versions in
`package.json`, `Cargo.toml` and `tauri.conf.json`, and successful main runs of macos, linux
and windows. It creates a temporary release overlay with the owner's public updater key,
the fixed stable endpoint and `requireSignedVersion: true`. Ordinary builds remain unconfigured
for updates and do not use signing secrets.

Before dispatch, the owner must supply repository variable `DESKTOP_UPDATER_PUBLIC_KEY` as the
base64-encoded minisign public-key file and `DESKTOP_APPLE_SIGNING_IDENTITY` as a Developer ID
Application identity. Required repository secrets are `DESKTOP_UPDATER_PRIVATE_KEY`, its optional
`DESKTOP_UPDATER_PRIVATE_KEY_PASSWORD`, `DESKTOP_APPLE_CERTIFICATE` as base64 PKCS#12,
`DESKTOP_APPLE_CERTIFICATE_PASSWORD`, `DESKTOP_APPLE_API_KEY_ID`, `DESKTOP_APPLE_API_ISSUER`
and `DESKTOP_APPLE_API_PRIVATE_KEY`. No key is generated by this workflow. Key custody and rotation
remain owner decisions. The committed Bun entitlements permit only `allow-jit`, as described in
[release prerequisites](release/README.md). A copied runtime passed Developer ID, hardened-runtime,
secure-timestamp, JIT and desktop pure-suite checks; whole-app distribution still needs a successful
validation workflow run.

The preparation job has read-only repository permissions. It signs the nested Bun executable before Tauri signs the app, requires
notarization and stapled tickets for the app and DMG, checks Gatekeeper and arm64 binaries, and
validates the finished app and extracted updater payload's version, runtime target, maintenance
protocol and independent Bun, agent and MCP hashes. The Bun hash is refreshed only after explicit
inner signing and before outer bundling; signed artifacts are never patched.
The final native verifier checks the archive signature against the configured public key and
its authenticated version. Tauri CLI's signing-key warning is insufficient. The publication job
rechecks transferred hashes and signatures before using its only write permission, `contents: write`.
Neither job has OIDC, package or cloud permissions.

`desktop-v<version>` owns immutable `Nortuscc.app.tar.gz`, its `.sig`, and the versioned arm64 DMG.
An existing versioned tag or release, including an interrupted draft, stops publication and requires owner
inspection; the workflow never deletes or overwrites its assets. Only `latest.json` belongs to the
separate `desktop-stable-channel` release. Both releases use `make_latest: false`, so they do not
change GitHub's latest source release. The stable channel must advance to a newer stable version. Updating it replaces its single metadata asset;
GitHub provides no atomic asset replacement, so a brief missing pointer is a retryable check failure.

The validation workflow does not establish real signed N-to-N+1 installation, launchd handoff,
interrupted-update recovery or machine-state preservation. Those remain separate OS acceptance
checks; a successful build or packaged smoke is insufficient. No release, Apple registration or
production key generation is performed by ordinary PR/merge execution or local tests.

Checks and downloads do not require hosted login or a working agent connection. Installation in
this initial release requires a valid existing app-owned setup and service registration. A new,
CLI-owned or corrupt setup stops maintenance with a diagnostic; updates never silently bootstrap
or take ownership of it. Complete the explicit first-run setup before installing an update.

Settings and first-run screens show installed/available versions, plain release notes, bounded
automatic checks, download progress and explicit Install and restart. Downloads are verified and
retained by Rust while the app and agent continue operating. Installation waits for active applies,
backs up the bundle and service state, and holds the shared apply and app-install locks through
replacement. A durable pending journal fences machine changes after interruption. Recovery requires
an intact expected bundle and fresh protocol/runtime health before clearing pending. An installing
journal also refuses recovery while the native installer PID lives or liveness cannot be proved;
PID reuse can conservatively require owner inspection. Recovery retains backups and machine state
without promising automatic app rollback or crash-proof cleanup.
