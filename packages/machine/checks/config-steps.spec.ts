import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DesiredConfig } from '@nortuscc/profile-engine';
import { configDomain, plan, selectAll, type MachineReport, type Observed } from '../src/index.ts';
import { CHANGED_SINCE_APPLY, configSteps } from '../src/config/steps.ts';
import { configMachine } from './config-machine.ts';

const desired = await configMachine().desired();

const DISPOSITION: Record<string, Observed['disposition']> = {
  clean: 'in-sync', 'repo-ahead': 'apply', unmanaged: 'apply', 'local-ahead': 'capture',
};
const item = (key: string, state: string, facts: string[] = [], over: Partial<Observed> = {}): Observed => ({
  key, domain: 'config', target: key.startsWith('config:codex') ? 'codex' : 'claude',
  label: key.slice(key.lastIndexOf(':') + 1), group: 'g', state, disposition: DISPOSITION[state] ?? 'blocked', facts, ...over,
});
const keys = (list: ReadonlyArray<{ key: string }>) => list.map((s) => s.key);

test('apply writes what the repo is ahead on, as file or key steps', () => {
  const result = configSteps([
    item('config:claude:CLAUDE.md', 'unmanaged', ['local-absent']),
    item('config:claude:settings.json#theme', 'repo-ahead', ['recorded']),
  ], selectAll, 'apply', desired);
  assert.deepEqual(result.steps, [
    { key: 'config:claude:CLAUDE.md', domain: 'config', action: 'write-file', summary: 'copy CLAUDE.md from the repo', touches: ['claude:CLAUDE.md'], interruptible: false },
    { key: 'config:claude:settings.json#theme', domain: 'config', action: 'merge-keys', summary: 'set settings.json#theme from the repo', touches: ['claude:settings.json'], interruptible: false },
  ]);
  assert.deepEqual(result.skipped, []);
});

