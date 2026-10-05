# Effect backend tooling, checked 2026-10-05

## Recommendation

Use TypeScript with stable Effect 4 for the configuration engine. Run it in an Electron utility process, reuse it directly from the CLI, and start with a small Schema-validated IPC command/event interface. No local HTTP server is necessary. Keep portable profiles in Git and machine state in versioned JSON initially. These are project recommendations, not requirements imposed by Effect.

## Current versions and compatibility

Effect 4 became stable on September 30, 2026. Its core has no runtime dependencies; ecosystem packages release together. Some modules remain unstable and can change in minor or patch releases. Earlier beta articles and some migration text are stale. [Official release](https://effect.website/blog/releases/effect/40).

The npm registry was checked directly rather than relying on cached search snippets:

| Package | Current latest | Publication UTC | Relevant peers |
| --- | --- | --- | --- |
| `effect` | `4.0.1` | Oct 5, 01:15:35.824 | None |
| `@effect/platform-node` | `4.0.1` | Oct 5, 07:46:34.758 | `effect ^4.0.1`; also declares `redis >=5 <7` |
| `@effect/sql-sqlite-node` | `4.0.1` | Oct 4, 21:52:34.906 | `effect ^4.0.1` |
| `@effect/vitest` | `4.0.1` | Oct 4, 21:54:41.838 | `effect ^4.0.1`, `vitest >=5 <6` |

Exact metadata and publication histories: [effect](https://registry.npmjs.org/effect), [platform-node](https://registry.npmjs.org/@effect/platform-node), [SQLite driver](https://registry.npmjs.org/@effect/sql-sqlite-node), [Vitest integration](https://registry.npmjs.org/@effect/vitest). Exact manifests: [effect 4.0.1](https://registry.npmjs.org/effect/4.0.1), [platform-node 4.0.1](https://registry.npmjs.org/@effect/platform-node/4.0.1), [SQLite 4.0.1](https://registry.npmjs.org/@effect/sql-sqlite-node/4.0.1), [Vitest integration 4.0.1](https://registry.npmjs.org/@effect/vitest/4.0.1).

The `beta` and `rc` tags still point to `4.0.0-beta.107` and `4.0.0-rc.118`. They do not imply latest is a prerelease. Pin Effect packages to the same exact stable version and commit a lockfile. Recheck before implementation because this patch was published today.

Do not install these old packages alongside v4:

| Legacy package | Latest | Effect peer | v4 replacement |
| --- | --- | --- | --- |
| `@effect/platform` | `0.97.2` | `^3.22.2` | Core `FileSystem`, `Path`; `effect/http` and `effect/http-api` |
| `@effect/cli` | `0.77.2` | `^3.22.2` | `effect/cli` |
| `@effect/sql` | `0.52.1` | `^3.22.1` | `effect/sql` |
| `@effect/rpc` | `0.76.2` | `^3.22.1` | `effect/rpc` |

[Platform metadata](https://registry.npmjs.org/@effect/platform/0.97.2), [CLI metadata](https://registry.npmjs.org/@effect/cli/0.77.2), [SQL metadata](https://registry.npmjs.org/@effect/sql/0.52.1), [RPC metadata](https://registry.npmjs.org/@effect/rpc/0.76.2), [v4 package exports](https://registry.npmjs.org/effect/4.0.1).

A conservative existing v3 deployment could retain `effect 3.22.2`, platform `0.97.2`, platform-node `0.108.2`, CLI `0.77.2`, SQL `0.52.1`, RPC `0.76.2`, and vitest integration `0.30.0` with Vitest 3.2. This project has no existing Effect dependency, so adopting v3 would create a later migration without a current benefit. [v3 Node manifest](https://registry.npmjs.org/@effect/platform-node/0.108.2), [v3 test manifest](https://registry.npmjs.org/@effect/vitest/0.30.0).

Use Node 24 for development and the CLI, and verify Electron's embedded Node against the same APIs. The platform-node manifest says Node >=18, but its Undici dependency requires >=22.19. Vitest 5.0.3 requires `^22.12 || ^24 || >=26`. The current project's Node >=18 promise must be revisited. Redis is an unexpected declared platform-node peer; inspect package-manager behavior before accepting an unrelated runtime dependency. [Undici manifest](https://registry.npmjs.org/undici/8.11.2), [Vitest manifest](https://registry.npmjs.org/vitest/5.0.3).

## Engine patterns

Keep inheritance, ownership, drift comparison, and planning as pure functions. Use Effect for I/O and orchestration. Define services with stable v4 `Context.Service`, not obsolete beta `ServiceMap.Service`. Provide live and test implementations through `Layer`; construct one `ManagedRuntime` per backend lifecycle and dispose it on shutdown. [Context](https://effect.website/docs/v4/api/effect/Context), [Layer](https://effect.website/docs/v4/api/effect/Layer), [ManagedRuntime](https://effect.website/docs/v4/api/effect/ManagedRuntime).

Use Schema for profiles, persisted state, IPC messages, and installer output. Decode unknown inputs at boundaries and version persisted schemas. Represent recoverable failures as tagged errors such as `ProfileInvalid`, `DriftConflict`, and `InstallerFailed`; serialize explicit error records to the renderer. [Versioned Schema source](https://unpkg.com/effect@4.0.1/src/Schema.ts).

Use `FileSystem` and `NodeServices.layer`. Scope temporary files, operation locks, and subscriptions with `acquireRelease`. Bound concurrent read-only probes; serialize dependent installations and writes. Preserve partial results instead of allowing one installer failure to cancel every unrelated item. Scope child processes with `effect/process`, preserve executable-plus-argument arrays, stream progress, and define cancellation behavior. Wrap legacy promises with `tryPromise`, forwarding its AbortSignal where supported. Cancellation does not stop a promise that ignores that signal, and finalizers cannot recover a killed process or rolled-back external installer automatically. Retry bounded read-only network checks; inspect state before retrying mutating installers. [Node services](https://effect.website/docs/v4/api/platform-node/NodeServices), [Effect lifecycle and concurrency](https://effect.website/docs/v4/api/effect/Effect), [Child processes](https://effect.website/docs/v4/api/effect/process/ChildProcess).

## Transport and state

Electron's utility process supplies Node and MessagePorts. Expose named operations through a context-isolated preload, with plain serializable request/result/event data. Include protocol version, request/operation IDs, cancel, and status lookup. Keep engine APIs independent of Electron. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [contextBridge](https://www.electronjs.org/docs/latest/api/context-bridge).

Effect RPC provides typed streaming calls and interruption machinery, but requires adapting a protocol to Electron MessagePorts. Its documented built-in transports are HTTP, sockets, and workers; no first-party Electron adapter was found. For a small API, custom validated commands are simpler. Reconsider RPC when its stream management outweighs adapter maintenance. RPC and CLI are still marked unstable despite stable v4 import paths. [RPC client](https://effect.website/docs/v4/api/effect/rpc/RpcClient), [CLI](https://effect.website/docs/v4/api/effect/cli/Command).

JSON is sufficient for a small machine inventory, ownership hashes, and operation receipts. Use atomic replacement plus a cross-process operation lock; the current `src/lock.mjs` stores baselines and is not a mutual-exclusion lock. Mark incomplete operations and re-inspect after crashes. Git versions portable desired state; machine receipts remain local. SQLite becomes justified by searchable history, durable queues, or related state needing transactions. Do not synchronize its database file through Git.

The v4 Node SQLite driver uses built-in `node:sqlite`, not v3's `better-sqlite3`. It uses synchronous calls and serializes one connection, so busy waits block its process. Verify the chosen Electron runtime if adopting it. Node's SQLite API remains release-candidate status. [Driver source](https://unpkg.com/@effect/sql-sqlite-node@4.0.1/src/SqliteClient.ts), [Node SQLite](https://nodejs.org/api/sqlite.html).

## Migration and checks

Preserve `src/state.mjs` behavior and existing ownership/backup tests. Migrate side-effect boundaries incrementally, keeping old `.mjs` adapters behind typed services while replacing CLI prompts and inherited stdio with UI-capable operations. Explicit paths and environment services must replace implicit home-directory/repository resolution. Two concurrent app/CLI writers, Windows command shims, crash recovery, and cancellation during installers deserve integration tests.

Use `@effect/vitest` with fake Layers and `TestClock` for retry/update policies, and scoped live tests against temporary directories and harmless fixture processes. v4 `it.effect` already scopes tests; do not copy obsolete `it.scoped` examples. Keep existing Node tests during migration. [Official testing README](https://github.com/Effect-TS/effect/blob/460272d30457f4697d8b8c52cad41caccbcace08/packages/vitest/README.md).

No packages were installed or executed. Package/runtime compatibility, IPC adaptation, Electron packaging, and cross-platform behavior remain proposals to validate in an isolated technical spike.
