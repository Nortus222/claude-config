# Nortuscc desktop

The app inspects this machine through `@nortuscc/machine`, previews a plan, applies it with backups and can cancel a run. It wires in config, integrations and skills from `backend/domains.ts`, built per inspection from the resolved paths and the login environment.

A Tauri 2 host (Rust) owns a Bun backend that speaks protocol v2 over stdio, and a React renderer talks only to the host. This app is an npm workspace of the root monorepo on Node 24+. Desktop tests live in `checks/*.spec.ts`, so the root test runner does not discover them.

## Local setup

This package targets **macOS arm64**. Other platforms and cross-compilation have not been validated. You need Node 24+ and npm for the tooling, Bun 1.3+ for the packaged runtime, Rust, Xcode command line tools, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

The app ships an official standalone Bun binary. A Homebrew executable can link libraries outside the app; the bundler rejects that case. Bun releases include no license file, so download `LICENSE.md` from the matching `bun-v<version>` tag of [oven-sh/bun](https://github.com/oven-sh/bun) and point `DESKTOP_BUN_LICENSE` at it. No installed-app startup downloads anything.

```sh
npm ci   # at the repository root
export DESKTOP_BUN_LICENSE=/absolute/path/bun-LICENSE.md
# Optional; defaults to the bun on PATH:
# export DESKTOP_BUN_RUNTIME=/absolute/path/bun-darwin-aarch64/bun
npm run desktop:dev -w apps/desktop
```

`desktop:dev` bundles the backend, copies Bun into `src-tauri/resources/darwin-arm64`, then starts Vite and the Tauri host. `npm run dev` starts a browser preview with native actions disabled. It does not simulate a working backend.

## Verification

```sh
npm run resources -w apps/desktop
npm test -w apps/desktop
npm run test:bun -w apps/desktop
npm run typecheck -w apps/desktop
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run smoke -w apps/desktop
# Separately, the CLI suite:
npm test
```

- `npm test` (Node) covers the protocol schemas, the login-shell environment probe, the session with fake domains (inspect, preview, stale plans, apply, cancel, lock), a real-domain inspect and preview on a temporary HOME, and a check that installer output stays off stdout and the renderer controller's event ordering.
- `npm run test:bun` runs the protocol and controller checks under Bun, and the stdio backend checks on the bundled Bun: framing, busy rejection, cancel, `STALE`, shutdown, lock takeover from a dead pid, and reports larger than the old 16 KB cap.
- `cargo test` covers the Rust envelope, the 1 MiB record bound, timeouts and the backend lifecycle on the bundled runtime.
- `npm run smoke` runs the bundled backend on a temporary HOME whose `state.json` records this checkout, with an empty PATH: inspect, preview, apply to `done`, an unknown-key refusal, shutdown, and no leftover `apply.lock`.

The CLI suite has a known flaky test named `fresh machine setup installs selected defaults for both agents` in `test/fresh-machine.test.mjs`. The root suite can also rewrite `skills-manifest.txt`; restore it after a run.

## Release package

```sh
npm run desktop:build -w apps/desktop
npm run smoke -w apps/desktop -- "src-tauri/target/release/bundle/macos/Nortuscc.app"
```

The second command runs the packaged Rust owner (`--smoke <temporary HOME> [resources]`, no window; it refuses any HOME outside the system temp dir) on a temporary HOME with an empty PATH from a temporary working directory. The app embeds the backend bundle, an unmodified Bun executable and its license under `Contents/Resources/backend-runtime`; Rust resolves that path through Tauri's resource directory. Resources and outputs are git-ignored; the root `package-lock.json` and the Cargo lockfile are committed. The resource mapping in `tauri.conf.json` names the macOS arm64 target.

## Protocol v2

JSON lines, one record per line, at most 1,048,576 bytes. Every record carries `version: 2`. Diagnostics go to stderr.

| Request | Result |
| --- | --- |
| `inspect` | `{ profile, items, probeErrors }`: the resolved profile with issues, every observed item with state, disposition and provenance, and failed probes |
| `preview { exclude: key[] }` | `{ planId, plan }`: steps and skipped items with reasons; unknown keys fail `UNKNOWN_KEY` |
| `apply { planId }` | `{ status: 'started', runId }`, or `{ status: 'stale', planId, plan }` with a new preview when the machine changed |
| `cancel` | acknowledges; the current run stops |
| `shutdown` | acknowledges; the backend cancels any run and exits |

Errors are `{ ok: false, error: { code, message } }` with codes `INVALID_REQUEST`, `MALFORMED`, `OVERSIZED`, `SHUTDOWN`, `BUSY`, `NO_REPORT`, `UNKNOWN_KEY`, `UNKNOWN_PLAN`, `PROFILE_INVALID`, `REPO_NOT_FOUND`, `INSPECT_FAILED`, `LOCKED` and `INTERNAL`.

Run events are `{ version: 2, event: 'progress', runId, progress }` where `progress.type` is `started`, `finished`, `done`, `cancelled` or `failed`. The reply to `apply` precedes its events. `apply` re-inspects first and answers `stale` instead of running an out-of-date plan.

- Timeouts per command: inspect and apply 60 s, preview 10 s, cancel 30 s, shutdown 5 s.
- One run at a time; a second `apply` fails `BUSY`.
- `cancel` finishes the current file step or interrupts an installer. Shutdown, EOF, SIGTERM and a closed stdout cancel first, then release the lock and exit 0.
- The backend holds `<stateRoot>/apply.lock` during a run. The CLI's `apply`, `capture`, `pull`, `push`, `setup` and `uninstall` take the same lock. A dead holder's lock is taken over. An apply takes `apply.lock` before it re-inspects and refuses with `LOCKED` while a live process holds it.

## Paths

The backend builds paths from HOME and `state.json`'s `repo` exactly as the CLI does, with no fallback. A stale record reports `REPO_NOT_FOUND` with the recorded path. The login shell's whole environment comes from `$SHELL -ilc` once at startup (5 s timeout) and is what paths, installers and MCP prerequisite checks read; installer output goes to the backend's stderr, never its stdout. A failed probe, or a missing `npx`, `claude` or `codex`, is a probe failure in the report, not a crash. Rust passes the backend no paths; the renderer sends only item keys and plan ids.

## Manual check

macOS has no Tauri WebDriver, so check the GUI by hand: open the `.app`, inspect, deselect an item, preview, apply, cancel a long run, restart the backend, and close the window during a run. Then confirm no `apply.lock` remains in `~/.config/nortuscc`.

## Backend runtime size

Measured on macOS arm64 (October 2026) for issue #40. Each option passed the packaged smoke test. App size is the complete `.app`. Startup is the median time from spawn to the first `inspect` reply, and idle memory is backend RSS after 2 seconds. Both use 10 runs of `node scripts/measure.mjs <runtime> [backend.mjs]`. These figures were measured with the fixture backend, before the real machine backend replaced it, and have not been re-measured.

| Backend runtime | App size | Runtime file | Startup | Idle memory |
| --- | --- | --- | --- | --- |
| Node 24.19 + `backend.mjs` (previous) | 127.5 MiB | 116 MiB | 65 ms | 68 MiB |
| Node 24.19 SEA | ~127 MiB | 116 MiB | 55–68 ms | 61 MiB |
| `bun build --compile` (Bun 1.3.14) | ~72 MiB | 61 MiB | 43–49 ms | 42 MiB |
| Bun 1.3.14 + `backend.mjs` (kept) | 71.9 MiB | 60 MiB | 46–49 ms | 45 MiB |

A SEA copies the whole Node binary and adds code cache, so it saves no space. Bun cuts the app by 44% and idle backend memory by a third. The compiled and plain Bun builds are equal in size and speed. The plain layout is kept because the Rust lifecycle tests can still run fake JavaScript sidecars on the real bundled runtime, and an unmodified Bun binary keeps our code separate from its statically linked LGPL-2 JavaScriptCore. Bun does not implement `syncBuiltinESMExports`, so runtime monkeypatching of Node builtins does not work there.

The remaining 12 MiB is the Rust host and web assets. The host process uses about 107 MiB RSS at idle with the window open, excluding WebKit's separate content processes. No Electron build was measured.
