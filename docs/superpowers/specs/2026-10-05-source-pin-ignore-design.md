# Bringing a version into Contents and ignoring a version

Part of #52 (Authoring). This is the write side of the Sources screen in
`docs/superpowers/specs/2026-10-05-desktop-ui-feature-map-design.md`. The sources watcher
(`docs/superpowers/specs/2026-10-05-source-watch-design.md`) reports new revisions. This slice
lets the author act on them:

- **Bring a version into Contents** sets or changes a source's pin in `skill-pins.json`.
- **Ignore a version** records that the author has seen a source's latest revision, so it is
  no longer flagged as new until upstream moves past it.

## Scope

In scope:

- a data-layer API in `packages/source-watch/`
- a pin-impact preview, so a UI can warn before a pin moves several skills
- offline tests

Out of scope:

- UI, CLI and agent wiring
- editing the skills manifest
- publishing

`src/`, `packages/profile-engine` and `apps/desktop` are not changed. Within
`packages/source-watch/`, only new files and export lines in `src/index.ts` are added. A
parallel slice is editing that package.

## Placement

The code is new files in `packages/source-watch/`, not a new package. The impact preview needs
`Git`, `skillFolders` and `cacheFolder` from source-watch at run time. Node does not strip types
from `.ts` files under `node_modules`, so a sibling package could only import source-watch's
types, never its code. For the same reason, document validation mirrors the engine's
`parsePins` rather than importing it.

| File | Purpose |
| --- | --- |
| `src/documents.ts` | Pure edit of a `{ version: 1, <field>: { <source>: <value> } }` document, and a shared backup-then-replace writer |
| `src/pins.ts` | `pinSource`: write or remove a source's pin in `skill-pins.json` |
| `src/ignores.ts` | `ignoreRevision`, `readIgnores`, `isIgnored` for `source-ignores.json` |
| `src/impact.ts` | `pinImpact`: which of a source's declared skills a pin change moves |

## Documents

`skill-pins.json` is `{ "version": 1, "pins": { "<source>": "<ref>" } }`, the engine's existing
format.

`source-ignores.json` is new and lives in the repository root next to it. It is
`{ "version": 1, "ignored": { "<source>": "<sha>" } }`. Ignoring is an authoring decision, like
pinning, so it is committed and syncs across the author's machines through git. The profile
engine never reads it, so it never affects an install. It is public, but it holds only source
names and commit shas, which pins already expose.

```ts
type Edited = { readonly text: string; readonly previous?: string };

class DocumentInvalid extends Data.TaggedError('DocumentInvalid')<{ readonly reason: string }> {}

function editEntry(
  text: string | undefined, // the current file, or undefined when absent
  field: 'pins' | 'ignored',
  source: string,
  value: string | undefined, // undefined removes the entry
): Edited; // throws DocumentInvalid
```

`editEntry` is pure. When the current text is undefined, it starts from
`{ "version": 1, "<field>": {} }` with two-space indentation and LF line endings. Otherwise it
parses the text and keeps the following, so the diff touches only the changed line:

- **Key order.** An existing key is replaced in place, and a new key is appended.
- **Unknown top-level fields.** They are kept as they are.
- **Indentation.** It is taken from the first indented line, and defaults to two spaces.
- **Line endings.** CRLF is kept when the text uses it.
- **Final newline.** It is kept when present.

A compact single-line document comes back with that indentation. Removing an absent key returns
the text unchanged.

`previous` is the old value of the entry, or absent when there was none. A document is invalid,
and is never rewritten, when any of these hold:

- it is not JSON
- it is not an object
- `version` is not `1`
- `<field>`, when present, is not an object whose keys and values are all non-empty strings

The reason names the file and the problem, and passes through `redact`.

## Writing

```ts
type WriteOptions = { readonly backupDir: string };
type Written = { readonly previous?: string; readonly backup?: string }; // backup: absolute path

class WriteFailed extends Data.TaggedError('WriteFailed')<{ readonly reason: string }> {}

const pinSource: (repoDir: string, source: string, ref: string | undefined, options: WriteOptions)
  => Effect.Effect<Written, DocumentInvalid | WriteFailed>;
const ignoreRevision: (repoDir: string, source: string, sha: string | undefined, options: WriteOptions)
  => Effect.Effect<Written, DocumentInvalid | WriteFailed>;
```

Both share one writer:

1. **Validate the input.** `source` must be non-empty. A pin `ref` must be non-empty and must not
   start with `-`. An ignored `sha` must be a full 40- or 64-hex commit sha, because tags move.
   Invalid input fails with `DocumentInvalid`, and nothing is touched.
2. **Read and edit** the file with `editEntry`. An invalid document fails here, and nothing is
   touched.
3. **Skip unchanged text.** If the new text equals the old, nothing is written, no backup is
   made, and `Written` has only `previous`.
4. **Back up.** If the file exists, copy it to `<backupDir>/<file>.<timestamp>` before writing.
   The timestamp is UTC `YYYYMMDDTHHMMSSmmmZ`, with a `-<n>` suffix if the name is already
   taken. `backupDir` is created if needed. The caller chooses it, for example the CLI's
   `<stateRoot>/backups`. This follows the repository's rule that nothing destructive runs
   without a backup.
5. **Replace.** Write `<file>.<random>.tmp` beside the file, then rename it over the file, so a
   reader never sees a half-written document.

