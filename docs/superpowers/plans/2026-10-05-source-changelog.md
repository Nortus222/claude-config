# Changelog Draft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure `draftChangelog(reports, accepted)` in `packages/source-watch` that turns the Sources watcher's reports into an editable Markdown changelog draft for Publish.

**Architecture:** One new module, `src/changelog.ts`. It selects the accepted sources a report can describe (others go to `skipped`), then renders each as a `##` heading with version labels and a flat list of skill items. No git, network or LLM; it consumes only the `SourceReport` types from `src/model.ts` and `redact` from `src/redact.ts`.

**Tech Stack:** TypeScript (erasable syntax, `.ts` imports) run directly by Node 22.18+, `node:test` + `node:assert/strict`, `tsc` 7 for typecheck.

**Spec:** `docs/superpowers/specs/2026-10-05-source-changelog-design.md`

## Global Constraints

- Only these files change: `packages/source-watch/src/changelog.ts` (new), `packages/source-watch/checks/changelog.spec.ts` (new), `packages/source-watch/src/index.ts` (export lines only), `packages/source-watch/README.md`. Do not touch any other source-watch file, `src/`, `packages/profile-engine` or `apps/desktop`.
- No new dependencies. Tests use `node:test` and `node:assert/strict` only, with hand-built reports, no git.
- Source names and commit subjects pass through `redact` before being written; author names are never written.
- Relative imports end in `.ts`; type-only imports use `import type` (`verbatimModuleSyntax`).
- Conventional-commit prefixes; commit after every task. No `Co-Authored-By` trailer.

## Review Focus

- Version tags that only sort right numerically (`v6.9.0` vs `v6.10.0`) — the higher version wins (Task 1).
- An accepted source listed twice — drafted once (Task 1).
- A credential in a source name that ends up in `skipped` — redacted there too (Task 1).
- An abbreviated `revision` sha — treated as `stale`, since the match is exact (Task 1).
- A skill commit sha absent from the report's `commits` — silently left out, never `undefined` (Task 2).

---

## Setup (once, before Task 1)

```bash
cd packages/source-watch && npm ci && (cd ../profile-engine && npm ci)
```

All commands below run from `packages/source-watch`.

### Task 1: Selection and headings

**Files:**
- Create: `packages/source-watch/src/changelog.ts`
- Create: `packages/source-watch/checks/changelog.spec.ts`
- Modify: `packages/source-watch/src/index.ts` (append export lines)

**Interfaces:**
- Consumes: `SourceReport`, `Revision` from `src/model.ts`; `redact(text: string): string` from `src/redact.ts`.
- Produces: `draftChangelog(reports: ReadonlyArray<SourceReport>, accepted: ReadonlyArray<AcceptedSource>): ChangelogDraft`; types `AcceptedSource`, `SkippedSource`, `ChangelogDraft`. Internal `items(report, choice): string[]`, which Task 2 replaces.

- [ ] **Step 1: Write the failing tests**

`checks/changelog.spec.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Revision, SourceReport } from '../src/model.ts';
import { draftChangelog } from '../src/changelog.ts';
import type { AcceptedSource } from '../src/changelog.ts';

const sha = (c: string) => c.repeat(40);
const rev = (s: string, tags: ReadonlyArray<string> = []): Revision => ({ sha: s, date: '2026-10-01T00:00:00Z', tags });
const report = (source: string, extra: Partial<SourceReport> = {}): SourceReport => ({
  source,
  url: `https://github.com/${source}.git`,
  status: 'ahead',
  latest: rev(sha('b')),
  baseline: { ...rev(sha('a')), ref: sha('a') },
  commits: [],
  skills: [],
  added: [],
  ...extra,
});
const accept = (r: SourceReport, extra: Partial<AcceptedSource> = {}): AcceptedSource => ({
  source: r.source, revision: r.latest?.sha ?? '', ...extra,
});
const NONE = "- No changes to this setup's skills.";

