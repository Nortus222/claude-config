import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsFailed, LaunchFailed, LockHeld, RepoNotFound } from '../src/index.ts';

test('each error carries a readable message', () => {
  assert.equal(new FsFailed({ op: 'write', path: '/a/b', reason: 'EACCES' }).message, 'write /a/b: EACCES');
  assert.equal(new LaunchFailed({ cmd: 'npx', reason: 'ENOENT' }).message, 'could not launch npx: ENOENT');
  assert.equal(new LockHeld({ path: '/s/apply.lock', pid: 42 }).message, 'another nortuscc run (pid 42) holds /s/apply.lock');
  assert.match(new RepoNotFound({ recorded: '/old/checkout' }).message, /\/old\/checkout/);
  assert.notEqual(new RepoNotFound({}).message, '');
});
