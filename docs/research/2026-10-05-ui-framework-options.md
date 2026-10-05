# UI framework options, checked 2026-10-05

## Separate the decisions

Electron and Tauri supply the desktop shell. React, Solid, Svelte, and Vue implement the web UI inside it. Choosing Electron does not require React, and the fixed TypeScript + Effect backend does not require Effect in the renderer. Keep the UI behind typed asynchronous commands and operation events so either decision can change independently.

For this project's profile editor, skills catalog, configuration provenance, machine status, and installation progress, I would shortlist React and Svelte first. React remains my default because the combination of typed navigation, accessible complex widgets, and explicit state transitions suits this UI. Svelte is the strongest alternative if concise templates and editable forms matter more to the owner. Solid and Vue are viable choices, not technical dead ends. This ordering is a project judgment, not a claim about framework performance or popularity.

Registry `latest` snapshots are React `19.3.0`, Solid `1.9.15`, Svelte `5.57.1`, and Vue `3.5.43`. These are verified observations, not installation instructions. [React metadata](https://registry.npmjs.org/react/19.3.0), [Solid metadata](https://registry.npmjs.org/solid-js/1.9.15), [Svelte metadata](https://registry.npmjs.org/svelte/5.57.1), [Vue metadata](https://registry.npmjs.org/vue/3.5.43).

## Practical comparison

| Framework | State and authoring | Fit and tradeoff for this app |
| --- | --- | --- |
| React | TSX; explicit state setters and reducers; external subscription hook | Clear operation-state transitions and composable editor widgets. Requires care with derived state, hook lifecycles, and stale asynchronous responses. |
| Svelte 5 | Typed single-file components; `$state`, `$derived`, bindings | Direct form editing and derived override/provenance views. Compiler-specific reactive syntax and routing choice add conventions. |
| Solid | TSX; signal getters/setters and nested stores | Good match for row-level status and progress subscriptions. JSX resembles React but its execution/reactivity rules differ. |
| Vue 3 | Typed single-file components; Composition API `ref`, `reactive`, `computed` | Clear separation of templates and reusable typed composables for forms. Ref unwrapping and reactive-object behavior need consistent conventions. |

React recommends avoiding duplicated or contradictory state. Keep editable drafts separate from the last inspected machine snapshot, and derive comparison views rather than saving both. `useSyncExternalStore` connects a reusable operation/event store to React with a defined unsubscribe contract. [React state design](https://react.dev/learn/choosing-the-state-structure), [external store hook](https://react.dev/reference/react/useSyncExternalStore).

Svelte's `$state` makes plain objects and arrays deeply reactive; `$derived` expresses calculated values. This fits nested settings forms, but destructuring reactive values can capture a nonreactive snapshot. Keep shared reactive UI code in `.svelte.ts` modules and send plain snapshots through IPC. [State](https://svelte.dev/docs/svelte/$state), [derived state](https://svelte.dev/docs/svelte/$derived), [TypeScript](https://svelte.dev/docs/svelte/typescript).

Solid signals expose accessor functions; stores track nested object properties. Keep event subscriptions inside component lifecycles, and read tracked values in reactive contexts rather than copying them once. [Signals](https://docs.solidjs.com/concepts/signals), [stores](https://docs.solidjs.com/concepts/stores), [TypeScript](https://docs.solidjs.com/configuration/typescript).

Vue's Composition API supports typed props, refs, and computed values. A composable can own an operation subscription, cancellation, and cleanup without embedding backend services in components. [TypeScript](https://vuejs.org/guide/typescript/composition-api), [reactivity](https://vuejs.org/guide/essentials/reactivity-fundamentals.html).

## Routes, data, and accessible components

React and Solid can use TanStack Router for typed paths, parameters, search state, and loaders. This is useful for profile IDs and persistent skills filters. Vue Router supports typed routes through manual maps or route generation. SvelteKit supplies generated route types and can build a static client-only app; using it for desktop routing does not require adopting its server endpoints or changing the Effect backend. A small Svelte desktop UI can also start with explicit view navigation rather than a full application framework. [TanStack Router](https://tanstack.com/router/latest/docs/overview), [Vue typed routes](https://router.vuejs.org/guide/advanced/typed-routes.html), [SvelteKit types](https://svelte.dev/docs/kit/types), [SvelteKit SPA mode](https://svelte.dev/docs/kit/single-page-apps).

TanStack Query supports all four and accepts promise-returning query functions, so a query can call the IPC client rather than HTTP. Adopt caching only when repeated reads and invalidation warrant it. Installation is a backend operation, not a retried query. Backend events should invalidate affected snapshots or update operation progress. [Supported adapters](https://tanstack.com/query/latest/docs/framework), [query functions](https://tanstack.com/query/latest/docs/framework/react/guides/query-functions).

Component options include React Aria or Radix for React, Kobalte for Solid, Bits UI for Svelte, and Reka UI for Vue. Their documented focus handling, keyboard interactions, and ARIA behavior apply directly to setup dialogs, selectors, tabs, and override controls. Application labels, composition, and assistive-technology testing remain our responsibility. [React Aria](https://react-aria.adobe.com/), [Radix](https://www.radix-ui.com/primitives/docs/overview/accessibility), [Kobalte](https://kobalte.dev/docs/core/overview/introduction/), [Bits UI](https://www.bits-ui.com/docs), [Reka](https://reka-ui.com/docs/overview/accessibility).

## Effect integration

Start with a shared contract such as `inspectProfile(): Promise<Snapshot>`, `applyPlan(): Promise<OperationId>`, and `subscribeOperation(id, callback): Unsubscribe`. Every framework can consume this interface. Keep inheritance, validation, resource ownership, retries, and installer coordination in the backend. UI drafts and presentation remain framework state.

Optional Effect Atom bindings currently exist at `4.0.1` for React, Solid, and Vue. Their peers require React `>=19 <20` plus scheduler `>=0.25 <0.28`, Solid `>=1.9.14 <2`, or Vue `>=3.5.39 <4`, respectively, alongside Effect `^4.0.1`. No package was found under `@effect/atom-svelte` or `@effect-atom/atom-svelte`; this does not exclude community integrations. The core Atom module remains marked unstable. [React peers](https://registry.npmjs.org/@effect/atom-react/4.0.1), [Solid peers](https://registry.npmjs.org/@effect/atom-solid/4.0.1), [Vue peers](https://registry.npmjs.org/@effect/atom-vue/4.0.1), [Atom source](https://unpkg.com/effect@4.0.1/src/reactivity/Atom.ts).

Backend Effect is not sufficient reason to add Atom. First compare one representative profile-editing screen and a cancellable operation flow in the shortlisted frameworks. No packages were installed, and no runtime or accessibility validation was performed for this research.