test('labels each end with a tag, else a short sha', () => {
  const r = report('x/y', { latest: rev(sha('b'), ['v6.5.0']) });
  assert.deepEqual(draftChangelog([r], [accept(r)]), {
    markdown: `## x/y aaaaaaa → v6.5.0\n\n${NONE}\n`,
    skipped: [],
  });
});

test('prefers the highest version-like tag, else the first tag', () => {
  const r = report('x/y', {
    latest: rev(sha('b'), ['latest', 'v6.9.0', 'v6.10.0']),
    baseline: { ...rev(sha('a'), ['stable', 'release']), ref: 'stable' },
  });
  assert.equal(draftChangelog([r], [accept(r)]).markdown, `## x/y stable → v6.10.0\n\n${NONE}\n`);
});

test('an unpinned source reads as pinned at latest', () => {
  const r = report('x/y', { status: 'unpinned', baseline: undefined, latest: rev(sha('b'), ['v1.0.0']) });
  assert.equal(draftChangelog([r], [accept(r)]).markdown, `## x/y pinned at v1.0.0\n\n${NONE}\n`);
});

test('writes nothing for up-to-date or unaccepted sources', () => {
  const current = report('a/current', { status: 'up-to-date', latest: rev(sha('a')), baseline: { ...rev(sha('a')), ref: 'v1' } });
  const other = report('a/other');
  assert.deepEqual(draftChangelog([current, other], [accept(current)]), { markdown: '', skipped: [] });
});

test('skips sources it cannot describe, in accepted order', () => {
  const gone = report('a/gone', { status: 'unreachable', reason: 'offline', latest: undefined, baseline: undefined });
  const lost = report('a/lost', { status: 'baseline-missing', reason: 'no such ref', baseline: undefined });
  const moved = report('a/moved');
  const draft = draftChangelog([gone, lost, moved], [
    { source: 'a/unknown', revision: sha('c') },
    accept(gone),
    accept(lost),
    { source: 'a/moved', revision: sha('c') },
  ]);
  assert.deepEqual(draft, {
    markdown: '',
    skipped: [
      { source: 'a/unknown', reason: 'not-watched' },
      { source: 'a/gone', reason: 'no-data' },
      { source: 'a/lost', reason: 'no-data' },
      { source: 'a/moved', reason: 'stale' },
    ],
  });
});

test('a shortened revision sha is stale', () => {
  const r = report('x/y');
  assert.deepEqual(draftChangelog([r], [{ source: 'x/y', revision: sha('b').slice(0, 7) }]).skipped, [
    { source: 'x/y', reason: 'stale' },
  ]);
});

test('follows report order, once per source, whatever the accepted order', () => {
  const first = report('a/first');
  const second = report('a/second');
  assert.equal(
    draftChangelog([first, second], [accept(second), accept(first), accept(second)]).markdown,
    `## a/first aaaaaaa → bbbbbbb\n\n${NONE}\n\n## a/second aaaaaaa → bbbbbbb\n\n${NONE}\n`,
  );
});

