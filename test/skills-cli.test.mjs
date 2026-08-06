import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommand,
  installGroups,
  buildUpdateCommand,
  runUpdate,
  buildRemoveCommand,
  runRemove,
} from '../src/skills-cli.mjs';

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

test('installGroups in dry-run never reaches the runner, not merely leaves it unobserved', async () => {
  const run = () => { throw new Error('run must not be called during dry-run'); };
  const res = await installGroups(
    [
      { source: 'a/b', skills: ['one'] },
      { source: 'c/d', skills: ['two'] },
    ],
    { dryRun: true, run },
  );
  assert.equal(res.length, 2);
  assert.ok(res.every((r) => r.ok));
});

test('installGroups with nothing to do returns an empty result', async () => {
  assert.deepEqual(await installGroups([], { dryRun: true }), []);
});

test('installGroups outside dry-run calls the runner once per group with the built command', async () => {
  const calls = [];
  const run = async (command) => { calls.push(command); return true; };
  const res = await installGroups(
    [
      { source: 'a/b', skills: ['one', 'two'] },
      { source: 'c/d', skills: ['three'] },
    ],
    { run },
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], buildCommand({ source: 'a/b', skills: ['one', 'two'] }));
  assert.deepEqual(calls[1], buildCommand({ source: 'c/d', skills: ['three'] }));
  assert.deepEqual(res, [{ source: 'a/b', ok: true }, { source: 'c/d', ok: true }]);
});

test('buildUpdateCommand names every skill and stays global and non-interactive', () => {
  const { cmd, args } = buildUpdateCommand(['one', 'two']);
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'update', 'one', 'two', '--global', '--yes']);
});

test('buildUpdateCommand passes names as separate arguments, not a comma list', () => {
  const { args } = buildUpdateCommand(['one', 'two']);
  assert.ok(!args.some((a) => a.includes(',')), 'update takes a name list, unlike add --skill');
});

test('buildUpdateCommand handles a single skill', () => {
  const { args } = buildUpdateCommand(['solo']);
  assert.deepEqual(args, ['-y', 'skills', 'update', 'solo', '--global', '--yes']);
});

test('runUpdate in dry-run never reaches the runner, not merely leaves it unobserved', async () => {
  const run = () => { throw new Error('run must not be called during dry-run'); };
  assert.equal(await runUpdate(['one'], { dryRun: true, run }), true);
});

test('runUpdate with nothing to update never reaches the runner', async () => {
  const run = () => { throw new Error('run must not be called for an empty list'); };
  assert.equal(await runUpdate([], { dryRun: false, run }), true, 'an empty list must not reach the runner');
});

test('runUpdate outside dry-run calls the runner exactly once with the built command', async () => {
  const calls = [];
  const run = async (command) => { calls.push(command); return true; };
  assert.equal(await runUpdate(['one'], { run }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], buildUpdateCommand(['one']));
});

test('buildRemoveCommand names every skill and stays global and non-interactive', () => {
  const { cmd, args } = buildRemoveCommand(['one', 'two']);
  assert.equal(cmd, 'npx');
  assert.deepEqual(args, ['-y', 'skills', 'remove', 'one', 'two', '--global', '--yes']);
});

test('buildRemoveCommand passes names positionally, like update and unlike add', () => {
  const { args } = buildRemoveCommand(['one', 'two']);
  assert.ok(!args.some((a) => a.includes(',')));
});

test('runRemove in dry-run never reaches the runner, not merely leaves it unobserved', async () => {
  const run = () => { throw new Error('run must not be called during dry-run'); };
  assert.equal(await runRemove(['one'], { dryRun: true, run }), true);
});

test('runRemove with nothing to remove never reaches the runner', async () => {
  const run = () => { throw new Error('run must not be called for an empty list'); };
  assert.equal(await runRemove([], { dryRun: false, run }), true, 'an empty list must not reach the runner');
});

test('runRemove outside dry-run calls the runner exactly once with the built command', async () => {
  const calls = [];
  const run = async (command) => { calls.push(command); return true; };
  assert.equal(await runRemove(['one'], { run }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], buildRemoveCommand(['one']));
});
