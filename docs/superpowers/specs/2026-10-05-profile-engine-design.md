# Profile engine

Issue #41. Follows the Tauri validation app (#39); #42 wires this engine into the CLI and the
desktop app, and #43 builds machine sync on it.

## Intent and scope

One shared TypeScript package that answers "what should this machine have?" It layers a base
profile, revision pins, and machine overrides, and records which layer decided every resolved
value. It reads today's `skills-manifest.txt`, `integrations.json` and
`claude/settings.keys.json` with exactly the meaning the CLI gives them.

In scope: the data model, validation, readers, resolution with provenance, and golden tests
against the current CLI. Out of scope: inspecting a machine, planning or applying changes,
moving any CLI command onto the engine, the desktop app, and deciding where machine overrides
are stored (all #42), and fetching or recording applied revisions (#43). The root CLI is not
changed and stays zero-dependency on Node 18+.

## Package

`packages/profile-engine/`, an independent npm package with its own lockfile like
`apps/desktop`. Its only runtime dependency is `effect@4.0.1`, pinned exactly to match the
desktop app. Dev dependencies are `typescript@7.0.2` and `@types/node`.

Sources are TypeScript restricted to erasable syntax (`erasableSyntaxOnly`), and relative imports
carry `.ts` extensions. Node 22.18+ runs them directly, so there is no build step, the
repository's no-build convention holds, and #42 can import the engine from plain `.mjs` without
a bundler. `engines.node` is `>=22.18`. Tests use `node:test` and `node:assert/strict`. They
live in `checks/*.spec.ts`, which the root `node --test` does not discover, the same split
`apps/desktop` uses.

## Layers

Resolution applies three layers, lowest first:

1. **Base profile**: the repository's declarations.
   - *Files*: the managed instruction and settings files. Today this is the `SYNC` table in
     `src/manifest.mjs`, which is code, not data. The engine carries the same table as data,
     and a golden test asserts the two stay equal until #42 deletes the CLI's copy.
   - *Settings keys*: `claude/settings.keys.json`. Its key set is the allowlist, as today.
   - *Skills*: `skills-manifest.txt`, with its source groups and `exact` and `optional` markers.
   - *Integrations*: `integrations.json`, including its `allow` list.
2. **Pins**: approved source revisions, in an optional repo file `skill-pins.json`:
   `{ "version": 1, "pins": { "<source>": "<ref>" } }`. A pin is per source, because the
   installer fetches a source at one revision. Every skill from a pinned source resolves with
   that ref. This repo has no pin file today, so it resolves with no pins and today's meaning
   is unchanged.
3. **Machine overrides**: one machine's choices, a `MachineOverrides` value:

   ```json
   {
     "version": 1,
     "manageConfig": true,
     "configTargets": ["claude", "codex"],
     "settings": { "claude:settings.json": { "effortLevel": "medium" } },
     "skills": { "explain": true, "wizard": false },
     "integrations": { "superpowers-codex": false }
   }
   ```

   Every field except `version` is optional. `manageConfig` and `configTargets` already exist as
   `skillsOnly` and `configTargets` in `state.json`. `overridesFromLegacyState` derives them
   from that file with `parseState`'s exact rules: `skillsOnly` is honoured only when it is
   literally `true`, and `configTargets` only when it is an array of known targets. The other
   overrides are new. Today a skill selection or a `--no-*` flag lasts one run; these persist
   it. Where #42 stores them on disk is #42's decision. The engine only decodes the value.

Overrides may only refer to what the base profile declares. A settings override replaces the
value of an owned key and never adds a key, so the repository's allowlist stays the only list of
keys the engine writes. A skill or integration override names a declared skill or integration
id. Overriding something undeclared is an issue, not a silent no-op. Override values pass the
same secret checks as the committed files.

## Resolved output

```ts
type Origin = { layer: 'base' | 'pin' | 'machine'; source: string } // source: a repo-relative path, 'state.json', or 'built-in'

type DesiredConfig = {
  files: Array<{
    id: string;                    // 'claude:settings.json', the state-file key the CLI uses
    target: 'claude' | 'codex';
    home: 'claude' | 'codex' | 'codex-openrouter';
    src: string; dest: string; mode: 'copy' | 'merge-keys';
    preserveProjects: boolean; capture: boolean;
    managed: boolean; from: Origin; // the machine override decides, or the base default (managed)
    keys?: Record<string, { value: unknown; from: Origin }>; // merge-keys only
  }>;
  skills: Array<{
    name: string; source: string; exact: boolean; optional: boolean;
    install: boolean; from: Origin; // the base default is !optional
    pin?: { ref: string; from: Origin };
  }>;
  integrations: Array<{ id: string; declaration: object; enabled: boolean; from: Origin }>; // the base default is `default`
  allow: Partial<Record<'agents' | 'plugins' | 'marketplaces' | 'hooks' | 'skills', string[]>>;
  issues: Issue[]; // { layer, source, path, message }
};
```

Excluded entries stay in the list with `managed`, `install` or `enabled` set to `false`, so the
dashboard can say *why* something is off. The CLI's run-time filters (`--target`,
`--with-config`, `--no-*` and interactive picks) are not configuration and are not resolved
here.

