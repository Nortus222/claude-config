import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cause } from 'effect';
import { FsFailed, LockHeld } from '@nortuscc/machine';
import { causeMessage, failedStepsMessage, safeMessage } from '../src/operations/safety.ts';

test('a failure message keeps paths, errno reasons and exit codes but redacts credentials', () => {
  assert.equal(causeMessage(Cause.fail(new FsFailed({ op: 'write', path: '/home/u/.claude/settings.json', reason: 'EACCES: permission denied' }))),
    'Write /home/u/.claude/settings.json: EACCES: permission denied');
  assert.equal(causeMessage(Cause.fail(new LockHeld({ path: '/s/apply.lock', pid: 123 }))), 'Another nortuscc run (pid 123) holds /s/apply.lock');
  const leaked = safeMessage('push https://user:ghp_abcdefghijklmnop@github.com/o/r failed with Bearer abc.def nmt_secret123 sk-abcdefgh code ABCD-1234');
  assert.doesNotMatch(leaked, /ghp_|abc\.def|nmt_|sk-|ABCD-1234|user:/);
  assert.match(leaked, /^Push https:\/\/\[redacted\]github\.com\/o\/r failed with \[redacted\] \[redacted\] \[redacted\] code \[redacted\]$/);
});

test('a failure message is one bounded line', () => {
  assert.equal(safeMessage('first\n  second\tthird'), 'First second third');
  assert.equal([...safeMessage('x'.repeat(2000))].length, 500);
  assert.equal(safeMessage('   '), 'Unknown failure');
});

test('the failed-steps message names the first failed step, its note and how many more failed', () => {
  assert.equal(failedStepsMessage([{ key: 'a', outcome: 'ok', note: '' }]), undefined);
  assert.equal(failedStepsMessage([{ key: 'a', outcome: 'failed', note: 'npx exited with 1' }, { key: 'b', outcome: 'failed', note: 'x' }, { key: 'c', outcome: 'failed', note: '' }]),
    "Couldn't apply a: npx exited with 1 (2 more steps failed)");
  assert.equal(failedStepsMessage([{ key: 'a', outcome: 'failed', note: '' }]), "Couldn't apply a: no reason was reported");
});
