import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cause } from 'effect';
import { FsFailed, LockHeld } from '@nortuscc/machine';
import { causeMessage, failedStepsMessage, safeMessage, safeNote } from '../src/operations/safety.ts';

test('a failure message keeps paths, errno reasons and exit codes but redacts credentials', () => {
  assert.equal(causeMessage(Cause.fail(new FsFailed({ op: 'write', path: '/home/u/.claude/settings.json', reason: 'EACCES: permission denied' }))),
    'Write /home/u/.claude/settings.json: EACCES: permission denied');
  assert.equal(causeMessage(Cause.fail(new LockHeld({ path: '/s/apply.lock', pid: 123 }))), 'Another nortuscc run (pid 123) holds /s/apply.lock');
  const leaked = safeMessage('push https://user:ghp_abcdefghijklmnop@github.com/o/r failed with Bearer abc.def nmt_secret123 sk-abcdefgh code ABCD-1234');
  assert.doesNotMatch(leaked, /ghp_|abc\.def|nmt_|sk-|ABCD-1234|user:/);
  assert.match(leaked, /^Push https:\/\/\[redacted\]github\.com\/o\/r failed with \[redacted\] \[redacted\] \[redacted\] code \[redacted\]$/);
});

// [what it carries, text, its redacted form]
const CREDENTIALS: ReadonlyArray<readonly [string, string, string]> = [
  ['a fine-grained GitHub token', 'push failed: github_pat_11ABCDEFG0123456789_abcdefXYZ', 'Push failed: [redacted]'],
  ['a classic GitHub token', 'token ghp_abcdefghijklmnop rejected', 'Token [redacted] rejected'],
  ['a GitLab token', 'clone with glpat-AbCdEf123456_-xyz failed', 'Clone with [redacted] failed'],
  ['an access_token query parameter', 'GET https://h/x?access_token=abc123&page=2 failed', 'GET https://h/x?access_token=[redacted]&page=2 failed'],
  ['a token query parameter', 'fetch https://h/x?token=abc123 failed', 'Fetch https://h/x?token=[redacted] failed'],
  ['an api_key query parameter', 'fetch https://h/x?a=1&api_key=k3y#frag failed', 'Fetch https://h/x?a=1&api_key=[redacted]#frag failed'],
  ['a Basic authorization header', 'sent Authorization: Basic dXNlcjpwYXNz to h', 'Sent Authorization: [redacted] to h'],
  ['a Bearer authorization header', 'sent Authorization: Bearer abc.def to h', 'Sent Authorization: [redacted] to h'],
  ['an API key assignment', 'env OPENROUTER_API_KEY=abc123 is set', 'Env OPENROUTER_API_KEY=[redacted] is set'],
  ['a token assignment', 'GITHUB_TOKEN=xyz npx exited', 'GITHUB_TOKEN=[redacted] npx exited'],
  ['a quoted secret assignment', 'CLIENT_SECRET="two words" npx exited', 'CLIENT_SECRET=[redacted] npx exited'],
  ['a JSON api_key value', 'body {"api_key": "abc 123", "n": 1}', 'Body {"api_key": "[redacted]", "n": 1}'],
  ['URL user-info whose password holds @', 'push https://user:p@ss@github.com/o/r failed', 'Push https://[redacted]github.com/o/r failed'],
  ['URL user-info before an email in the query', 'get https://u:pw@h/x?email=a@b.c', 'Get https://[redacted]h/x?email=a@b.c'],
  ['a Slack token', 'post xoxb-1234-5678-abcdEFGH failed', 'Post [redacted] failed'],
  ['a Slack app-level token', 'post xoxe-1-abcdef failed', 'Post [redacted] failed'],
  ['an AWS access key id', 'key AKIAIOSFODNN7EXAMPLE denied', 'Key [redacted] denied'],
  ['an OpenAI key', 'used sk-proj-abcdEFGH1234 here', 'Used [redacted] here'],
  ['an Anthropic key', 'used sk-ant-api03-abcdEFGH_1234 here', 'Used [redacted] here'],
  ['an OpenRouter key', 'used sk-or-v1-0123456789abcdef here', 'Used [redacted] here'],
  ['a hosted machine token', 'sent nmt_abc_123 to h', 'Sent [redacted] to h'],
];

for (const [what, text, redacted] of CREDENTIALS) {
  test(`a failure message redacts ${what}`, () => assert.equal(safeMessage(text), redacted));
}

test('a step note is redacted and bounded in its own case, and an empty note stays empty', () => {
  assert.equal(safeNote('npx exited with 1: GITHUB_TOKEN=xyz'), 'npx exited with 1: GITHUB_TOKEN=[redacted]');
  assert.equal(safeNote(''), '');
  assert.equal([...safeNote('x'.repeat(5000))].length, 2000);
});

test('a failure message keeps ordinary words, paths and URLs', () => {
  for (const text of ['Basic configuration is missing', 'Read /home/u/.claude/settings.json: ENOENT', 'Fetch https://github.com/o/r?ref=main failed (npx exited with 1)', 'Token budget exceeded'])
    assert.equal(safeMessage(text), text);
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
