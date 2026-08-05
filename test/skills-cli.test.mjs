import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, installGroups } from '../src/skills-cli.mjs';

test('buildCommand targets the right repo with an explicit skill list', () => {
  const { cmd, args } = buildCommand({ source: 'a/b', skills: ['one', 'two'] });
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'add', 'a/b', '--skill', 'one,two', '--global', '--yes']);
});

test('buildCommand handles a single skill', () => {
  const { args } = buildCommand({ source: 'a/b', skills: ['solo'] });
  assert.ok(args.includes('--skill'));
  assert.equal(args[args.indexOf('--skill') + 1], 'solo');
});

test('buildCommand always installs globally, never project-scoped', () => {
  const { args } = buildCommand({ source: 'a/b', skills: ['x'] });
  assert.ok(args.includes('--global'), 'skills belong in ~/.agents/skills, not a project');
});

test('installGroups in dry-run spawns nothing and echoes every group', async () => {
  const res = await installGroups(
    [
      { source: 'a/b', skills: ['one'] },
      { source: 'c/d', skills: ['two'] },
    ],
    { dryRun: true },
  );
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.ok));
});

test('installGroups with nothing to do returns an empty result', async () => {
  assert.deepEqual(await installGroups([], { dryRun: true }), []);
});
