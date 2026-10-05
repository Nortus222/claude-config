# Desktop fixture validation

This isolated experiment checks whether Tauri 2 can own a persistent TypeScript/Effect 4 backend and package its JavaScript runtime. It inspects a fixed sample profile, shows machine override provenance and a before/after preview, and applies the resolved settings in a fresh temporary directory. Completing an apply changes the backend's in-memory fixture snapshot. Restart resets that snapshot.

The root Node 18+ CLI and its dependency-free package stay independent. Desktop tests live in `checks/*.spec.ts`, so the root test runner does not discover them.

## Local setup

This package currently targets **macOS arm64**. Other platforms and cross-compilation have not been validated. You need Node 22.12+ and npm for the tooling, Bun 1.3+ for the packaged runtime, Rust, Xcode command line tools, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

The app ships an official standalone Bun binary. A Homebrew executable can link libraries outside the app; the bundler rejects that case. Bun releases include no license file, so download `LICENSE.md` from the matching `bun-v<version>` tag of [oven-sh/bun](https://github.com/oven-sh/bun) and point `DESKTOP_BUN_LICENSE` at it. No installed-app startup downloads anything.

```sh
cd apps/desktop
npm ci
export DESKTOP_BUN_LICENSE=/absolute/path/bun-LICENSE.md
# Optional; defaults to the bun on PATH:
# export DESKTOP_BUN_RUNTIME=/absolute/path/bun-darwin-aarch64/bun
npm run desktop:dev
```

`desktop:dev` bundles the backend, copies Bun into `src-tauri/resources/darwin-arm64`, then starts Vite and the Tauri host. `npm run dev` starts a browser preview with native actions disabled. It does not simulate a working backend.

## Verification

```sh
npm run resources
npm test
npm run test:bun
npm run typecheck
cargo test --manifest-path src-tauri/Cargo.toml
npm run smoke
# Separately, from the repository root:
npm test
```

Tests cover profile resolution and preview, Schema boundaries, progress, busy rejection, cancellation, EOF, shutdown, crash probe, abrupt backend death, cleanup of the child and directory, bounded records, request timeout, pending-request rejection, fresh restart, and renderer subscription ordering. `npm test` runs the checks on Node. `npm run test:bun` runs the fixture, Schema and controller checks under Bun and the live backend checks on the bundled Bun. The bundled-runtime test uses an empty PATH and another working directory. Test clients and the standalone smoke script create their own temporary session root and supply `NORTUSCC_FIXTURE_SESSION`; direct backend invocation requires that existing host-owned root. The Rust crash test uses a fake sidecar that pauses after creating an operation directory but before spawning a child. It then kills the backend and asserts cleanup without a resource diagnostic. Rust lifecycle tests use the actual bundled runtime and deliberately broken fixture sidecars.

The legacy suite has an existing failure named `apply --target codex installs the restricted OpenRouter Codex home without a secret` in `test/openrouter-config.test.mjs`, where `stealth/union-alpha` is expected but absent. This experiment does not change that behavior.

## Release package

Run one full release build after targeted checks:

```sh
npm run desktop:build
npm run smoke -- "src-tauri/target/release/bundle/macos/Nortuscc Fixture Lab.app"
```

The second command runs the packaged Rust owner with an empty PATH from a temporary working directory. It asserts inspect, apply, busy rejection, cancel, deliberate backend crash, disconnected-request rejection, fresh restart and completion. It also checks every observed fixture directory and child has disappeared. The executable supports `--smoke` for these native host checks without opening a window.

The app embeds the backend bundle, an unmodified Bun executable and its license under `Contents/Resources/fixture-runtime`. Rust resolves that path through Tauri's resource directory. The renderer cannot choose a filesystem path, executable or shell command. Resources and outputs are ignored; npm and Cargo lockfiles are committed. The resource mapping in `tauri.conf.json` deliberately names the current macOS arm64 target.

For manual verification, open the `.app`, apply the fixture and confirm the preview becomes empty. Restart, start another apply and cancel it. The preview should still show two changes. Use the clearly labelled Crash probe, confirm Disconnected, then Restart backend. Close the window during an apply and check that no backend or fixture child remains. macOS does not offer Tauri WebDriver automation, so GUI behavior needs a separate manual check.

## Backend runtime size

Measured on macOS arm64 (October 2026) for issue #40. Each option passed the packaged smoke test. App size is the complete `.app`. Startup is the median time from spawn to the first `inspect` reply, and idle memory is backend RSS after 2 seconds. Both use 10 runs of `node scripts/measure.mjs <runtime> [backend.mjs]`.

| Backend runtime | App size | Runtime file | Startup | Idle memory |
| --- | --- | --- | --- | --- |
| Node 24.19 + `backend.mjs` (previous) | 127.5 MiB | 116 MiB | 65 ms | 68 MiB |
| Node 24.19 SEA | ~127 MiB | 116 MiB | 55–68 ms | 61 MiB |
| `bun build --compile` (Bun 1.3.14) | ~72 MiB | 61 MiB | 43–49 ms | 42 MiB |
| Bun 1.3.14 + `backend.mjs` (kept) | 71.9 MiB | 60 MiB | 46–49 ms | 45 MiB |

A SEA copies the whole Node binary and adds code cache, so it saves no space. Bun cuts the app by 44% and idle backend memory by a third. The compiled and plain Bun builds are equal in size and speed. The plain layout is kept because the Rust lifecycle tests can still run fake JavaScript sidecars on the real bundled runtime, and an unmodified Bun binary keeps our code separate from its statically linked LGPL-2 JavaScriptCore. Bun does not implement `syncBuiltinESMExports`, so runtime monkeypatching of Node builtins does not work there.

The remaining 12 MiB is the Rust host and web assets. The host process uses about 107 MiB RSS at idle with the window open, excluding WebKit's separate content processes. No Electron build was measured.

## Lifetime and protocol

Protocol version 1 uses JSON lines with a 16,384-byte record limit. `backend/protocol.ts` defines Schema-validated request, response and progress records. Rust mirrors those envelopes and validates them before forwarding events. Requests contain IDs and one of `inspect`, `start`, `cancel`, `shutdown` or `crash`. Success replies carry `result`; failures carry `error.code` and `error.message`. Diagnostics go to stderr.

Progress contains `operationId`, `state`, integer `percent` from 0 to 100, and `detail`. Running work emits 0 then 10 through 80. Completion emits 100 after cleanup. Cancelled and failed events use 0 after cleanup. The backend permits one operation at a time. Effect scopes own the temporary directory and harmless fixture child. Closing the child's stdin independently removes its directory if the backend dies abruptly.

Rust correlates responses, rejects pending requests on exit or malformed output, and disconnects on a five-second request timeout. Shutdown requests cleanup, closes stdin, then kills the process group if the grace period expires. Rust creates a private session directory before spawning the backend and passes it only through the child environment. Operation directories stay beneath that session. Every session exit removes the entire directory, including a crash before an operation or child is registered. A cleanup lock makes forced cleanup finish before shutdown returns. Renderer events include a host generation; old process events and old operation IDs are ignored. Listeners register before the first request and unregister on disposal. Disconnects received before an inspect or restart response are retained until the matching generation is known. A revision token prevents superseded request success, failure and finalization from changing a newer action. Restart is explicit and never retries mutations.

Signing, updates, production profile inheritance, credentials, real agent homes, installers and sync are outside this probe. A local successful package establishes feasibility on this machine only. Package size and GUI observations belong in the final validation report.
