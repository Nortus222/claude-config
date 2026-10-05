# Tauri validation app

## Intent and scope

Validate the desktop architecture approved in PR #38 and the follow-up conversation before migrating the CLI. This is an experimental app, not a production configuration manager. It must inspect a fixture profile, distinguish inherited values from machine overrides, show a proposed diff, and run a harmless operation with progress and cancellation. Package it with its own Node runtime, verify restart after backend failure and shutdown cleanup, and measure the complete package.

## Architecture

Keep the zero-dependency Node 18+ CLI unchanged. Put the experiment in `apps/desktop`, with an independent package manifest and lockfile. React and TypeScript render the dashboard. A small Tauri 2 Rust host owns one persistent Node subprocess and exposes only named fixture operations. TypeScript with Effect 4 owns fixture inspection and operation lifetime. Ship a copy of Node and bundled backend JavaScript as resources; resolve them relative to the app, never through PATH. This deliberately measures the full runtime cost.

The backend uses newline-delimited JSON over stdin/stdout. Messages include protocol version 1 and request IDs. Responses and progress are separate records; diagnostics go to stderr. Validate requests at both boundaries, reject unknown operations, correlate responses, time out pending requests, and reject all pending work when the child exits. The renderer receives serializable data and progress events. It cannot choose executables, paths, or shell commands.

## Fixture workflow

Use a small fixed profile with common agent settings and a machine override. Show base, override, resolved desired value and current fixture value, including a change preview. Applying operates only on a fresh temporary directory and a harmless bundled fixture child or internal operation. It never reads or changes real agent homes, invokes an installer, or connects to Git. Only one operation runs at a time. Cancel, disconnect, and shutdown stop active work and clean temporary resources. Show completed, cancelled, failed, and disconnected states truthfully.

Provide an explicit backend restart action. It fails pending work and starts a fresh process; no mutation retries or resurrected operation state. The fixture app may include a clearly marked crash probe to validate that behavior. Renderer subscriptions must register before requests and clean up on unmount.

## Packaging and validation

The developer needs Node, npm, Rust and platform Tauri prerequisites. Installed users need no separate Node. Pin compatible dependencies and commit both lockfiles. Build resources on the local architecture; document platform restrictions and do not claim Windows/Linux validation without running it. Keep generated binaries, build outputs and dependency directories out of Git.

Use meaningful tests for profile resolution and preview, malformed protocol input, operation cancellation, resource cleanup, sidecar death, restart, and EOF shutdown. Verify the legacy suite and report its existing failure. Run one complete release build at the end, then use the packaged backend with PATH stripped and smoke test the app. Record package size and process observations. Signing, updates, full profile inheritance, sync, real installers and production UI are later work.

## Decision

Tauri remains a candidate until this probe passes. A successful local package establishes macOS feasibility only. Retain the code as a clearly labelled experimental validation app for review and repeatable checks; it is not the foundation of the production profile model by default.