test('a clean item is no step, unless its baseline is stale', () => {
  assert.deepEqual(configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded'])], selectAll, 'apply', desired), { steps: [], skipped: [] });
  const stale = configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded', 'local-changed', 'baseline-stale'])], selectAll, 'apply', desired);
  assert.deepEqual(stale.steps.map((s) => [s.action, s.summary]), [['write-file', 'record CLAUDE.md as in sync']]);
  const captured = configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded', 'local-changed', 'baseline-stale'])], selectAll, 'capture', desired);
  assert.deepEqual(captured.steps.map((s) => [s.action, s.summary]), [['capture-file', 'record CLAUDE.md as in sync']]);
});

test('a clean settings key that carries dropped baselines is recorded, pruning them; a write already prunes', () => {
  const dropped = configSteps([
    item('config:claude:settings.json#theme', 'clean', ['recorded', 'baseline-dropped']),
    item('config:claude:settings.json#model', 'clean', ['recorded']),
  ], selectAll, 'apply', desired);
  assert.deepEqual(dropped.steps.map((s) => [s.key, s.action, s.summary]), [
    ['config:claude:settings.json#theme', 'merge-keys', 'forget dropped keys of settings.json'],
  ]);
  const ahead = configSteps([
    item('config:claude:settings.json#theme', 'repo-ahead', ['recorded', 'baseline-dropped']),
    item('config:claude:settings.json#model', 'clean', ['recorded']),
  ], selectAll, 'apply', desired);
  assert.deepEqual(ahead.steps.map((s) => [s.key, s.summary]), [['config:claude:settings.json#theme', 'set settings.json#theme from the repo']]);
});

test('conflicts and local edits are skipped; force takes the repo for files, never for local-ahead keys', () => {
  const items = [
    item('config:claude:CLAUDE.md', 'conflict', ['recorded', 'local-changed']),
    item('config:codex:AGENTS.md', 'local-ahead', ['recorded', 'local-changed']),
    item('config:claude:settings.json#theme', 'local-ahead', ['recorded', 'local-changed']),
  ];
  const plain = configSteps(items, selectAll, 'apply', desired);
  assert.deepEqual(plain.steps, []);
  assert.deepEqual(plain.skipped, [
    { key: 'config:claude:CLAUDE.md', reason: 'changed on both sides; --take-repo keeps the repo version' },
    { key: 'config:codex:AGENTS.md', reason: 'changed on this machine; capture keeps it' },
    { key: 'config:claude:settings.json#theme', reason: 'changed on this machine; capture keeps it' },
  ]);
  const forced = configSteps(items, { ...selectAll, force: true }, 'apply', desired);
  assert.deepEqual(keys(forced.steps), ['config:claude:CLAUDE.md', 'config:codex:AGENTS.md']);
  assert.deepEqual(keys(forced.skipped), ['config:claude:settings.json#theme']);
});

test('blocked states and excluded or unselected items are skipped with their reason', () => {
  const result = configSteps([
    item('config:codex:AGENTS.md', 'missing-repo'),
    item('config:claude:settings.json', 'unparseable-local'),
    item('config:claude:settings.json', 'invalid', [], { note: "settings key 'env.API_KEY' looks like a secret" }),
    item('config:codex:config.toml', 'unmanaged', [], { disposition: 'excluded' }),
  ], selectAll, 'apply', desired);
  assert.deepEqual(result.skipped.map((s) => s.reason), [
    'missing from the repo',
    'not valid JSON on this machine; fix it by hand',
    "settings key 'env.API_KEY' looks like a secret",
    'not managed on this machine',
  ]);
  const narrowed = configSteps([item('config:claude:CLAUDE.md', 'unmanaged')], { ...selectAll, targets: ['codex'] }, 'apply', desired);
  assert.deepEqual(narrowed, { steps: [], skipped: [{ key: 'config:claude:CLAUDE.md', reason: 'target not selected' }] });
});

test('capture takes local edits, never repo-owned files, and has nothing to take from an absent file', () => {
  const result = configSteps([
    item('config:claude:CLAUDE.md', 'local-ahead', ['recorded', 'local-changed']),
    item('config:codex:AGENTS.md', 'unmanaged', ['local-absent']),
    item('config:codex:config.toml', 'local-ahead', ['recorded', 'local-changed']),
    item('config:claude:settings.json#theme', 'repo-ahead', ['recorded']),
    item('config:claude:settings.json#model', 'unmanaged'),
    item('config:claude:settings.json#tui', 'conflict', ['recorded', 'local-changed']),
  ], selectAll, 'capture', desired);
  assert.deepEqual(result.steps.map((s) => [s.key, s.action, s.summary, s.touches]), [
    ['config:claude:CLAUDE.md', 'capture-file', 'capture CLAUDE.md into the repo', ['repo:claude/CLAUDE.md']],
    ['config:claude:settings.json#model', 'capture-file', 'capture settings.json#model into the repo', ['repo:claude/settings.keys.json']],
  ]);
  assert.deepEqual(result.skipped, [
    { key: 'config:codex:config.toml', reason: 'repo-owned: local changes are never captured' },
    { key: 'config:claude:settings.json#theme', reason: 'the repo is ahead; apply takes it' },
    { key: 'config:claude:settings.json#tui', reason: 'changed on both sides; --take-local keeps the local version' },
  ]);
  const forced = configSteps([item('config:claude:settings.json#tui', 'conflict', ['recorded', 'local-changed'])], { ...selectAll, force: true }, 'capture', desired);
  assert.deepEqual(keys(forced.steps), ['config:claude:settings.json#tui']);
});

test('uninstall restores each recorded document once, refusing a changed one unless forced', () => {
  const items = [
    item('config:claude:CLAUDE.md', 'clean', ['recorded']),
    item('config:codex:AGENTS.md', 'unmanaged', ['local-absent']),
    item('config:claude:settings.json#theme', 'clean', ['recorded']),
    item('config:claude:settings.json#model', 'local-ahead', ['recorded', 'local-changed']),
    item('config:codex:config.toml', 'clean', ['recorded'], { disposition: 'excluded' }),
  ];
  const plain = configSteps(items, selectAll, 'uninstall', desired);
  assert.deepEqual(keys(plain.steps), ['config:claude:CLAUDE.md', 'config:codex:config.toml']);
  assert.deepEqual(plain.skipped, [{ key: 'config:claude:settings.json', reason: CHANGED_SINCE_APPLY }]);
  const forced = configSteps(items, { ...selectAll, force: true }, 'uninstall', desired);
  assert.deepEqual(forced.steps.map((s) => [s.key, s.action, s.summary, s.touches]), [
    ['config:claude:CLAUDE.md', 'restore', 'restore CLAUDE.md to its state before nortuscc', ['claude:CLAUDE.md']],
    ['config:claude:settings.json', 'restore', 'restore settings.json to its state before nortuscc', ['claude:settings.json']],
    ['config:codex:config.toml', 'restore', 'restore config.toml to its state before nortuscc', ['codex-openrouter:config.toml']],
  ]);
});

test('steps follow the desired files, not the static file list', () => {
  const repoOwned: DesiredConfig = {
    ...desired,
    files: desired.files.map((f) => (f.id === 'claude:CLAUDE.md' ? { ...f, capture: false } : f)),
  };
  const result = configSteps([item('config:claude:CLAUDE.md', 'local-ahead', ['recorded', 'local-changed'])], selectAll, 'capture', repoOwned);
  assert.deepEqual(result, { steps: [], skipped: [{ key: 'config:claude:CLAUDE.md', reason: 'repo-owned: local changes are never captured' }] });
  const unknown: DesiredConfig = { ...desired, files: desired.files.filter((f) => f.id !== 'claude:CLAUDE.md') };
  assert.deepEqual(configSteps([item('config:claude:CLAUDE.md', 'unmanaged')], selectAll, 'apply', unknown).skipped,
    [{ key: 'config:claude:CLAUDE.md', reason: 'not a managed file' }]);
  assert.deepEqual(configSteps([item('config:claude:CLAUDE.md', 'clean', ['recorded'])], selectAll, 'uninstall', unknown).steps, []);
});

test('an update plan has no config steps, so it never captures into the repo', () => {
  const empty: DesiredConfig = { files: [], skills: [], integrations: [], allow: {}, issues: [] };
  const report: MachineReport = {
    desired: empty,
    items: [
      item('config:claude:CLAUDE.md', 'local-ahead', ['recorded', 'local-changed']),
      item('config:claude:settings.json#theme', 'repo-ahead', ['recorded']),
    ],
    probeErrors: [],
  };
  assert.deepEqual(plan('update', report, selectAll, [configDomain]), { kind: 'update', steps: [], skipped: [] });
});
