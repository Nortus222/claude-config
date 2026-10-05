# Profile engine

Resolves what a machine should have: the repository's base profile, approved revision pins
(`skill-pins.json`), and one machine's overrides. Every resolved value records the layer and
document that decided it. Design: `docs/superpowers/specs/2026-10-05-profile-engine-design.md`.

The engine reads today's `skills-manifest.txt`, `integrations.json` and
`claude/settings.keys.json` with the CLI's meaning. Golden tests in `checks/golden.spec.ts`
compare it with the CLI's own modules. Nothing in the CLI or the desktop app uses it yet; #42
wires it in.

Sources are TypeScript run directly by Node 24+ through type stripping, so there is no build
step. Node does not strip types inside `node_modules`; consume the package through a workspace or
`file:` link.

```sh
npm ci
npm test
npm run typecheck
```
