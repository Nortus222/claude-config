import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInstallFlags, buildInstallChoices, reviewLines, CATEGORIES } from '../src/install-plan.mjs';

test('install flags support yes and all category opt-outs', () => {
  const flags = parseInstallFlags(['--yes', '--no-hooks', '--no-mcp', '--no-plugins', '--no-skills']);
  assert.equal(flags.yes, true);
  assert.deepEqual([...flags.disabled].sort(), ['hooks', 'mcp', 'plugins', 'skills']);
  assert.equal(flags.error, null);
});

test('no flags disables nothing and assumes nothing', () => {
  const flags = parseInstallFlags([]);
  assert.equal(flags.yes, false);
  assert.deepEqual([...flags.disabled], []);
  assert.equal(flags.error, null);
  assert.deepEqual(flags.rest, []);
});

// Flags this workflow does not own are handed back rather than rejected: the
// same argv carries apply's own flags, and swallowing them would make
// `apply --install --take-repo` silently drop the conflict resolution.
test('unrecognised flags survive into rest instead of erroring', () => {
  const flags = parseInstallFlags(['--take-repo', '--yes', 'extra']);
  assert.equal(flags.yes, true);
  assert.deepEqual(flags.rest, ['--take-repo', 'extra']);
  assert.equal(flags.error, null);
});

test('an unknown category opt-out is refused rather than silently ignored', () => {
  const flags = parseInstallFlags(['--no-widgets']);
  assert.match(flags.error, /--no-widgets/);
});

test('the four categories are exactly the ones the opt-outs name', () => {
  assert.deepEqual([...CATEGORIES].sort(), ['hooks', 'mcp', 'plugins', 'skills']);
});

// --- choices -----------------------------------------------------------------

test('already installed choices are visible but unchecked', () => {
  const choices = buildInstallChoices({
    config: [],
    integrations: [{
      id: 'plugin:x', group: 'Claude plugins', label: 'x', state: 'installed', default: true,
    }],
    skills: [],
  });
  assert.equal(choices[0].checked, false);
  assert.match(choices[0].note, /installed/);
});

// Visible, not hidden: a run that silently omitted what it had already done
// would leave the user unable to tell "already satisfied" from "not offered".
test('a default-enabled missing item starts checked', () => {
  const choices = buildInstallChoices({
    config: [],
    integrations: [{ id: 'plugin:x', group: 'Claude plugins', label: 'x', state: 'missing', default: true }],
    skills: [],
  });
  assert.equal(choices[0].checked, true);
});

test('an item that is not default-enabled starts unchecked even when missing', () => {
  const choices = buildInstallChoices({
    config: [],
    integrations: [{ id: 'mcp:y', group: 'Codex MCP', label: 'y', state: 'missing', default: false }],
    skills: [],
  });
  assert.equal(choices[0].checked, false);
});

// A blocked item cannot be installed by ticking it, so it must not arrive
// pre-ticked: confirming a plan full of items that cannot run is a report
// dressed up as an action.
test('a blocked item is shown with its reason and never pre-ticked', () => {
  const choices = buildInstallChoices({
    config: [],
    integrations: [{
      id: 'mcp:y', group: 'Codex MCP', label: 'y', state: 'blocked', default: true,
      note: 'set OPENAI_API_KEY before installing y',
    }],
    skills: [],
  });
  assert.equal(choices[0].checked, false);
  assert.match(choices[0].note, /OPENAI_API_KEY/);
});

test('the three sections keep configuration first and skills last', () => {
  const choices = buildInstallChoices({
    config: [{ id: 'config:claude', label: 'CLAUDE.md', state: 'missing', default: true }],
    integrations: [{ id: 'plugin:x', group: 'Claude plugins', label: 'x', state: 'missing', default: true }],
    skills: [{ id: 'skill:y', label: 'y', state: 'missing', default: true, source: 'a/b' }],
  });
  assert.deepEqual(choices.map((c) => c.key), ['config:claude', 'plugin:x', 'skill:y']);
  assert.equal(choices[0].group, 'configuration');
  assert.equal(choices[2].group, 'shared skills');
});

test('every choice carries a key the caller can map back to its item', () => {
  const choices = buildInstallChoices({
    config: [{ id: 'config:codex', label: 'AGENTS.md', state: 'missing', default: true }],
    integrations: [],
    skills: [],
  });
  assert.equal(choices[0].key, 'config:codex');
});

// --- review ------------------------------------------------------------------

// The review is the last thing between a user and a set of child processes,
// so it has to name the files and the exact commands.
test('the review names the files and the commands a run would make', () => {
  const lines = reviewLines([
    { key: 'config:claude', group: 'configuration', label: 'CLAUDE.md', describe: '~/.claude/CLAUDE.md' },
    { key: 'plugin:x', group: 'Claude plugins', label: 'x', describe: 'claude plugin install x@m' },
  ]);
  const text = lines.join('\n');
  assert.match(text, /CLAUDE\.md/);
  assert.match(text, /claude plugin install x@m/);
});

test('a review of nothing says so rather than printing an empty block', () => {
  assert.match(reviewLines([]).join('\n'), /nothing/i);
});

// Whatever the adapter chose to redact stays redacted: the review prints the
// description it was handed and never reconstructs a command itself.
test('the review prints only what each item described', () => {
  const lines = reviewLines([
    { key: 'mcp:y', group: 'Codex MCP', label: 'y', describe: 'codex mcp add y  (reads OPENAI_API_KEY from the environment)' },
  ]);
  const text = lines.join('\n');
  assert.match(text, /OPENAI_API_KEY/);
  assert.doesNotMatch(text, /sk-/);
});
