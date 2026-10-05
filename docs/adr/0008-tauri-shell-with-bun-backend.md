# The desktop app is a Tauri 2 shell over a bundled Bun backend; the renderer never chooses paths or commands

Research favoured Electron for reuse, but a packaged Tauri 2 spike passed every check: a React
renderer, a small Rust host, and a backend owned by the host speaking strict, versioned JSON lines
over stdio. Bundling Bun instead of Node cut the app from 127.5 to 71.9 MiB and idle backend
memory from 68 to 45 MiB. The renderer sends only opaque item keys and plan ids; Rust allow-lists
request names and the backend validates every key.

## Considered options

- Electron: the research default, never measured once the Tauri spike passed.
- A browser UI on a local HTTP service: needs loopback auth and Origin checks.
- `bun build --compile`: same size, and plain Bun keeps our code separate from Bun's LGPL engine.

## Consequences

- Core code must run on both Node 24 and Bun.
- The app ships its own runtime and reads the login shell's PATH once to find `npx`, `claude`
  and `codex`.
- Only macOS is validated.
