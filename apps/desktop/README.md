# Desktop fixture validation

This isolated experiment checks whether Tauri 2 can own a persistent TypeScript/Effect 4 backend and package its Node runtime. It inspects a fixed sample profile, shows machine override provenance and a before/after preview, and applies the resolved settings in a fresh temporary directory. Completing an apply changes the backend's in-memory fixture snapshot. Restart resets that snapshot.

The root Node 18+ CLI and its dependency-free package stay independent. Desktop tests live in `checks/*.spec.ts`, so the root test runner does not discover them.

## Local setup

This package currently targets **macOS arm64**. Other platforms and cross-compilation have not been validated. You need Node 22.12+, npm, Rust, Xcode command line tools, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

Use an official standalone Node distribution for the packaged runtime. A Homebrew executable can link libraries outside the app; the bundler rejects that case. Extract the official archive yourself and keep its `LICENSE` alongside `bin/node`. No installed-app startup downloads anything.

```sh
cd apps/desktop
npm ci
export DESKTOP_NODE_RUNTIME=/absolute/path/node-v24.21.0-darwin-arm64/bin/node
# Optional when LICENSE is not at the distribution root:
# export DESKTOP_NODE_LICENSE=/absolute/path/LICENSE
npm run desktop:dev
```

`desktop:dev` bundles the backend, copies Node into `src-tauri/resources/darwin-arm64`, then starts Vite and the Tauri host. `npm run dev` starts a browser preview with native actions disabled. It does not simulate a working backend.

## Verification

```sh
npm run resources
npm test
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
npm run smoke
# Separately, from the repository root:
npm test
```

Tests cover profile resolution and preview, Schema boundaries, progress, busy rejection, cancellation, EOF, shutdown, crash probe, abrupt backend death, cleanup of the child and directory, bounded records, request timeout, pending-request rejection, fresh restart, and renderer subscription ordering. The Node resource test uses an empty PATH and another working directory. Rust lifecycle tests use the actual bundled runtime and deliberately broken fixture sidecars.

The legacy suite has an existing failure named `apply --target codex installs the restricted OpenRouter Codex home without a secret` in `test/openrouter-config.test.mjs`, where `stealth/union-alpha` is expected but absent. This experiment does not change that behavior.

## Release package

Run one full release build after targeted checks:

```sh
npm run desktop:build
npm run smoke -- "src-tauri/target/release/bundle/macos/Nortuscc Fixture Lab.app"
```

The second command runs the packaged Rust owner with an empty PATH from a temporary working directory. It asserts inspect, apply, busy rejection, cancel, deliberate backend crash, disconnected-request rejection, fresh restart and completion. It also checks every observed fixture directory and child has disappeared. The executable supports `--smoke` for these native host checks without opening a window.

The app embeds the backend bundle, a complete Node executable and its license under `Contents/Resources/fixture-runtime`. Rust resolves that path through Tauri's resource directory. The renderer cannot choose a filesystem path, executable or shell command. Resources and outputs are ignored; npm and Cargo lockfiles are committed. The resource mapping in `tauri.conf.json` deliberately names the current macOS arm64 target.

For manual verification, open the `.app`, apply the fixture and confirm the preview becomes empty. Restart, start another apply and cancel it. The preview should still show two changes. Use the clearly labelled Crash probe, confirm Disconnected, then Restart backend. Close the window during an apply and check that no backend or fixture child remains. macOS does not offer Tauri WebDriver automation, so GUI behavior needs a separate manual check.

## Lifetime and protocol

Protocol version 1 uses JSON lines with a 16,384-byte record limit. `backend/protocol.ts` defines Schema-validated request, response and progress records. Rust mirrors those envelopes and validates them before forwarding events. Requests contain IDs and one of `inspect`, `start`, `cancel`, `shutdown` or `crash`. Success replies carry `result`; failures carry `error.code` and `error.message`. Diagnostics go to stderr.

Progress contains `operationId`, `state`, integer `percent` from 0 to 100, and `detail`. Running work emits 0 then 10 through 80. Completion emits 100 after cleanup. Cancelled and failed events use 0 after cleanup. The backend permits one operation at a time. Effect scopes own the temporary directory and harmless fixture child. Closing the child's stdin independently removes its directory if the backend dies abruptly.

Rust correlates responses, rejects pending requests on exit or malformed output, and disconnects on a five-second request timeout. Shutdown requests cleanup, closes stdin, then kills the process group if the grace period expires. It removes tracked fixture directories after forced or unexpected death. Renderer events include a host generation; old process events and old operation IDs are ignored. Listeners register before the first request and unregister on disposal. Restart is explicit and never retries mutations.

Signing, updates, production profile inheritance, credentials, real agent homes, installers and sync are outside this probe. A local successful package establishes feasibility on this machine only. Package size and GUI observations belong in the final validation report.
