# Agent manager tooling and proposed setup

Researched 2026-10-05. The requested direction is a desktop app for managing agent configuration, skills, setup, and updates across machines, with public profiles and downstream overrides. TypeScript with Effect is the backend requirement. This document recommends the remaining tools and identifies what needs an executed compatibility check. No application dependencies were installed.

## Recommended stack

| Responsibility | Recommendation | Reason for this project |
| --- | --- | --- |
| Desktop shell | Electron | Its bundled Node runtime fits the existing filesystem and installer code and the requested TypeScript backend. |
| UI | React with strict TypeScript | A browser-only dashboard can stay independent of the desktop shell and use typed navigation and data tools. |
| Navigation | TanStack Router | Profile, machine, skill, and revision identifiers belong in typed routes. |
| Backend snapshots | TanStack Query | Machine inspection, background checks, and installation results affect several screens. Query owns those snapshots; Router may prefetch them. |
| UI drafts and styling | React state, semantic HTML, CSS Modules | Keep unsaved form state local. Add Radix primitives for complex accessible controls as required. |
| Backend | Effect 4 and its Node platform adapters | Typed failures, resource lifetimes, cancellation, and injectable dependencies fit reconciliation and installer orchestration. |
| Contracts | Effect Schema | One definition validates profiles, machine state, requests, results, and progress events. |
| Build and packaging | electron-vite with Electron Forge packaging | Separate renderer, preload, main, and worker outputs; package existing build output with Forge. |
| Repository tooling | pnpm workspace and TypeScript project references | Separate desktop, CLI, contracts, and engine with ordinary package dependencies and one lockfile. |
| New backend tests | Vitest with matching @effect/vitest | Fake services and clocks exercise failures and update policies. Existing node:test tests remain during migration. |
| Portable configuration | Versioned JSON manifests, Markdown instructions, Git | Profiles are readable and independently distributable. Git stores desired state and approved source revisions. |
| Machine bookkeeping | Versioned JSON and an operation lock | The initial inventory, ownership baselines, and operation receipts do not require a database. |

These are recommendations, not claims that the package set has passed a build. See the detailed [desktop/UI research](./2026-10-05-desktop-ui-tooling.md) and [Effect research](./2026-10-05-effect-backend-tooling.md) for version metadata, alternatives, and runtime constraints.