I/O errors become `WriteFailed` with a redacted reason. Neither function checks that the source
is in the skills manifest. The engine already reports a pin on an unknown source as an issue.

**Undo.** Call the same function with `previous`. That is `undefined` for an entry that did not
exist, which removes it. The `backup` copy, and git history, are the fallbacks.

Pinning does not change `source-ignores.json`. An ignore entry for a source that is now pinned
at that revision matches nothing, so it is harmless.

## Ignoring

```ts
type Ignores = Readonly<Record<string, string>>; // source → ignored sha

function readIgnores(text: string | undefined): { readonly ignores: Ignores; readonly problem?: string };
function isIgnored(report: SourceReport, ignores: Ignores): boolean;
```

`readIgnores` is lenient, like the engine's `parsePins`. An absent file ignores nothing. An
invalid file also ignores nothing, and returns the redacted reason as `problem`.

`isIgnored` is true when all of these hold:

- the report's status is `ahead` or `diverged`
- it has a `latest`
- `latest.sha` equals the source's ignored sha, compared case-insensitively

Once upstream moves past the ignored sha, the source is flagged again. Each source holds at most
one ignored sha, so ignoring a newer revision replaces the old entry. The report type is
unchanged, and callers combine the two.

## Pin impact

```ts
type PinImpact = {
  readonly source: string;                                  // redacted
  readonly from?: { readonly ref: string; readonly sha: string }; // absent when unpinned and HEAD is used
  readonly to: { readonly ref: string; readonly sha: string };
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly status: 'unchanged' | 'changed' | 'removed' | 'missing';
  }>;
};

class RefMissing extends Data.TaggedError('RefMissing')<{ readonly reason: string }> {}

const pinImpact: (source: WatchedSource, ref: string, options: { readonly cacheDir: string })
  => Effect.Effect<PinImpact, GitFailed | RefMissing, Git>;
```

Pins are per source, so bringing in one skill's change moves every skill from that source.
`pinImpact` reports, for every declared skill of the source in declared order, what moving the
pin from its current baseline to `ref` does. A UI shows the list before calling `pinSource`.
`ref` can be any revision: latest, a tag, or an intermediate commit from the report's `commits`.

1. **Cache.** It uses the source's cache folder from the watcher (`cacheFolder(cacheDir, url)`).
   When the folder is absent, it is created with the watcher's bare partial clone. An existing
   cache is not refreshed; the watch run that produced the report already did that.
2. **Resolve.** Resolve the target and the baseline with the watcher's rule:
   - `rev-parse --verify --quiet <ref>^{commit}`
   - a ref starting with `-` reads as missing
   - a full sha absent from the cache is fetched by id once

   A target that does not resolve fails with `RefMissing`, and so does a baseline that does not
   resolve. An unpinned source compares against `HEAD`, which is what it installs today, and
   `from` is absent.
3. **Compare.** Discover skill folders at both revisions with `skillFolders` over
   `ls-tree -r --name-only -z`. For each declared skill:
   - `missing` when it is at neither revision
   - `removed` when it is only at the baseline
   - `changed` when it is only at the target
   - `unchanged` when the folder tree shas are equal
   - `changed` otherwise

Diffs are not computed; the watcher's report already carries them. Reasons pass through
`redact`.

## Exports

`src/index.ts` gains export lines for these:

- `editEntry`, `DocumentInvalid`, `WriteFailed`
- `pinSource`, `PINS_FILE`
- `ignoreRevision`, `readIgnores`, `isIgnored`, `IGNORES_FILE`
- `pinImpact`, `RefMissing`

It also exports these types: `Edited`, `Written`, `WriteOptions`, `Ignores` and `PinImpact`.

## Testing

Tests are written first and run offline, in `checks/*.spec.ts`.

- **`editEntry`:**
  - a new document
  - adding, replacing and removing an entry
  - removing an absent entry
  - key order, unknown fields, tab and four-space indentation, CRLF, and a missing final newline
  - each invalid-document case
- **Writes** (`mkdtemp` repo and backup directories):
  - pin and unpin
  - the backup exists with the old content
  - no backup when the file was absent or nothing changed
  - an invalid file is left byte-for-byte untouched, with no backup
  - refused refs and shas
  - an undo round trip restores the original text
  - no `.tmp` file is left behind
- **`readIgnores` and `isIgnored`:**
  - absent and invalid files
  - a match on `ahead` and on `diverged`
  - no match on other statuses, after upstream moves, or for another source
- **`pinImpact`**, against `checks/fixtures.ts` repos over `file://` with
  `nodeGit({ allowProtocols: 'file' })`:
  - latest, a tag and an intermediate commit
  - changed, unchanged, removed and added-at-target skills
  - an unpinned source against `HEAD`
  - a missing target and a missing baseline
  - a first run with no cache

Done when the package's tests and typecheck pass, no test touches the network, and the root
`npm test` still passes.

## Known limits

- **Concurrent writes.** Two writers of the same file race. The last rename wins, and both
  backups survive.
- **Ignore granularity.** An ignore covers exactly one sha. Ignoring a branch or a tag pattern
  is not supported.
- **Stale cache.** `pinImpact` does not refresh an existing cache, so it can be as stale as the
  last watch run. A full-sha target is still fetched on demand.