## Validation and failure

Each document validates independently, and an invalid part contributes nothing, exactly as the
CLI does today. Invalid integrations yield no integrations and no allow list. Invalid settings
keys yield an entry with no keys. An absent file means "nothing declared". Issues from every
layer are collected in `DesiredConfig.issues` rather than stopping at the first one, and
`requireValid` turns a non-empty list into a `ProfileInvalid` failure for callers that want
all-or-nothing.

Effect Schema decodes the new formats, pins and overrides. The legacy `state.json` reader ports
`parseState`'s two rules directly. The
CLI's rules for today's documents are ported as plain functions that return issues, because a
faithful port is simpler than re-expressing them as Schemas: per-type integration fields,
duplicate ids, `allow` categories, empty settings files, and the name and value patterns from
`src/secrets.mjs`. Legacy error wording is not reproduced; the golden tests compare *whether* a
document is refused, not the message.

## Effect boundary

Resolution is pure: `resolveProfile({ base, pins, overrides }) => DesiredConfig` performs no
I/O. Effect owns loading. A `ProfileFiles` service (`Context.Service`) provides
`readText(path)` (with `undefined` for an absent file) and `exists(path)`, the latter for the
hook `file` check. The `nodeFiles` layer reads through `node:fs/promises`, and
`memoryFiles(record)` serves tests. `loadProfile(repoDir, { overrides? })` returns
`Effect<DesiredConfig, ReadFailed, ProfileFiles>`. An unreadable file is a `ReadFailed`, which
differs from an absent one. Errors are tagged (`ReadFailed`, `ProfileInvalid`). The
engine does not use `@effect/platform-node`: four filesystem calls do not justify its
dependency graph.

## Testing

Tests are written first, one module at a time.

- **Unit tests** cover each reader and validator, and resolution including layer precedence,
  provenance of every value, overrides of undeclared items, secret checks on override values,
  pins on unknown sources, and legacy state rules.
- **Golden tests** import the CLI's own modules from `src/` as the reference and run against
  this repository's real files and a fixture corpus: CRLF manifests, names before a header,
  unknown markers, exact plus optional sources, every integration refusal, secrets, empty or
  missing files, and a missing hook file. They check four things:
  - **Files**: managed entries equal `configEntries(SYNC, 'all', configTargets)`, or none when
    `skillsOnly`. This holds for every legacy `state.json` variant read through
    `parseConfigMode` with `NORTUSCC_STATE_DIR` set to a temporary directory.
  - **Settings**: owned keys and values equal the parsed file, and a refused file matches
    `validateOwnedKeys` refusing it.
  - **Skills**: the flattened list of name, source and markers equals `parseManifest`'s groups
    flattened, which is the CLI's own view of them in `reconcile`. `install` equals the CLI's
    default selection (`!optional`).
  - **Integrations**: accepted declarations and `allow` deep-equal `validateIntegrations`'s
    output, `enabled` equals `default`, and refusal matches.

Done when the package's tests and typecheck pass, the golden tests pass against this
repository's configuration, and the root `npm test` still passes. The baseline is 725 of 725
with `NORTUSCC_REPO_DIR` set to the checkout.
