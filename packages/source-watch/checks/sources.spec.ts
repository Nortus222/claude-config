import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ResolvedSkill } from '@nortuscc/profile-engine';
import { sourceUrl, sourcesFrom } from '../src/sources.ts';

const base = { layer: 'base', source: 'skills-manifest.txt' } as const;
const pinned = (ref: string) => ({ ref, from: { layer: 'pin', source: 'skill-pins.json' } as const });
const skill = (name: string, source: string, extra: Partial<ResolvedSkill> = {}): ResolvedSkill => ({
  name, source, exact: false, optional: false, install: true, from: base, ...extra,
});

test('groups skills by source in first-seen order, with the pin as baseline', () => {
  const config = {
    skills: [
      skill('tdd', 'mattpocock/skills', { pin: pinned('v1') }),
      skill('explain', 'Nortus222/agent-skills', { optional: true, install: false }),
      skill('grill', 'mattpocock/skills', { pin: pinned('v1') }),
    ],
  };
  assert.deepEqual(sourcesFrom(config), [
    { source: 'mattpocock/skills', url: 'https://github.com/mattpocock/skills.git', baseline: 'v1', exact: false, skills: ['tdd', 'grill'] },
    { source: 'Nortus222/agent-skills', url: 'https://github.com/Nortus222/agent-skills.git', exact: false, skills: ['explain'] },
  ]);
});

test('a source is exact when any of its groups is, and a repeated name is listed once', () => {
  const config = { skills: [skill('a', 'x/y'), skill('b', 'x/y', { exact: true }), skill('a', 'x/y')] };
  assert.deepEqual(sourcesFrom(config), [
    { source: 'x/y', url: 'https://github.com/x/y.git', exact: true, skills: ['a', 'b'] },
  ]);
});

test('checkouts attach by source', () => {
  const config = { skills: [skill('explain', 'Nortus222/agent-skills'), skill('tdd', 'mattpocock/skills')] };
  const sources = sourcesFrom(config, { checkouts: { 'Nortus222/agent-skills': '/work/agent-skills' } });
  assert.equal(sources[0]!.checkout, '/work/agent-skills');
  assert.equal('checkout' in sources[1]!, false);
});

test('a source that is already a URL is fetched as written', () => {
  assert.equal(sourceUrl('https://gitlab.com/a/b.git'), 'https://gitlab.com/a/b.git');
  assert.equal(sourceUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.equal(sourceUrl('a/b'), 'https://github.com/a/b.git');
});
