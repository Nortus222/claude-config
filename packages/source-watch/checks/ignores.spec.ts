import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIgnored, readIgnores } from '../src/ignores.ts';
import type { SourceReport, SourceStatus } from '../src/model.ts';

const SHA = 'c'.repeat(40);
const report = (status: SourceStatus, sha: string | null = SHA, source = 'ada/skills'): SourceReport => ({
  source,
  url: 'https://github.com/ada/skills.git',
  status,
  ...(sha === null ? {} : { latest: { sha, date: '2026-01-01T00:00:00Z', tags: [] } }),
  commits: [],
  skills: [],
  added: [],
});

test('an absent ignores file ignores nothing', () => {
  assert.deepEqual(readIgnores(undefined), { ignores: {} });
});

test('a valid ignores file maps each source to its ignored sha', () => {
  const text = JSON.stringify({ version: 1, ignored: { 'ada/skills': SHA } });
  assert.deepEqual(readIgnores(text), { ignores: { 'ada/skills': SHA } });
  assert.deepEqual(readIgnores('{"version":1}'), { ignores: {} });
});

test('an invalid ignores file ignores nothing and says why', () => {
  const { ignores, problem } = readIgnores('{');
  assert.deepEqual(ignores, {});
  assert.match(problem!, /^source-ignores\.json is not JSON/);
});

test('a new revision equal to the ignored sha is ignored', () => {
  const ignores = { 'ada/skills': SHA };
  assert.equal(isIgnored(report('ahead'), ignores), true);
  assert.equal(isIgnored(report('diverged'), ignores), true);
  assert.equal(isIgnored(report('ahead'), { 'ada/skills': SHA.toUpperCase() }), true);
});

test('anything else is not ignored', () => {
  const ignores = { 'ada/skills': SHA };
  for (const status of ['up-to-date', 'unpinned', 'baseline-missing', 'unreachable'] as const) {
    assert.equal(isIgnored(report(status), ignores), false, status);
  }
  assert.equal(isIgnored(report('ahead', 'd'.repeat(40)), ignores), false, 'upstream moved on');
  assert.equal(isIgnored(report('ahead', SHA, 'bob/tools'), ignores), false, 'another source');
  assert.equal(isIgnored(report('ahead', null), ignores), false, 'no latest');
  assert.equal(isIgnored(report('ahead'), {}), false, 'nothing ignored');
});