test('redacts credentials in source names, skipped ones included', () => {
  const r = report('https://ada:s3cret@git.example/x.git');
  const draft = draftChangelog([r], [accept(r), { source: 'https://bob:hunter2@h.example/y.git', revision: sha('c') }]);
  assert.ok(draft.markdown.startsWith('## https://git.example/x.git aaaaaaa → bbbbbbb\n'));
  assert.deepEqual(draft.skipped, [{ source: 'https://h.example/y.git', reason: 'not-watched' }]);
  assert.ok(!JSON.stringify(draft).includes('s3cret'));
  assert.ok(!JSON.stringify(draft).includes('hunter2'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test checks/changelog.spec.ts`
Expected: FAIL — cannot find module `../src/changelog.ts`.

- [ ] **Step 3: Write the implementation**

`src/changelog.ts`:

```ts
// Drafts the changelog Publish shows, from the watcher's reports. Pure: no git, network or LLM.
import type { Revision, SourceReport } from './model.ts';
import { redact } from './redact.ts';

// A source the author brought into Contents, at the revision they reviewed.
export type AcceptedSource = {
  readonly source: string;
  readonly revision: string; // full sha; must equal the report's latest
  readonly ignored?: ReadonlyArray<string>; // changed or removed skills to name without detail
  readonly added?: ReadonlyArray<string>; // names from the report's `added` now in the setup
};

export type SkippedSource = { readonly source: string; readonly reason: 'not-watched' | 'stale' | 'no-data' };

export type ChangelogDraft = {
  readonly markdown: string; // '' when there is nothing to say
  readonly skipped: ReadonlyArray<SkippedSource>; // in accepted order; never part of the Markdown
};

// One editable Markdown section per accepted source that moved, in report order.
export function draftChangelog(
  reports: ReadonlyArray<SourceReport>,
  accepted: ReadonlyArray<AcceptedSource>,
): ChangelogDraft {
  const skipped: SkippedSource[] = [];
  const chosen = new Map<string, AcceptedSource>();
  for (const choice of accepted) {
    const report = reports.find((candidate) => candidate.source === choice.source);
    const reason: SkippedSource['reason'] | undefined = !report
      ? 'not-watched'
      : report.status === 'unreachable' || report.status === 'baseline-missing'
        ? 'no-data'
        : report.latest?.sha !== choice.revision
          ? 'stale'
          : undefined;
    if (reason) skipped.push({ source: redact(choice.source), reason });
    else chosen.set(choice.source, choice);
  }

  const drafted = new Set<string>();
  const sections: string[] = [];
  for (const report of reports) {
    const choice = chosen.get(report.source);
    if (!choice || report.status === 'up-to-date' || drafted.has(report.source)) continue;
    drafted.add(report.source);
    sections.push(section(report, choice));
  }
  return { markdown: sections.length > 0 ? `${sections.join('\n\n')}\n` : '', skipped };
}

function section(report: SourceReport, choice: AcceptedSource): string {
  const source = redact(report.source);
  const to = label(report.latest!);
  const heading = report.status === 'unpinned' || !report.baseline
    ? `## ${source} pinned at ${to}`
    : `## ${source} ${label(report.baseline)} → ${to}`;
  return [heading, '', ...items(report, choice)].join('\n');
}

// A revision's name: its highest version-like tag, else its first tag, else a short sha.
function label(revision: Revision): string {
  const versions = revision.tags.filter((tag) => /\d/.test(tag));
  if (versions.length > 0) {
    return versions.reduce((best, tag) => (tag.localeCompare(best, 'en', { numeric: true }) > 0 ? tag : best));
  }
  return revision.tags[0] ?? revision.sha.slice(0, 7);
}

function items(_report: SourceReport, _choice: AcceptedSource): string[] {
  return ["- No changes to this setup's skills."];
}
```

Append to `src/index.ts`:

```ts
export { draftChangelog } from './changelog.ts';
export type { AcceptedSource, ChangelogDraft, SkippedSource } from './changelog.ts';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test checks/changelog.spec.ts && npm run typecheck`
Expected: all 8 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/changelog.ts checks/changelog.spec.ts src/index.ts
git commit -m "feat: draft changelog headings from accepted source reports"
```

### Task 2: Skill items and README

**Files:**
- Modify: `packages/source-watch/src/changelog.ts` (replace `items`, widen the model import)
- Modify: `packages/source-watch/checks/changelog.spec.ts` (widen the model import, add helpers and tests)
- Modify: `packages/source-watch/README.md` (add a section)

**Interfaces:**
- Consumes: `draftChangelog`, `AcceptedSource` from Task 1; `SkillChange`, `Commit` from `src/model.ts`.
- Produces: the final `items(report: SourceReport, choice: AcceptedSource): string[]`.

- [ ] **Step 1: Write the failing tests**

In `checks/changelog.spec.ts`, change the model import to:

```ts
import type { Commit, Revision, SkillChange, SourceReport } from '../src/model.ts';
```

Add these helpers below `NONE`:

```ts
const commit = (s: string, subject: string): Commit => ({ sha: s, subject, author: 'Ada Lovelace', date: '2026-10-01T00:00:00Z' });
const skill = (name: string, status: SkillChange['status'], commits: ReadonlyArray<string> = []): SkillChange => ({
  name, path: `skills/${name}`, status, commits, files: [],
});
```

Append these tests:

```ts
test('drafts every kind of item, per source', () => {
  const superpowers = report('obra/superpowers', {
    latest: rev(sha('b'), ['v6.5.0']),
    baseline: { ...rev(sha('a'), ['v6.4.1']), ref: 'v6.4.1' },
    commits: [
      commit(sha('3'), 'Merge pull request #9 from obra/questions'),
      commit(sha('2'), 'Ask one question at a time'),
      commit(sha('1'), 'Fix typo in checklist'),
      commit(sha('4'), 'Tighten plan steps'),
    ],
    skills: [
      skill('brainstorming', 'changed', [sha('3'), sha('2'), sha('1')]),
      skill('writing-plans', 'changed', [sha('4')]),
      skill('steady', 'unchanged'),
      skill('old-skill', 'removed'),
      skill('never-there', 'missing'),
    ],
    added: ['new-skill', 'other-new'],
  });
  const agentSkills = report('Nortus222/agent-skills', {
    latest: rev(sha('e')),
    baseline: { ...rev(sha('d')), ref: sha('d') },
    commits: [commit(sha('5'), 'Add worked example')],
    skills: [skill('explain', 'changed', [sha('5')])],
  });
  const draft = draftChangelog([superpowers, agentSkills], [
    accept(superpowers, { ignored: ['writing-plans'], added: ['new-skill', 'not-upstream'] }),
    accept(agentSkills),
  ]);
  assert.deepEqual(draft, {
    markdown: [
      '## obra/superpowers v6.4.1 → v6.5.0',
      '',
      '- Updated `brainstorming`',
      '  - Ask one question at a time',
      '  - Fix typo in checklist',
      '- Added `new-skill`',
      '- Removed `old-skill`',
      '- Also updated: `writing-plans`',
      '',
      '## Nortus222/agent-skills ddddddd → eeeeeee',
      '',
      '- Updated `explain`',
      '  - Add worked example',
      '',
    ].join('\n'),
    skipped: [],
  });
  assert.ok(!draft.markdown.includes('Ada'));
});

test('drops merge noise and repeated subjects, keeping a skill with none left', () => {
  const r = report('x/y', {
    commits: [
      commit(sha('1'), "Merge branch 'main' into feature"),
      commit(sha('2'), 'Same change'),
      commit(sha('3'), 'Same change'),
      commit(sha('4'), 'Merge remote-tracking branch origin/main'),
    ],
    skills: [skill('a', 'changed', [sha('1'), sha('2'), sha('3'), sha('4')]), skill('b', 'changed', [sha('1')])],
  });
  assert.equal(
    draftChangelog([r], [accept(r)]).markdown,
    '## x/y aaaaaaa → bbbbbbb\n\n- Updated `a`\n  - Same change\n- Updated `b`\n',
  );
});

test('leaves out commits the report does not list', () => {
  const r = report('x/y', { skills: [skill('a', 'changed', [sha('9')])] });
  assert.equal(draftChangelog([r], [accept(r)]).markdown, '## x/y aaaaaaa → bbbbbbb\n\n- Updated `a`\n');
});

test('names ignored skills only when they changed or were removed', () => {
  const r = report('x/y', { skills: [skill('a', 'changed'), skill('b', 'removed'), skill('c', 'unchanged')] });
  assert.equal(
    draftChangelog([r], [accept(r, { ignored: ['a', 'b', 'c'] })]).markdown,
    '## x/y aaaaaaa → bbbbbbb\n\n- Also updated: `a`, `b`\n',
  );
});

test('a source whose skills did not change says so', () => {
  const r = report('x/y', { skills: [skill('a', 'unchanged'), skill('b', 'missing')], added: ['c'] });
  assert.equal(draftChangelog([r], [accept(r)]).markdown, `## x/y aaaaaaa → bbbbbbb\n\n${NONE}\n`);
});

test('redacts credentials in commit subjects', () => {
  const r = report('x/y', {
    commits: [commit(sha('1'), 'Mirror from https://ada:s3cret@git.example/x.git?token=abc')],
    skills: [skill('a', 'changed', [sha('1')])],
  });
  assert.equal(
    draftChangelog([r], [accept(r)]).markdown,
    '## x/y aaaaaaa → bbbbbbb\n\n- Updated `a`\n  - Mirror from https://git.example/x.git?token=***\n',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test checks/changelog.spec.ts`
Expected: the 8 Task 1 tests PASS; the first five new tests FAIL (they get the "No changes" line instead of items). "a source whose skills did not change says so" already passes against the stub; it pins that behaviour for the new `items`.

- [ ] **Step 3: Write the implementation**

In `src/changelog.ts`, change the model import to:

```ts
import type { Revision, SkillChange, SourceReport } from './model.ts';
```

Add below the imports:

```ts
const MERGE_NOISE = /^Merge (?:pull request|branch|remote-tracking branch)\b/;
```

Replace the `items` stub with:

```ts
// The source's list: updated skills with their subjects, then added, removed and ignored ones.
function items(report: SourceReport, choice: AcceptedSource): string[] {
  const ignored = new Set(choice.ignored ?? []);
  const kept = new Set(choice.added ?? []);
  const subjects = new Map(report.commits.map((commit) => [commit.sha, commit.subject]));
  const shown = (status: SkillChange['status']) =>
    report.skills.filter((skill) => skill.status === status && !ignored.has(skill.name));

  const lines: string[] = [];
  for (const skill of shown('changed')) {
    lines.push(`- Updated \`${skill.name}\``);
    const seen = new Set<string>();
    for (const sha of skill.commits) {
      const subject = redact(subjects.get(sha) ?? '').trim();
      if (subject === '' || MERGE_NOISE.test(subject) || seen.has(subject)) continue;
      seen.add(subject);
      lines.push(`  - ${subject}`);
    }
  }
  for (const name of report.added) if (kept.has(name)) lines.push(`- Added \`${name}\``);
  for (const skill of shown('removed')) lines.push(`- Removed \`${skill.name}\``);
  const quiet = report.skills.filter(
    (skill) => ignored.has(skill.name) && (skill.status === 'changed' || skill.status === 'removed'),
  );
  if (quiet.length > 0) lines.push(`- Also updated: ${quiet.map((skill) => `\`${skill.name}\``).join(', ')}`);
  return lines.length > 0 ? lines : ["- No changes to this setup's skills."];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test checks/changelog.spec.ts && npm run typecheck`
Expected: all 14 tests PASS; typecheck exits 0.

- [ ] **Step 5: Document it in the README**

In `packages/source-watch/README.md`, insert this section immediately before the paragraph that starts `Sources are TypeScript run directly by Node 22.18+`:

````markdown
## Changelog draft

`draftChangelog(reports, accepted)` turns reports into the Markdown changelog Publish starts
from. `accepted` names each source the author brought into Contents, the full sha they reviewed
(it must equal the report's `latest`), the skills to name without detail (`ignored`) and the
upstream-new skills they added (`added`). Up-to-date sources are left out. Sources the draft
cannot describe come back in `skipped` as `not-watched`, `stale` or `no-data`. It is pure and
writes no author names. Design: `docs/superpowers/specs/2026-10-05-source-changelog-design.md`.

```ts
const { markdown, skipped } = draftChangelog(reports, [
  { source: 'obra/superpowers', revision: reports[0].latest!.sha, ignored: ['writing-plans'] },
]);
```

````

- [ ] **Step 6: Run the whole package and commit**

Run: `npm test && npm run typecheck`
Expected: every spec passes (the git-fixture specs included); typecheck exits 0.

```bash
git add src/changelog.ts checks/changelog.spec.ts README.md
git commit -m "feat: list skill changes in the changelog draft"
```
