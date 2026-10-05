import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Commit, Revision, SkillChange, SourceReport } from '../src/model.ts';
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

const commit = (s: string, subject: string): Commit => ({ sha: s, subject, author: 'Ada Lovelace', date: '2026-10-01T00:00:00Z' });
const skill = (name: string, status: SkillChange['status'], commits: ReadonlyArray<string> = []): SkillChange => ({
  name, path: `skills/${name}`, status, commits, files: [],
});

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
