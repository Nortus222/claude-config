# TypeScript and Effect in an npm-workspaces monorepo on Node 24, with no build step

The CLI was zero-dependency `.mjs` on Node 18+, which a desktop app could not type-check or
share. The repo is now an npm-workspaces monorepo on Node 24+, which runs erasable-syntax
TypeScript directly. `effect`, pinned exactly, is the one runtime dependency, and tests stay on
`node:test`: types, typed errors, cancellation and injectable services without a build step.

## Considered options

- pnpm, project references and Vitest: build steps and test dependencies for no current gain.
- `@effect/platform-node`/`-bun`: a heavy dependency graph and unstable modules. The packages use
  `node:` builtins behind their own services, so the same code runs on Node and Bun.

## Consequences

- Node does not strip types under `node_modules`, so an `npx github:` copy only bootstraps: it
  clones a checkout, runs `npm ci` and hands off. The tool is not published to npm.
- Legacy `.mjs` is edited, never added, until the cutover (#59).
