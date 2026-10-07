import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, machine, pushUpstream, readJson, runCli, syncedMachine } from './support/cli.ts';

// #43's done-when: an update to the shared config reaches a second machine through a preview, and
// that machine's overrides are still in place afterwards.

const EFFORT = 'setting:claude:settings.json#effortLevel';
const THEME = 'setting:claude:settings.json#theme';

test('an update reaches machine B through a preview, and B keeps its override and its skipped item', async () => {
  // Machine B: fully set up, with theme overridden to dark.
  const m = machine();
  mkdirSync(m.state, { recursive: true });
  const overrides = JSON.stringify({ version: 1, settings: { 'claude:settings.json': { theme: 'dark' } } }, null, 2) + '\n';
  writeFileSync(join(m.state, 'overrides.json'), overrides);
  await syncedMachine(m);
  const first = git(m.repo, 'rev-parse', 'HEAD');
  const keys = readJson(join(m.repo, 'claude', 'settings.keys.json'));
  const effortBefore = readJson(join(m.claude, 'settings.json')).effortLevel;

  // Machine A pushes a settings key change, an instruction file change and a key B overrides.
  const head = pushUpstream(m, {
    'claude/settings.keys.json': JSON.stringify({ ...keys, effortLevel: 'medium', theme: 'light' }, null, 2) + '\n',
    'claude/CLAUDE.md': '# shared rules, revised\n',
  });

  // B previews three items and the conflict, accepts two, skips one and keeps its override.
  const result = await runCli(m, ['sync', '--skip', EFFORT]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /file:claude:CLAUDE\.md\s+changed\s+sha256:\w{7} → sha256:\w{7}/);
  assert.match(result.stdout, new RegExp(`${EFFORT}\\s+changed\\s+"${effortBefore}" → "medium"`));
  assert.match(result.stdout, new RegExp(`${THEME}\\s+changed\\s+"${keys.theme}" → "light"`));
  assert.equal(result.stdout.match(/^ {2}\S+\s+(?:changed|added|removed)\s/gm)?.length, 3);
  assert.match(result.stdout, new RegExp(`${THEME}\\s+conflict\\s+overridden by settings\\.claude:settings\\.json\\.theme`));

  // The accepted items are on disk; the skipped one and the overridden key are unchanged.
  assert.equal(readFileSync(join(m.claude, 'CLAUDE.md'), 'utf8'), '# shared rules, revised\n');
  const settings = readJson(join(m.claude, 'settings.json'));
  assert.equal(settings.effortLevel, effortBefore);
  assert.equal(settings.theme, 'dark');
  assert.equal(readFileSync(join(m.state, 'overrides.json'), 'utf8'), overrides);

  // state.json records the applied commit; sync.json holds the skipped item at the old one.
  assert.equal(readJson(join(m.state, 'state.json')).applied.commit, head);
  assert.deepEqual(readJson(join(m.state, 'sync.json')).held, { [EFFORT]: first });
  const decisions = readJson(join(m.state, 'decisions.json')).decisions as Array<{ itemId: string; decision: string; commit: string }>;
  assert.deepEqual(decisions.map((d) => [d.itemId, d.decision, d.commit]).sort(), [
    ['file:claude:CLAUDE.md', 'accept', head], [EFFORT, 'skip', head], [THEME, 'accept', head],
  ]);

  // A later status reports agreement, naming the hold.
  const status = await runCli(m, ['status']);
  assert.equal(status.code, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /everything is in agreement/);
  assert.match(status.stdout, new RegExp(`held\\s+1\\s+${EFFORT}`));
});

test('a raw git pull leaves items waiting until sync decides them', async () => {
  const m = machine();
  await syncedMachine(m);
  assert.equal((await runCli(m, ['sync'])).code, 0);
  pushUpstream(m, { 'claude/CLAUDE.md': '# pulled by hand\n' });
  git(m.repo, 'pull', '-q');

  const waiting = await runCli(m, ['status']);
  assert.equal(waiting.code, 1);
  assert.match(waiting.stdout, /1 item waits for you: run nortuscc sync/);

  assert.equal((await runCli(m, ['sync', '--yes'])).code, 0);
  const agreed = await runCli(m, ['status']);
  assert.equal(agreed.code, 0, agreed.stdout + agreed.stderr);
  assert.doesNotMatch(agreed.stdout, /wait for you|waits for you/);
});