React documents using Vite for a client application. TanStack Router offers typed routes, while Query owns asynchronous cached data, including data loaded through a custom IPC function. The proposed combination has one cache for backend snapshots. Route loaders delegate to that cache; UI drafts stay outside it. [React setup](https://react.dev/learn/build-a-react-app-from-scratch), [Router type safety](https://tanstack.com/router/latest/docs/guide/type-safety), [Query overview](https://tanstack.com/query/latest/docs/framework/react/overview).

CSS Modules are supported by Vite. Radix supplies accessible, unstyled controls when native HTML is insufficient. pnpm supports workspace packages, and TypeScript references support separate buildable projects. [Vite CSS Modules](https://vite.dev/guide/features.html#css-modules), [Radix](https://www.radix-ui.com/primitives/docs/overview/introduction), [pnpm workspaces](https://pnpm.io/workspaces), [TypeScript references](https://www.typescriptlang.org/docs/handbook/project-references.html).

## Alternatives and trade-offs

Electron is the strongest starting choice because Node is already the project's execution environment. Its cost is bundling Chromium and Node with every app installation. Tauri uses system webviews, but a TypeScript backend needs a packaged Node sidecar and another process integration through the Rust shell. Reconsider Tauri if measured download size or memory becomes a primary constraint. Do not assume a large size saving before including the Node backend. [Electron](https://www.electronjs.org/docs/latest/), [Tauri Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [Tauri webviews](https://v2.tauri.app/reference/webview-versions/).

Svelte and Solid are viable renderer alternatives. Svelte uses compiled components with HTML, CSS, and TypeScript; Solid uses signals and fine-grained updates. Neither changes the proposed backend. React is the default recommendation because typed Router/Query integration directly suits this dashboard; the project has no existing UI to migrate or preserve. No benchmark was run. [Svelte](https://svelte.dev/docs/svelte/overview), [Solid reactivity](https://docs.solidjs.com/concepts/intro-to-reactivity).

A desktop renderer has no current need for server rendering, server components, or a local HTTP listener. A public profile website can be designed separately when it is needed. Effect RPC can be reconsidered if the operation interface grows enough to justify a MessagePort transport adapter. Start with a small Schema-validated command/event protocol.

## Version traps found during research

Effect 4 became stable on September 30. On the research date, `effect`, `@effect/platform-node`, and `@effect/vitest` have stable `4.0.1` releases. Use exact aligned versions. Older standalone `@effect/platform`, `@effect/cli`, `@effect/sql`, and `@effect/rpc` releases belong to the v3 ecosystem. v4's CLI, process, and RPC modules still have unstable interfaces, so project adapters should contain their use. [Effect 4 release](https://effect.website/blog/releases/effect/40), [package details](./2026-10-05-effect-backend-tooling.md#current-versions-and-compatibility).

Use Node 24 for the new CLI and development runtime. The Node >=18 declaration in the current package is insufficient for the inspected dependency graph: platform-node's Undici dependency requires >=22.19, while @effect/vitest 4 requires Vitest 5. Check Electron's embedded Node independently. platform-node also declares a Redis peer; package-manager installation and actual imported adapters must be checked before accepting an unrelated dependency. [Undici metadata](https://registry.npmjs.org/undici/8.11.2), [Effect test metadata](https://registry.npmjs.org/@effect/vitest/4.0.1), [Node platform metadata](https://registry.npmjs.org/@effect/platform-node/4.0.1).

The current `electron-vite 5.0.0` peer range accepts Vite 5, 6, or 7; latest Vite is 8. A metadata-compatible candidate is `electron-vite 5.0.0`, `vite 7.3.6`, and `@vitejs/plugin-react 5.2.0`. Forge's own Vite plugin is still documented as experimental. Use electron-vite to build and Forge to package; do not activate both Vite build integrations. Recheck these versions before implementation and verify Vitest's own Vite dependency separately in the workspace. [Build package metadata](https://registry.npmjs.org/electron-vite), [Vite metadata](https://registry.npmjs.org/vite), [React plugin metadata](https://registry.npmjs.org/@vitejs%2fplugin-react), [distribution guide](https://electron-vite.org/guide/distribution), [Forge Vite status](https://www.electronforge.io/config/plugins/vite).

## Process and package design

```text
apps/desktop/
  main/        windows, OS integration, trusted IPC routing
  preload/     narrow application operations exposed to the renderer
  renderer/    React dashboard
  worker/      Effect runtime hosted by an Electron utility process
apps/cli/      headless interface to the same engine
packages/contracts/  portable schemas and serializable operation messages
packages/engine/
  profiles/    inheritance, provenance, and locked inputs
  reconcile/   inspection, ownership, planning, and execution
  adapters/    Git, filesystem, process execution, Claude, and Codex
```

This is a proposed layout, not directories created by this research. One engine package is sufficient initially; its internal modules can change without exposing every installer detail to callers. Contracts contain no filesystem or Electron imports. The desktop and CLI provide runtime dependencies explicitly. pnpm workspace dependencies keep all hosts on the same local engine implementation.

The renderer calls named operations such as `inspectMachine`, `previewApply`, `applyPlan`, and `cancelOperation`. Requests include a protocol version and request ID; long operations return an operation ID and emit validated progress events. Results and errors are plain serializable records. The worker hosts one managed Effect runtime and performs filesystem access, Git operations, probes, and installations. The main process owns OS-specific functionality such as credential storage. The CLI provides its own host implementations and invokes the engine directly.

Electron utility processes supply Node and message ports. The worker improves responsiveness and crash isolation, but it is privileged and does not sandbox installed hooks or third-party code. Validate both IPC payloads and sending frames. The renderer uses a sandbox and context isolation; preload exposes application operations. Package the sandboxed preload as bundled CommonJS. [Utility process](https://www.electronjs.org/docs/latest/api/utility-process), [security](https://www.electronjs.org/docs/latest/tutorial/security), [preload ESM restrictions](https://www.electronjs.org/docs/latest/tutorial/esm).

## What Effect owns

Keep profile composition and drift comparison as pure functions. Use Effect at the I/O and orchestration points: dependency construction, probes, temporary resources, child processes, structured failures, cancellation, and update policies. Stable v4 `Context.Service`, `Layer`, and `ManagedRuntime` support this structure. [Context](https://effect.website/docs/v4/api/effect/Context), [Layers](https://effect.website/docs/v4/requirements-management/layers), [ManagedRuntime](https://effect.website/docs/v4/api/effect/ManagedRuntime).

Recoverable failures should identify the action a user can take: invalid profile, unexpected local edit, missing credential, unavailable executable, failed installer, or stale plan. Independent installer outcomes remain visible even when another item fails. Bound concurrent read-only checks; serialize dependent installations and writes. Effect interruption and finalizers do not make external installers transactional. Re-inspect interrupted operations before retrying them.

The engine needs a cross-process operation lock because the app and CLI can run together. The existing `src/lock.mjs` is a baseline store, not a concurrency lock. A preview records relevant revisions and machine fingerprints; apply rejects a stale plan before changing managed files. Back up owned files, write atomically where possible, persist partial receipts, and verify actual post-operation state. Rollback covers managed files; installer recovery depends on the native tool's supported operations.

## Profiles, sync, and public reuse

Separate the tool installation from profile repositories. A profile should not need `package.json`, the CLI source, or a particular checkout path to be usable. Compose a public base, a personal profile, selected role/OS profiles, and machine overrides in a documented order. Record where each effective value came from.

Settings override keys. Skills and integrations have stable identities and explicit add, replace, and disable semantics. Instruction sections can be added or replaced by identity. Shared skill stores may limit per-agent exclusions; adapters must report actual supported exposure instead of pretending an agent cannot see a globally loaded skill.

Following a public profile records its upstream revision and preserves downstream overrides. Copying produces an independent profile. User-owned changes never publish into the upstream profile automatically. Importing a local edit requires selecting its scope. Identity-specific instructions, including attribution naming Ihor, need a downstream identity or section override when another person adopts the setup.

Git stores manifests, instructions, and approved source revisions. Machine state stores baselines, fingerprints, ownership, and operation receipts locally. Start with JSON; introduce SQLite only for requirements such as searchable history or durable queues. Separate tool releases, profile revision updates, and changes to the approved skill lock. Source resolution and exact-revision installation need adapter verification before claiming reproducibility. The skills parser accepts ref syntax, but this research did not execute a pinned install. [Skills source parser](https://github.com/vercel-labs/skills/blob/main/src/source-parser.ts).

An app running in the tray can perform optional checks. Checking while fully exited requires a separately scheduled CLI job or helper. A machines view can show the current machine and other machines' last reported receipts only when reporting has been implemented; Git profile sync alone does not establish current fleet status. A hosted telemetry service is a separate later requirement.

Initially use native Git credential handling and agent-owned authentication. If the app stores its own credentials, keep them machine-local behind an OS credential service. Electron safeStorage has differing platform guarantees and a weak `basic_text` fallback on Linux; detect unsupported secure storage and use native authentication or memory-only credentials. [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## First implementation batch and verification

Before a full dashboard, prove one packaged workflow: launch from the OS, inspect a temporary machine fixture through the Effect worker, preview a change, run a harmless fixture installer, receive progress, cancel it, and inspect the resulting receipt. Run the same engine through the CLI. Validate clean dependency installation, type checking, bundling, and the exact embedded Node runtime.

Then implement profile inheritance and ownership-aware reconciliation, followed by the setup dashboard, public adoption, and opt-in background checks. Preserve existing copy, key-merge, backup, conflict, project-trust, and uninstall behavior through migration. Existing .mjs adapters can sit behind typed services until they are replaced.

Packaged OS tests must cover GUI executable discovery, npm/npx availability, Windows command wrappers, paths containing spaces, writable state outside ASAR, and cancellation/crash recovery. `process.execPath` inside Electron is not an ordinary system Node installation; the current setup's adjacent-npm lookup cannot be reused unchanged. ASAR is read-only and cannot be a subprocess working directory. [ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

Keep existing node:test coverage and add Effect tests using fake Layers, TestClock, temporary homes, and fixture child processes. Test two app/CLI writers and stale plan rejection. Each operation reports verified outcomes rather than accepting installer exit status as the whole result. [Effect test integration](https://github.com/Effect-TS/effect/tree/main/packages/vitest).

Distribution adds signed builds and macOS notarization. Electron's built-in updater supports macOS and Windows; Linux needs a package-manager or separately evaluated distribution policy. These checks need OS-specific CI and installed artifacts, not just renderer development mode. [Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [updater platforms](https://www.electronjs.org/docs/latest/api/auto-updater).

## Evidence and limits

The existing repository was inspected and primary documentation, publisher metadata, and source were checked. Earlier in this thread, the unchanged repository passed all 725 tests with `NORTUSCC_REPO_DIR` explicitly set to this worktree. The ordinary test command produced one environment-dependent catalog failure because legacy machine state redirected a test to a different checkout.

This research changes documentation only. It does not prove the proposed dependency set installs, that Effect runs inside a packaged Electron worker, or that signing, auto-updates, credential storage, and native installers work across platforms. Those are the purpose of the first implementation batch.
