# Claude Config desktop

The React renderer inspects, previews, applies and cancels through the local agent. The Tauri 2 Rust host connects to `<stateRoot>/agent/agent.sock`, reads `agent.token` fresh, authenticates with protocol v3 as `app`, and subscribes to status and progress events. Closing the window closes its connection and leaves the agent running.

The app ships a standalone Bun runtime and an agent bundle. A short-lived helper registers the per-user login service on first run, records `installedBy: 'app'`, and replaces its registration when the app moves or ships different agent code. Upgrades wait for idle status and a free shared apply lock, send `shutdown`, and restart through the service manager. Policy, pauses, trust, History and decisions persist. The renderer sends only opaque report keys and plan ids through Rust's fixed request allow-list.

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
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run smoke -w apps/desktop
npm run typecheck
npm run test:packages
npm test
```

The desktop Node checks cover v3 schemas, renderer event ordering and recovery, lifecycle ownership and upgrades with fake Processes, and the login environment. `DESKTOP_AGENT_RESOURCES` enables the resource and smoke checks after bundling; without it these checks skip. `test:bun` runs schemas and controller checks under Bun, then runs `test:resources` against a temporary bundled Bun fixture. Rust tests use fake Unix socket servers and helpers for handshake, framing, timeouts, disconnect and generation behavior.

On Windows and Linux, prepare temporary test resources independently of macOS release packaging:

```sh
npm test -w apps/desktop
npm run test:resources -w apps/desktop
```

`test:resources` bundles the agent into a temporary directory, copies the installed Bun runtime and license notices, records its version and the agent hash, and removes the fixture after the checks. It downloads the matching Bun license unless `DESKTOP_BUN_LICENSE` names a local copy; `DESKTOP_BUN_RUNTIME` can select a runtime. Windows runs the resource contents, hash and real `bun.exe --version` checks. Unix socket, POSIX shell and smoke checks report explicit Windows skips because those desktop behaviors are unsupported under ADR 0019. Lifecycle checks still use temporary state paths and fake service managers on Windows.

`status` may answer `NO_REPORT` while startup is still inspecting; this remains connected, and a later status event loads the inspection. `UNAUTHORIZED` or a lost connection shows offline with Restart agent. Paused automatic apply remains visible and does not prevent a person applying. Cancel remains available when a reopened window sees active application; a refusal leaves activity visible until the agent reports idle.

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

On a disposable machine, verify inspect, selection, preview, apply, cancellation, offline recovery and Restart agent. Close the window during apply and reconnect to the continuing service. Check relocation and an upgrade while a run is active. Real launchd behavior, notifications and GUI interaction need manual verification; socket fixtures and fake Processes do not exercise the OS service manager.

## Startup diagnostics

Normal macOS GUI startup writes local timings to
`~/Library/Logs/com.nortuscc.desktop/startup.log`. The foreground login service writes its
timings to the existing `<stateRoot>/agent/agent.log`, normally
`~/.config/nortuscc/agent/agent.log`. Fixed helper timings go to stderr; the native host
persists only recognized structured records from its setup, paths, ensure and restart helpers.
Maintenance-session stderr is still discarded; native `maintenance_state` timings cover the
total duration of that startup step. Release verification, hidden notification and packaged
smoke modes do not initialize the native log.

Lines beginning `[nortuscc-startup] ` contain schema version 1, a component, operation,
PID, run start timestamp, sequence, fixed phase/status names and monotonic milliseconds.
Group a process run by `(pid, startedAt)`. `elapsedMs` is time since that run's diagnostic
start; terminal phase records also include `durationMs` when the phase has a start record.
Native timings cover GUI setup, helper execution, maintenance checks, authenticated IPC
readiness and runtime identity. They measure native setup through agent connection, not
renderer paint or time before Tauri setup begins.

For a slow login probe, `shell_ready` measures reaching the first fixed marker after shell
startup; `environment_ready` measures the bundled runtime's environment capture after that
marker. `timed_out` followed by `login_probe: fallback` records the existing five-second
fallback. Captured shell output is limited to one MiB and is never logged. Agent phases
include lock acquisition, log rotation, service construction, scheduler/session creation,
IPC readiness and shutdown. `shutdown: started` followed by `ipc_closed: completed` without
`stopped` distinguishes a cleanup wait after IPC removal from never reaching IPC readiness.
IPC closure is reported only after successful initialization. No startup timeout is shortened
and these records do not establish the cause of an intermittent reboot failure.

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

The Rust host posts macOS notifications through UserNotifications under the installed app's identity. Ordinary startup requests permission; `--notify <id>` never prompts. Posting requires authorized notifications with alerts or Notification Center enabled. The OS add-request completion, rather than sending a socket event or launching the app, determines the delivery acknowledgment. The delegate stays retained before app launch finishes, presents foreground notifications, and routes a default click to the existing Review & apply view. A pending review request survives renderer startup; clicks refresh and focus that view without previewing or applying automatically.

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

The sidebar contains Overview, Review & apply, Resolved and Settings. Overview reads the current
agent status. Resolved shows inspected items and their available layer/source provenance.
Review keeps selection, stale replacement previews, progress, cancellation and reconnect behavior.
Notification clicks route to Review, refresh it and focus its heading without applying.
Browser preview shows empty real states with native actions disabled.

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
`package.json`, `Cargo.toml` and `tauri.conf.json`, and successful main runs of macos, linux,
windows and cosmos. It creates a temporary release overlay with the owner's public updater key,
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
validates the signed bundle's version, runtime target, maintenance protocol and agent hash.
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
