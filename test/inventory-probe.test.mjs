import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { observedAgents, observedSkillLinks, observedHooks, declaredHookCommands, probe } from '../src/inventory-probe.mjs';

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

test('a store that cannot be resolved is an error, not "everything is undeclared"', () => {
  const { home, claudeDir } = homeWithStore();
  mkdirSync(join(home, '.agents', 'skills', 'have'), { recursive: true });
  symlinkSync(join(home, '.agents', 'skills', 'have'), join(home, '.claude', 'skills', 'have'));

  // A store path whose parent is a regular file cannot be resolved, and fails
  // with ENOTDIR rather than ENOENT: present, but unusable.
  writeFileSync(join(home, 'blocker'), 'x');
  const agentsSkills = () => join(home, 'blocker', 'skills');

  const { items, errors } = observedSkillLinks({ claudeDir, agentsSkills });
  assert.deepEqual(items, [], 'no skill is relabelled undeclared because the store could not be read');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, 'skills');
});

const settings = (home, value) =>
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(value));

test('no settings file, and settings without hooks, observe nothing', () => {
  const a = homeWithStore();
  assert.deepEqual(observedHooks({ claudeDir: a.claudeDir }), { items: [], errors: [] });

  const b = homeWithStore();
  settings(b.home, { theme: 'dark' });
  assert.deepEqual(observedHooks({ claudeDir: b.claudeDir }), { items: [], errors: [] });
});

test('a registration is observed, matched on command and displayed by event', () => {
  const { home, claudeDir } = homeWithStore();
  settings(home, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /h/x.mjs' }] }] } });

  const { items } = observedHooks({ claudeDir });
  assert.equal(items.length, 1);
  assert.equal(items[0].key, 'node /h/x.mjs');
  assert.equal(items[0].label, 'SessionStart');
});

// The user's file, mid-edit or hand-broken, is never reported as "no hooks":
// that would silently pass a category that was never checked.
test('unparseable settings is an error, not an empty observation', () => {
  const { home, claudeDir } = homeWithStore();
  writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');

  const { items, errors } = observedHooks({ claudeDir });
  assert.deepEqual(items, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].category, 'hooks');
});

test('a declared hook yields the command that would be registered', () => {
  const { claudeDir } = homeWithStore();
  const hook = { id: 'h', label: 'h', target: 'claude', type: 'hook', default: true, event: 'SessionStart', file: 'claude/hooks/x.mjs' };
  const commands = declaredHookCommands([hook], { claudeDir });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /^node .*hooks[/\\]x\.mjs$/);
});

test('probe aggregates every category and reports plugin versions', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', version: '1.2.3' }] } }),
  );
  writeFileSync(join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: {} }));

  const result = probe({ target: 'all', integrations: [], claudeDir, agentsSkills });
  assert.deepEqual(result.observed.plugins.map((p) => p.key), ['a@m']);
  assert.deepEqual(result.observed.marketplaces.map((m) => m.key), ['m']);
  assert.deepEqual(result.pluginVersions, [['a@m', '1.2.3']]);
  assert.deepEqual(result.errors, []);
});

// Claude-side categories are not walked for a Codex-only report, exactly as
// --target narrows every other section.
test('--target codex observes codex plugins and no claude-side categories', () => {
  const { home, claudeDir, agentsSkills } = homeWithStore();
  mkdirSync(join(home, '.claude', 'agents', 'stray'), { recursive: true });

  const codexState = { plugins: new Set(['c@cm']), marketplaces: new Set(['cm']), errors: [] };
  const result = probe({ target: 'codex', integrations: [], codexState, claudeDir, agentsSkills });

  assert.deepEqual(result.observed.agents, []);
  assert.deepEqual(result.observed.plugins.map((p) => p.key), ['c@cm']);
  assert.deepEqual(result.observed.marketplaces.map((m) => m.key), ['cm']);
});
