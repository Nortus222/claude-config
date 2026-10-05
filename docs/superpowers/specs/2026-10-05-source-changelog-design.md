# Changelog draft from source reports

Part of #52 (Authoring). The Sources watcher
(`docs/superpowers/specs/2026-10-05-source-watch-design.md`) reports changelog material and
leaves the prose to Publish. This slice turns that material into the drafted changelog the
Publish screen shows (`docs/superpowers/specs/2026-10-05-desktop-ui-feature-map-design.md`,
Publish row and journey 2).

## Intent and scope

A pure, deterministic function: given the watcher's `SourceReport`s and the sources the author
brought into Contents, it returns an editable Markdown draft. No git, network or LLM.

In scope: `draftChangelog` and its types in `packages/source-watch/src/changelog.ts`, its tests,
export lines in `src/index.ts`, and a README section. Out of scope: storing the draft, a
revision title or number, the secret scan, local edits, and the Publish screen itself. No other
source-watch file changes; `src/`, `packages/profile-engine` and `apps/desktop` are untouched.

Two facts shape the design. Pins are per source, so bringing in a revision moves every skill of
that source, including ones the author chose not to describe. And a report's `added` lists
upstream skills that are not in the setup: a non-exact source discovers them, it does not install
them.

## Interface

```ts
type AcceptedSource = {
  readonly source: string;
  readonly revision: string;                 // full sha the author brought in
  readonly ignored?: ReadonlyArray<string>;  // changed or removed skills to name without detail
  readonly added?: ReadonlyArray<string>;    // names from the report's `added` now in the setup
};

type SkippedSource = { readonly source: string; readonly reason: 'not-watched' | 'stale' | 'no-data' };

type ChangelogDraft = {
  readonly markdown: string;                 // '' when there is nothing to say
  readonly skipped: ReadonlyArray<SkippedSource>;
};

function draftChangelog(
  reports: ReadonlyArray<SourceReport>,
  accepted: ReadonlyArray<AcceptedSource>,
): ChangelogDraft;
```

## Selection

Only accepted sources appear, in report order (the manifest's order), whatever the order of
`accepted`. For each accepted source:

- No report with that `source`: skipped as `not-watched`.
- Status `unreachable` or `baseline-missing`: skipped as `no-data`.
- `revision` differs from `report.latest.sha`: skipped as `stale`. A report describes only
  baseline..latest, so a draft for any other revision would list commits the author did not
  review. The caller watches again and retries.
- Status `up-to-date`: nothing is written and the source is not skipped.

`skipped` lists sources in `accepted` order. It is for the caller, never part of the Markdown.

## Rendering

Each drafted source is a `##` heading followed by a flat list. Sources are separated by one
blank line, and the Markdown ends with a single newline (or is `''`).

Heading: `## <source> <from> → <to>` for `ahead` and `diverged`, and `## <source> pinned at
<to>` for `unpinned`. `<to>` labels `latest`, `<from>` labels `baseline`. A label is a tag of the
revision when it has one: tags containing a digit are preferred, and the highest of them in
numeric-aware order (`localeCompare` with `numeric: true`) wins, else the first tag. With no tag
it is the sha's first seven characters.

List items, in this order:

1. `- Updated \`<name>\`` for each `changed` skill not ignored, in declared order, with its commit
   subjects as nested items (`  - <subject>`). Subjects are taken from the report's `commits` for
   the skill's shas, newest first. Merge noise (subjects starting `Merge pull request`,
   `Merge branch` or `Merge remote-tracking branch`) and repeated subjects are dropped. A skill
   left with no subjects is listed without nested items.
2. `- Added \`<name>\`` for each name in `added` that the report's `added` contains, in the
   report's order. Names it does not contain are ignored.
3. `- Removed \`<name>\`` for each `removed` skill not ignored, in declared order.
4. `- Also updated: \`a\`, \`b\`` naming the ignored skills that are `changed` or `removed`, in
   declared order. Their content still reaches followers when the pin moves, so they stay
   visible; the author can delete the line.

When none of these apply, the list is `- No changes to this setup's skills.` `unchanged` and
`missing` skills, `local` reports and commit authors are never written.

Example:

```markdown
## obra/superpowers v6.4.1 → v6.5.0

- Updated `brainstorming`
  - Ask one question at a time
  - Fix typo in checklist
- Added `new-skill`
- Removed `old-skill`
- Also updated: `writing-plans`

## Nortus222/agent-skills a1b2c3d → e4f5a6b

- Updated `explain`
  - Add worked example
```

## Secrets

Source names and commit subjects pass through `redact` before they are written. Commits never
carry emails, and author names are not written. Labels come from tags and shas only.

## Testing

Test-first, in `checks/changelog.spec.ts`, with hand-built `SourceReport` values and no git:

- a full draft compared exactly against expected Markdown (two sources, every item kind)
- labels: tag preferred over sha, the highest version-like tag among several, a non-version
  tag when it is the only one, a short sha without tags
- up-to-date omitted; `stale`, `no-data` and `not-watched` skipped; empty result is `''`
- unpinned heading
- ignored skills moved to the "Also updated" line; `added` limited to the report's `added`
- merge and duplicate subjects dropped; a changed skill with no subjects
- the "No changes" line
- report order wins over `accepted` order
- a credential in a source name or subject never appears in the output

Done when the package's tests and typecheck pass.

## Known limits

- A declared skill that exists only at latest shows as "Updated": the report does not separate
  it from a changed skill.
- Only a report's `latest` can be drafted; drafting an older revision needs a fresh watch with a
  matching target, which the watcher does not support yet.
- Subjects are written as upstream wrote them, apart from redaction; Markdown in them is not
  escaped.
