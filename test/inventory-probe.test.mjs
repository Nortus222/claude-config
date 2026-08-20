import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observedAgents, observedSkillLinks } from '../src/inventory-probe.mjs';

function homeWithStore() {
  const home = mkdtempSync(join(tmpdir(), 'nortuscc-probe-home-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  return {
    home,
    claudeDir: () => join(home, '.claude'),
    agentsSkills: () => join(home, '.agents', 'skills'),
  };
}

test('a missing agents directory observes nothing and is not an error', () => {
  const { claudeDir } = homeWithStore();
  assert.deepEqual(observedAgents({ claudeDir }), { items: [], errors: [] });
});

test('an agents symlink is observed and reports its target', () => {
  const { home, claudeDir } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(home, 'elsewhere'), { recursive: true });
  symlinkSync(join(home, 'elsewhere'), join(home, '.claude', 'agents', 'awesome-claude-agents'));

  const { items, errors } = observedAgents({ claudeDir });
  assert.deepEqual(errors, []);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'awesome-claude-agents');
  assert.match(items[0].note, /-> .*elsewhere/);
});

test('a dot-prefixed agents entry is the agent\'s own bookkeeping, not an agent', () => {
  const { home, claudeDir } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents', '.internal'), { recursive: true });
  assert.deepEqual(observedAgents({ claudeDir }).items, []);
});

// The check this task exists for.
test('skill links resolve, so relative and absolute forms both read as the store', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  for (const name of ['relative-one', 'absolute-one']) {
    mkdirSync(join(home, '.agents', 'skills', name), { recursive: true });
  }
  symlinkSync('../../.agents/skills/relative-one', join(home, '.claude', 'skills', 'relative-one'));
  symlinkSync(join(home, '.agents', 'skills', 'absolute-one'), join(home, '.claude', 'skills', 'absolute-one'));

  assert.deepEqual(observedSkillLinks({ claudeDir, agentsSkills }), { items: [], errors: [] });
});

test('a real directory in the skills dir did not come from the store', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'skills', 'wayfinder'), { recursive: true });

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'wayfinder');
  assert.match(items[0].note, /not from the shared store/);
});

test('a link pointing outside the store is observed', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, 'other-skills', 'stray'), { recursive: true });
  symlinkSync(join(home, 'other-skills', 'stray'), join(home, '.claude', 'skills', 'stray'));

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'stray');
});

test('a broken link is observed as broken rather than silently skipped', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.agents', 'skills', 'gone'), { recursive: true });
  symlinkSync(join(home, '.agents', 'skills', 'gone'), join(home, '.claude', 'skills', 'gone'));
  rmSync(join(home, '.agents', 'skills', 'gone'), { recursive: true });

  const { items } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.equal(items.length, 1);
  assert.match(items[0].note, /broken link/);
});
