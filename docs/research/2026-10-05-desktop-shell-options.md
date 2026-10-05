# Desktop shell options

Researched 2026-10-05 using official documentation, publisher metadata, and source. No installation, scaffolding, benchmark, or runtime compatibility test was performed. TypeScript with Effect is the user's backend requirement; Node is our recommendation for reusing the current `.mjs` engine, not a requirement imposed by Effect.

## Best fit for this project

**Electron remains the best default for a public desktop application built around this repository.** It combines Node APIs with a controlled Chromium renderer and established distribution tooling. The existing filesystem, Git, and installer subprocess logic fits directly into its privileged process. That reduces the amount of integration we must validate while also introducing profile inheritance and sync. This is a project-specific judgment, not a claim that Electron is universally superior. [Process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [packaging](https://www.electronjs.org/docs/latest/tutorial/tutorial-packaging).

| Option | Backend arrangement | Main reason to choose it | Main cost here |
|---|---|---|---|
| Electron | TypeScript/Effect on embedded Node | Direct reuse and one bundled browser engine | Ships Chromium and requires Electron security updates |
| Tauri 2 | TypeScript/Effect in a Node or Bun sidecar; Rust shell | System webview and scoped native capabilities | Sidecar packaging, process lifecycle, and additional transport |
| Electrobun 2 | TypeScript/Effect on actual Bun, subject to testing | TypeScript desktop shell without the Tauri Rust bridge | Runtime/toolchain transition and narrower supported targets |
| Browser dashboard + local service | TypeScript/Effect on local Node or Bun | Simplest way to reuse a web dashboard and headless service | Separate service install/update/startup and browser connection security |

Keep UI and domain code independent of the shell. React, Vue, Svelte, and Solid can all render browser UI in these arrangements; choosing Electron does not select React.

## Electron

A sandboxed renderer should call application operations through validated IPC. Installation work belongs in the main/utility process; a utility process isolates hangs and crashes, but is not a permission sandbox for third-party installers. Keep renderer Node integration off and enforce context isolation, sender checks, and a restrictive content policy. [Security](https://www.electronjs.org/docs/latest/tutorial/security), [utility process](https://www.electronjs.org/docs/latest/api/utility-process).

`safeStorage` provides OS-backed encryption, but protection varies by platform. Linux can fall back to `basic_text`; the app must detect inadequate storage rather than quietly persist sensitive tokens. Credentials should remain local, with identifiers referenced by profiles. Electron's built-in updater supports macOS and Windows; Linux needs an explicit package-manager or separately evaluated updater strategy. [Credential semantics](https://www.electronjs.org/docs/latest/api/safe-storage), [updater platform notices](https://www.electronjs.org/docs/latest/api/auto-updater).

## Tauri 2

Tauri is the strongest alternative if shell footprint is a priority and maintaining a Rust launcher is acceptable. Effect logic can remain TypeScript: ship Node or a compiled Bun executable as a sidecar. Tauri's documented Node approach packages a runtime rather than requiring users to install one. Persistent communication, cancellation, restart handling, and target-specific binaries remain application responsibilities. [Sidecars](https://v2.tauri.app/develop/sidecar/), [Node example](https://v2.tauri.app/learn/sidecar-nodejs/).

Tauri capabilities constrain exposed native commands; they do not automatically constrain the privileged sidecar's implementation. System webviews require testing WebView2, WKWebView, and WebKitGTK behavior. Its updater requires signed artifacts. Stronghold is an available password-based secret vault, not automatically equivalent to OS credential storage; unlocking and key handling still need a deliberate design. [Webviews](https://v2.tauri.app/reference/webview-versions/), [updater](https://v2.tauri.app/plugin/updater/), [Stronghold](https://v2.tauri.app/plugin/stronghold/).

## Electrobun 2: viable, with qualifications

Electrobun is no longer accurately described as a beta-only project: GitHub marks **v2.0.2, released September 29, 2026**, as a non-prerelease. Its current default is **Cottontail**, not Bun. Actual Bun is selectable. Effect officially supports Bun via `@effect/platform-bun`; publisher metadata currently aligns 4.0.1 with Effect ^4.0.1. That establishes a supported runtime combination, not verified compatibility with our packaged Electrobun app. Cottontail's partial Node/Bun compatibility should not be assumed sufficient for Effect adapters. [Release](https://github.com/blackboardsh/electrobun/releases/tag/v2.0.2), [runtime choices](https://framework.blackboard.sh/electrobun/guides/native-main-process/), [Effect platforms](https://effect.website/docs/v4/platform/introduction), [Bun adapter metadata](https://registry.npmjs.org/@effect%2fplatform-bun/latest).

Its current stable release matrix includes macOS ARM64, Windows x64, and Linux x64/ARM64; no macOS Intel core artifact is published, and native Windows ARM64 is beta. Official minimum targets are macOS 14+, Windows 11+, and Ubuntu 24.04+, with other Linux distributions community-supported. Those constraints matter for public adoption. [Repository support table](https://github.com/blackboardsh/electrobun), [packaging matrix](https://framework.blackboard.sh/electrobun/guides/bundling-and-distribution/).

It offers updates and rollback, but docs explicitly distinguish its routing hash from content authentication. Windows release signing is not currently part of Hutch packaging. An actual Bun backend could use `Bun.secrets`, which is documented as experimental and requires working OS credential services. Choose this only after a packaged compatibility/distribution spike and an explicit decision to accept the target limitations. [Updates](https://framework.blackboard.sh/electrobun/guides/updates/), [signing](https://framework.blackboard.sh/electrobun/guides/code-signing/), [Bun secrets](https://bun.sh/docs/runtime/secrets).

## Browser UI plus local service

This is attractive for a CLI-first prototype or a headless companion, but does not remove desktop operations: a local service still installs agents, owns credentials, persists state, and needs distribution. Bind explicitly to loopback, authenticate clients, validate Host/Origin and mutation requests, and serve trusted UI locally. Browser same-origin rules allow some cross-origin writes, so CORS alone is not authentication. [Node listening behavior](https://nodejs.org/api/net.html#serverlistenoptions-callback), [browser origin rules](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

I would switch from Electron to Tauri if a measured package/resource budget justified the sidecar overhead. I would choose browser-first if headless service use were primary. Electrobun becomes competitive if the supported targets match our audience and its Bun/backend, signing, and update paths pass a focused packaged spike. Without those new requirements, Electron minimizes migration and distribution uncertainty.
