# The desktop app is a Tauri 2 client of the bundled local agent

Research favoured Electron for reuse, but a packaged Tauri 2 spike passed with a React renderer,
a Rust host and a Bun stdio sidecar. The desktop now connects to the persistent local agent over
authenticated protocol v3 Unix IPC (ADR 0011 and ADR 0019). It bundles standalone Bun and the
agent, and a short-lived helper manages the app-owned login service (ADR 0021). Closing a window
disconnects its socket while the service continues. The renderer sends only opaque item keys and
plan ids; Rust allow-lists request names and the agent validates every key.

## Considered options

- Electron: the research default, never measured once the Tauri spike passed.
- A browser UI on a local HTTP service: needs loopback auth and Origin checks.
- `bun build --compile`: same size, and plain Bun keeps our code separate from Bun's LGPL engine.

## Consequences

- Core code must run on both Node 24 and Bun.
- The app ships its own runtime and reads the login shell's PATH once to find `npx`, `claude`
  and `codex`.
- Packaging is validated on macOS arm64; Windows IPC remains unsupported (ADR 0019).
