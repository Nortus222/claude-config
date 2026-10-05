# Sources watcher

Part of #52 (Authoring), phase P3 of the UI and feature map
(`docs/superpowers/specs/2026-10-05-desktop-ui-feature-map-design.md`). The profile engine
(`docs/superpowers/specs/2026-10-05-profile-engine-design.md`) supplies the sources and pins.

## Intent and scope

The data layer behind the Sources screen. Given the skill sources a setup uses, it reports for
each source the latest upstream revision, whether that is ahead of the source's baseline, the
commits in between, which of the setup's skills changed with their `SKILL.md` diffs, and the
material a changelog is drafted from. For the author's own local checkouts it also reports edits
not yet pushed.

In scope: a standalone package, its input adapter from `DesiredConfig`, git access through an
injectable service, and offline tests. Out of scope: wiring it into the CLI (a later
`nortuscc outdated`) or the desktop app, bringing a version into Contents, ignoring a version,
release notes from a hosting API, drafting changelog prose, and storing where the author's local
checkouts live. `src/`, `packages/profile-engine` and `apps/desktop` are not changed.

Pin only: followers receive what is published. Only the author watches sources, and watching
never changes a pin.

## Package

`packages/source-watch/`, an independent npm package with its own lockfile, mirroring the
profile engine: `effect@4.0.1` as the only runtime dependency, `typescript@7.0.2` and
`@types/node` as dev dependencies, erasable TypeScript with `.ts` relative imports run directly
on Node 22.18+, and tests in `checks/*.spec.ts` with `node:test` and `node:assert/strict`.

It consumes the engine's types only: `import type { DesiredConfig } from
'@nortuscc/profile-engine'`, through a `file:../profile-engine` dev dependency. The import is
erased at run time. Type-checking resolves the engine's own imports from
`packages/profile-engine/node_modules`, so `npm run typecheck` needs `npm ci` in both packages.

## Input

```ts
type WatchedSource = {
  readonly source: string;          // as the manifest writes it, e.g. 'mattpocock/skills'
  readonly url: string;             // what is fetched; see below
  readonly baseline?: string;       // a ref: the pin, or whatever the caller compares against
  readonly exact: boolean;          // an exact source does not report skills added upstream
  readonly skills: ReadonlyArray<string>; // the setup's skills from this source
  readonly checkout?: string;       // absolute path of the author's local git checkout
};
```

`sourcesFrom(config, { checkouts? })` is pure. It groups `config.skills` by `source` in first-seen
order and includes every declared skill, whether or not this machine installs it. `url` is the
source itself when it already looks like a URL (contains `://` or starts with `git@`), else
`https://github.com/<source>.git`, the CLI's own fallback. `baseline` is
the source's pin ref. Pins are per source, so every skill of a source carries the same pin. A
source is `exact` when any of its manifest groups is. `checkouts` maps a source to a local path.
Callers may also build `WatchedSource` values by hand, for example to give an unpinned source a
baseline.

## Output

```ts
type Revision = { readonly sha: string; readonly date: string; readonly tags: ReadonlyArray<string> };
type Commit = { readonly sha: string; readonly subject: string; readonly author: string; readonly date: string };

type SkillChange = {
  readonly name: string;
  readonly path?: string;           // folder in the repo at latest, or at baseline when removed
  readonly status: 'unchanged' | 'changed' | 'removed' | 'missing';
  readonly commits: ReadonlyArray<string>; // shas from the source's `commits` that touched the folder
  readonly skillMd?: string;        // unified diff of SKILL.md, baseline → latest
  readonly files: ReadonlyArray<string>; // other changed files in the folder, repo-relative
};

type LocalReport = {
  readonly path: string;
  readonly status: 'clean' | 'edits' | 'no-upstream' | 'not-a-repo';
  readonly branch?: string;
  readonly unpushed: ReadonlyArray<Commit>;      // @{u}..HEAD, newest first
  readonly uncommitted: ReadonlyArray<string>;   // changed, staged or untracked paths
  readonly skills: ReadonlyArray<{ readonly name: string; readonly path: string; readonly skillMd?: string }>;
};

type SourceReport = {
  readonly source: string;
  readonly url: string;             // redacted
  readonly status: 'up-to-date' | 'ahead' | 'diverged' | 'unpinned' | 'baseline-missing' | 'unreachable';
  readonly reason?: string;         // redacted, for baseline-missing and unreachable
  readonly latest?: Revision;
  readonly baseline?: Revision & { readonly ref: string };
  readonly commits: ReadonlyArray<Commit>;   // baseline..latest, newest first
  readonly skills: ReadonlyArray<SkillChange>;
  readonly added: ReadonlyArray<string>;     // non-exact only: skills new upstream since baseline
  readonly local?: LocalReport;
};
```

Changelog material is the commits per skill, with their subjects, plus the version tags at each
end, for example `v6.4.1 → v6.5.0`. Publish drafts the prose from it later. Dates are ISO 8601
strict committer dates.

## Git service

```ts
class Git extends Context.Service<Git, {
  readonly run: (args: ReadonlyArray<string>, options?: { readonly cwd?: string }) => Effect.Effect<string, GitFailed>;
}>()('source-watch/Git') {}
```

`run` returns stdout, and a non-zero exit is a `GitFailed { reason }` built from stderr. The
`nodeGit({ allowProtocols? })` layer spawns `git` without a shell and with `GIT_TERMINAL_PROMPT=0`,
so git never prompts. When `allowProtocols` is given, it sets `GIT_ALLOW_PROTOCOL`. Tests pass
`'file'`, so an accidental network URL fails rather than connecting. The layer leaves the user's
credential helpers in place, because private sources need them, and sets none of its own.

## Per source

`watchSource(source, { cacheDir })`:

