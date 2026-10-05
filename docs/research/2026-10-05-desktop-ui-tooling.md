# Desktop shell and UI tooling

Researched 2026-10-05. Recommendations remain proposals. Sources are project documentation, source repositories, and publisher npm metadata. No dependencies were installed or application code changed.

## Recommendation

Use **Electron + React + TypeScript**, a shared **TypeScript/Effect engine**, and a narrow validated IPC interface. Prefer **TanStack Router** for typed navigation and React state for drafts. The [consolidated setup](./2026-10-05-agent-manager-tooling.md) selects TanStack Query for shared machine status and mutations; the loader-only alternative below suits a smaller app without that requirement.

This fits the repository: `package.json` declares ESM and Node >=18, with no runtime dependencies; `src/` already uses Node filesystem and subprocess APIs. The UI is new, so React is a choice rather than a migration constraint. Do not move installation logic into UI components.

## Electron versus Tauri

| Concern | Electron | Tauri 2 |
|---|---|---|
| TypeScript/Effect backend | Node is built into the main process; a Node utility process can host the engine | Requires a packaged Node sidecar or separately supplied runtime |
| Existing `.mjs` modules | Main-process ESM supports `.mjs` and `type: module` | Reuse inside the Node sidecar, with additional packaging |
| Renderer consistency | Bundles Chromium | Uses WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux |
| Privileged boundary | Sandboxed renderer, isolated preload, validated IPC | Rust commands and scoped capabilities; sidecar still validates its requests |
| Packaging burden | Electron runtime, signing, installers, updater | Rust shell, webview dependencies, sidecar binaries for each target, signing, updater |

Electron's main process has Node APIs, and `utilityProcess.fork` supplies a child Node process with message ports. This lets the engine stay independent of Electron while a small adapter handles transport. Utility processes improve responsiveness and crash isolation; they are privileged processes, not a security sandbox for installer code. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).

Tauri supports a TypeScript backend, but through a sidecar. Its guide packages Node code with `@yao-pkg/pkg` or embeds Node and bundled JavaScript; a persistent engine needs an IPC protocol and lifecycle supervision. Its system webviews introduce a broader rendering test matrix. Prefer it if reducing shell footprint outweighs maintaining that integration. Actual package size and memory savings need measurement after bundling the Node runtime. [Node sidecar guide](https://v2.tauri.app/learn/sidecar-nodejs/), [webview implementations](https://v2.tauri.app/reference/webview-versions/).

## UI choices

React plus Vite supports a browser-only dashboard bundle; React's own documentation describes this setup. There is no desktop requirement for SSR or React Server Components, so Next.js or TanStack Start would introduce a server framework without a current need. [React from scratch](https://react.dev/learn/build-a-react-app-from-scratch).

TanStack Router fits profile, machine, skill, and update detail screens because route parameters and search state are typed. It has built-in loader caching, sufficient for an early app with modest shared data. Keep one owner for backend snapshots: router loaders and explicit invalidation are the smaller option; TanStack Query is justified when overlapping screens need shared mutations, background refresh, or granular invalidation. With Query, route loaders delegate to its cache. [Type safety](https://tanstack.com/router/latest/docs/guide/type-safety), [loader cache tradeoffs](https://tanstack.com/router/latest/docs/guide/data-loading).

React Router Declarative Mode is the simpler alternative when navigation is mostly a handful of views and the data layer already owns loading states. Data Mode adds loaders and actions. Either is viable; typed routes justify TanStack Router here, but a five-screen prototype could begin with React Router or plain view selection. [React Router modes](https://reactrouter.com/start/modes).

## Build tooling: avoid incompatible latest tags

Publisher registry metadata fetched on the research date shows:

| Package | Version inspected | Relevant requirement |
|---|---|---|
| React | 19.3.0 | Stable `latest` tag |
| Vite | 8.3.2 | Node ^20.19 or >=22.12 |
| electron-vite | 5.0.0 | Vite ^5, ^6, or ^7; same Node requirement |
| @vitejs/plugin-react | 6.1.2 | Vite ^8 |
| Vite 7 line | 7.3.6 | Compatible with electron-vite 5 |
| @vitejs/plugin-react 5 line | 5.2.0 | Supports Vite 4–8 |

Thus **electron-vite 5.0.0 + Vite 7.3.6 + plugin-react 5.2.0** is a candidate compatible build set; combining all latest tags is not. React 19.3 is within TanStack Router's declared React peer range. These are metadata checks, not an executed build. [React metadata](https://registry.npmjs.org/react/latest), [Vite metadata](https://registry.npmjs.org/vite), [electron-vite metadata](https://registry.npmjs.org/electron-vite), [React plugin metadata](https://registry.npmjs.org/@vitejs%2fplugin-react), [Router metadata](https://registry.npmjs.org/@tanstack%2freact-router).

Use **electron-vite plus Electron Forge packaging** as the initial candidate. electron-vite documents this arrangement, but some example versions and CI snippets are old; build a minimal current configuration instead of copying them. Forge's own Vite plugin remains documented as experimental and can change across minor versions. Select one build integration, not both. [electron-vite distribution](https://electron-vite.org/guide/distribution), [Forge Vite caveat](https://www.electronforge.io/config/plugins/vite).

## Backend boundary and distribution checks

The renderer should expose application operations such as `inspectMachine`, `previewApply`, and `applyPlan`, not generic filesystem access or shell execution. Validate payloads in the privileged engine, validate IPC senders, keep Node integration disabled, and enable context isolation and renderer sandboxing. Compile the small sandboxed preload to bundled CommonJS: Electron's sandboxed preloads cannot use ESM imports. [Security guide](https://www.electronjs.org/docs/latest/tutorial/security), [ESM restrictions](https://www.electronjs.org/docs/latest/tutorial/esm).

Before selecting packages, prove these in a packaged build:

- Electron's bundled Node version satisfies Effect and chosen platform adapters. The stable releases page currently lists Electron 44.5.1 with Node 24.21.0; verify the exact runtime selected, independently of the development Node version. [Release table](https://releases.electronjs.org/).
- `src/commands/setup.mjs` assumes `process.execPath` is Node and searches adjacent npm files. A desktop runtime needs explicit installer executable discovery; built-in Node APIs do not guarantee system npm/npx availability.
- GUI launch paths discover Git, Node, agent CLIs, and Windows `.cmd` shims correctly. Replace inherited terminal output/prompts with structured progress and deliberate terminal handoff where installers require it.
- Native addons, if introduced, support Electron's ABI and target architectures. ASAR is read-only and cannot serve as a subprocess working directory; executable resources need real unpacked paths. [Native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules), [ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

Ship signed installers and macOS notarization through OS-specific CI. Electron's built-in updater covers macOS and Windows; Linux needs package-manager updates or a separately evaluated updater/distribution strategy. Tauri's updater supports signed update artifacts, with verification required. Keep app releases separate from profile revisions and skill locks. [Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Electron updater platform notices](https://www.electronjs.org/docs/latest/api/auto-updater), [Tauri updater](https://v2.tauri.app/plugin/updater/).

The first verification spike should package one read-only machine inspection and one fake installer operation on macOS, Windows, and Linux, including progress, cancellation, error delivery, executable discovery, and startup from the OS launcher. This resolves the remaining runtime and packaging uncertainty before substantial UI work.
