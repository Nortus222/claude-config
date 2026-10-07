# Nortuscc desktop

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

The desktop Node checks cover v3 schemas, renderer event ordering and recovery, lifecycle ownership and upgrades with fake Processes, and the login environment. `DESKTOP_AGENT_RESOURCES` enables the resource and smoke checks after bundling; without it these checks skip. `test:bun` runs schemas and controller checks under Bun, then enables the resource and smoke checks against the bundled Bun. Rust tests use fake Unix socket servers and helpers for handshake, framing, timeouts, disconnect and generation behavior.

`status` may answer `NO_REPORT` while startup is still inspecting; this remains connected, and a later status event loads the inspection. `UNAUTHORIZED` or a lost connection shows offline with Restart agent. Paused automatic apply remains visible and does not prevent a person applying. Cancel remains available when a reopened window sees active application; a refusal leaves activity visible until the agent reports idle.

Every JSON line is bounded to 1,048,576 bytes. Inspect/apply time out after 60 seconds, preview after 10, cancel after 30, and shutdown after 5. The shared `<stateRoot>/apply.lock` keeps the agent and standalone CLI from changing the machine together. An apply re-inspects and returns a replacement preview when the plan is stale.

The root test suite can modify `skills-manifest.txt`; inspect its diff after running. A successful native build does not establish that tests pass.

## Release package

```sh
npm run desktop:build -w apps/desktop
npm run smoke -w apps/desktop -- src-tauri/target/release/bundle/macos/Nortuscc.app
```

Resources are Bun, `agent.mjs`, `runtime.json` with the bundled agent version, and runtime licenses under `Contents/Resources/agent-runtime`. Runtime and build output are git-ignored. The version identifies the packaged bundle's contents rather than the installed setup checkout.

Both smoke modes create a compact temporary HOME with an inert local Git setup and bare origin. The fixture has no skills or integrations and applies only config. The agent starts in the foreground with an empty inherited PATH; a temporary login shell exposes only the fixture's Git wrapper. Checks exercise inspect, preview, apply and progress, a live cancel held at a deterministic Git gate, malformed and oversized records, strict unknown fields, unknown keys and plan ids, bad tokens, and a missing hello. Closing a client leaves the agent running. JavaScript sends shutdown, waits for exit, checks lock and socket cleanup, then removes HOME. Automated smoke checks also record their agent and native child PIDs outside HOME; independent fixture teardown stops and joins those owned children before deleting files if the smoke parent times out or an assertion fails.

Packaged mode uses Rust's `--smoke <temporary HOME>` without registering a login service or opening a window. That path refuses a HOME outside the canonical system temporary directory. After the native child exits, JavaScript reconnects and inspects to prove the agent survived, then owns its shutdown. No smoke should run with `NORTUSCC_SMOKE=1` or against the owner's real state root.

## Paths and manual verification

The agent resolves configuration from HOME, machine overrides and `state.json`'s recorded repository without a bundled-checkout fallback. The login shell environment supplies installer tools; its output and installer diagnostics stay off the helper's stdout and the socket protocol. Each job builds domains from its own verified snapshot, as ADR 0016 requires.

On a disposable machine, verify inspect, selection, preview, apply, cancellation, offline recovery and Restart agent. Close the window during apply and reconnect to the continuing service. Check relocation and an upgrade while a run is active. Real launchd behavior, notifications and GUI interaction need manual verification; socket fixtures and fake Processes do not exercise the OS service manager.