1. **Sync.** The source's cache lives at `<cacheDir>/<sha256(url) first 16 hex>`, never named
   after the URL. When that folder is absent, it is created with
   `git clone --bare --filter=blob:none --quiet <url> <dir>`. When it exists,
   `git fetch --prune --tags --quiet origin '+refs/heads/*:refs/heads/*'` refreshes it.
   History arrives in full, and git fetches only the blobs a diff needs. If sync fails, the status
   is `unreachable`.
2. **Latest** is `HEAD`, the default branch at clone time, with its sha, committer date and the
   tags that point at it.
3. **No baseline** gives `unpinned`. The report has `latest` and the declared skills' paths at
   latest, with `unchanged` or `missing` status, and no commits.
4. **Baseline.** Resolve `<ref>^{commit}`; a ref starting with `-` is never passed to git and
   reads as missing. If that fails and the ref is a full-length sha, try
   `git fetch origin <ref>` once and resolve again. If it still fails, the status is
   `baseline-missing`.
   An `unreachable` or `baseline-missing` report has no skills.
5. **Status.** `up-to-date` when the baseline equals latest. `ahead` when the baseline is an
   ancestor of latest. `diverged` otherwise, for example after a force-push or with a pin on
   another branch.
6. **Commits.** `git log baseline..latest`, newest first. It records the sha, subject, author
   name and committer date. Emails are never read.
7. **Skills.** Discover skill folders at both revisions from `git ls-tree -r --name-only`. The
   rule is the CLI's (`upstreamSkills` in `src/skill-updates.mjs`): a folder holding `SKILL.md`,
   excluding the repo root, with the shallowest folder winning over nested ones. A skill's name is
   its folder's basename, and when two folders share a name, the first in path order wins. For
   each declared skill:
   - `missing`: it is not at latest or at baseline.
   - `removed`: it is at baseline but not at latest.
   - `unchanged`: the folder tree sha is equal at both revisions.
   - `changed`: otherwise. A skill that only exists at latest counts as changed, and its whole
     `SKILL.md` diffs against nothing.

   A changed skill gets `commits` from `git log --format=%H baseline..latest -- <folder>`,
   `skillMd` from `git diff --no-color --no-ext-diff baseline latest -- <folder>/SKILL.md`, and
   `files` from `--name-only` over the folder, minus `SKILL.md`. When the folder moved, the diff
   compares the two paths. `added` lists names discovered at latest but not at baseline that the
   setup does not declare. It is empty for an exact source.
8. **Local checkout**, when given. It is read-only and never fetches. The checkout must be a git
   work tree (`rev-parse --is-inside-work-tree`), or the status is `not-a-repo`.
   - `branch` comes from `rev-parse --abbrev-ref HEAD`.
   - `uncommitted` comes from `status --porcelain=v1 -z --untracked-files=all`.
   - Skill folders are discovered from `ls-files --cached --others --exclude-standard`.
   - With an upstream, `unpushed` is `log @{u}..HEAD`. Local edits are measured from
     `merge-base HEAD @{u}`, so upstream commits not yet pulled are not mistaken for local ones.
     Each discovered skill whose folder has a path changed since that point (committed,
     staged, unstaged or untracked) gets `diff <merge-base> -- <folder>/SKILL.md`, or for an
     untracked `SKILL.md`, `diff --no-index /dev/null <file>`.
   - With no upstream, the status is `no-upstream`, and edits are measured from `HEAD`.
   - The status is otherwise `clean` or `edits`.

`watchSources(sources, { cacheDir })` runs `watchSource` for up to four sources at once and
returns `Effect<ReadonlyArray<SourceReport>, never, Git>` in input order. A failure in one source
is confined to that source's report.

## Secrets

Nothing the package returns contains credentials:

- `redact(text)` strips userinfo from URLs (`https://user:token@host` becomes `https://host`)
  and masks the values of `token`, `access_token`, `password` and `key` query parameters.
- Every `url` and `reason` passes through `redact`, and so does any git stderr before it becomes
  a `GitFailed` reason.
- Cache folders are named by hash, so a credential in a URL never reaches the filesystem layout.
- Commit emails are never requested.

Diffs are upstream content and are reported as they are. The mandatory secret scan belongs to
Publish (#52, later slice).

## Testing

Tests are written first. They cover:

- **Pure units:** skill discovery (nesting, root `SKILL.md`, duplicate names), `sourcesFrom`
  (grouping, pins, exact, checkouts, uninstalled skills kept) and `redact`.
- **Integration:** fixture repos built by `checks/fixtures.ts` in an `mkdtemp` directory, with
  fixed author and committer identities and dates, and `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1` so the developer's git config cannot interfere. They are reached by
  `file://` URLs through `nodeGit({ allowProtocols: 'file' })`. The cases are:
  - up to date
  - ahead with a tag pin and with a sha pin
  - unpinned
  - a missing baseline
  - diverged after a history rewrite
  - changed, unchanged, removed and missing skills, with `SKILL.md` diffs and other files
  - `added` on a non-exact source but not on an exact one
  - a second run that fetches into an existing cache
  - an unreachable source, which leaves its neighbours unaffected
  - a URL with a credential that never appears in the output
  - a local checkout with unpushed commits, staged, unstaged and untracked edits, a new untracked
    skill, no upstream, and not a repo
  - an `https://` URL that is refused under the `file`-only protocol allowlist

Done when the package's tests and typecheck pass, no test touches the network, and the root
`npm test` still passes.

## Known limits

- When an upstream repository renames its default branch, the cache keeps following the old
  `HEAD`. Deleting that source's cache folder fixes it.
- Diffs are not size-capped.
- A local checkout's comparison uses whatever its remote-tracking branch last fetched.
