import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, readJson, runCli, type Machine } from './support/cli.ts';

// update, setup, uninstall, capture and push with held items (sync.json written by hand; `nortuscc sync` writes it).

const EFFORT = 'setting:claude:settings.json#effortLevel';
const KEYS = (m: Machine) => join(m.repo, 'claude', 'settings.keys.json');

const hold = (m: Machine, held: Record<string, string>) => {
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'sync.json'), JSON.stringify({ version: 1, held }, null, 2) + '\n');
};

// Commits settings.keys.json changed by `change` (unpushed, so the CLI stays current); answers the commit before it.
const commitKeys = (m: Machine, change: (keys: Record<string, unknown>) => Record<string, unknown>): string => {
  const before = git(m.repo, 'rev-parse', 'HEAD');
  writeFileSync(KEYS(m), JSON.stringify(change(readJson(KEYS(m))), null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'settings change');
  return before;
};

test('setup keeps a held settings key at its held value', async () => {
  const m = machine();
  const old = readJson(KEYS(m)).effortLevel;
  hold(m, { [EFFORT]: commitKeys(m, (k) => ({ ...k, effortLevel: 'medium' })) });
  const result = await runCli(m, ['setup', '--yes']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, old);
});

test('uninstall sees a held key the checkout dropped, and refuses it changed locally', async () => {
  const m = machine();
  hold(m, { [EFFORT]: commitKeys(m, ({ effortLevel: _dropped, ...rest }) => rest) });
  const applied = await runCli(m, ['apply']);
  assert.equal(applied.code, 0, applied.stderr);
  const settings = join(m.claude, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...readJson(settings), effortLevel: 'mine' }, null, 2) + '\n');
  const result = await runCli(m, ['uninstall', '--yes']);
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /settings\.json\s+changed/);
  assert.equal(readJson(settings).effortLevel, 'mine');
});

test('an invalid sync.json refuses uninstall and is left as it was', async () => {
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  const text = '{ "version": 1, "held": { "nonsense": "x" } }\n';
  writeFileSync(join(m.state, 'sync.json'), text);
  const result = await runCli(m, ['uninstall', '--yes']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /sync\.json is not valid/);
  assert.equal(readFileSync(join(m.state, 'sync.json'), 'utf8'), text);
});
