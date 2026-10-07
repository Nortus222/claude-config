import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, pushUpstream, readJson, runCli, syncedMachine, type Machine } from './support/cli.ts';

// apply and status with held items (sync.json written by hand here; `nortuscc sync` writes it).

const EFFORT = 'setting:claude:settings.json#effortLevel';
const AGREEMENT = /everything is in agreement/;

const writeSync = (m: Machine, text: string) => {
  mkdirSync(m.state, { recursive: true });
  writeFileSync(join(m.state, 'sync.json'), text);
};
const hold = (m: Machine, held: Record<string, string>) => writeSync(m, JSON.stringify({ version: 1, held }, null, 2) + '\n');

// Commits effortLevel 'medium' locally (unpushed, so the CLI stays current) and answers the old value.
const commitEffort = (m: Machine): unknown => {
  const path = join(m.repo, 'claude', 'settings.keys.json');
  const keys = readJson(path);
  writeFileSync(path, JSON.stringify({ ...keys, effortLevel: 'medium' }, null, 2) + '\n');
  git(m.repo, 'commit', '-qam', 'effort medium');
  return keys.effortLevel;
};

test('apply keeps a held settings key at its held value', async () => {
  const m = machine();
  const first = git(m.repo, 'rev-parse', 'HEAD');
  const before = commitEffort(m);
  hold(m, { [EFFORT]: first });
  const result = await runCli(m, ['apply']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readJson(join(m.claude, 'settings.json')).effortLevel, before);
});

test('status names held items and still agrees, since holds alone are not drift', async () => {
  const m = machine();
  await syncedMachine(m);
  const first = git(m.repo, 'rev-parse', 'HEAD');
  commitEffort(m);
  hold(m, { [EFFORT]: first });
  const result = await runCli(m, ['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sync$/m);
  assert.match(result.stdout, /held\s+1\s+setting:claude:settings\.json#effortLevel/);
  assert.match(result.stdout, AGREEMENT);
});

test('a machine with no holds prints no sync section', async () => {
  const m = machine();
  await syncedMachine(m);
  const result = await runCli(m, ['status']);
  assert.doesNotMatch(result.stdout, /^sync$/m);
});

test('an invalid sync.json refuses apply and status, and is left as it was', async () => {
  const m = machine();
  const text = '{ "version": 1, "held": { "nonsense": "x" } }\n';
  writeSync(m, text);
  for (const verb of ['apply', 'status']) {
    const result = await runCli(m, [verb]);
    assert.equal(result.code, 1, verb);
    assert.match(result.stderr, /sync\.json is not valid/, verb);
  }
  assert.equal(existsSync(join(m.claude, 'CLAUDE.md')), false);
  assert.equal(readFileSync(join(m.state, 'sync.json'), 'utf8'), text);
});

test('a hold on a commit the checkout lacks refuses apply', async () => {
  const m = machine();
  hold(m, { [EFFORT]: 'f'.repeat(40) });
  const result = await runCli(m, ['apply']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not be fetched: no such commit in the checkout/);
});

test('items a raw git pull brought in wait for nortuscc sync, and fail status', async () => {
  const m = machine();
  await syncedMachine(m);
  const statePath = join(m.state, 'state.json');
  const state = readJson(statePath);
  writeFileSync(statePath, JSON.stringify({ ...state, applied: { commit: git(m.repo, 'rev-parse', 'HEAD'), at: new Date().toISOString() } }, null, 2) + '\n');
  pushUpstream(m, { 'claude/CLAUDE.md': '# from another machine\n' });
  git(m.repo, 'pull', '-q');
  const result = await runCli(m, ['status']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /1 item waits for you: run nortuscc sync/);
});

test('a held copied file applies its held bytes, agrees, and once released needs apply', async () => {
  const m = machine();
  await syncedMachine(m);
  const first = git(m.repo, 'rev-parse', 'HEAD');
  const original = readFileSync(join(m.repo, 'claude', 'CLAUDE.md'), 'utf8');
  writeFileSync(join(m.repo, 'claude', 'CLAUDE.md'), '# newer rules\n');
  git(m.repo, 'commit', '-qam', 'newer rules');
  hold(m, { 'file:claude:CLAUDE.md': first });

  const applied = await runCli(m, ['apply']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), original);
  const held = await runCli(m, ['status']);
  assert.equal(held.code, 0, held.stdout + held.stderr);
  assert.match(held.stdout, AGREEMENT);

  hold(m, {});
  const released = await runCli(m, ['status']);
  assert.equal(released.code, 1);
  assert.match(released.stdout, /CLAUDE\.md\s+repo-ahead/);
  assert.match(released.stdout, /nortuscc apply/);
});
