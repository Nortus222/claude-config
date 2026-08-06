import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { interpret, confirm } from '../src/prompt.mjs';

const sink = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('interpret accepts y and yes in any case', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', 'Yes', ' y ', 'yes\n']) {
    assert.equal(interpret(yes), true, `${JSON.stringify(yes)} should mean yes`);
  }
});

test('interpret treats empty input as no', () => {
  assert.equal(interpret(''), false);
  assert.equal(interpret('   '), false);
});

test('interpret treats anything else as no', () => {
  for (const no of ['n', 'no', 'yep', 'sure', 'yy', 'q']) {
    assert.equal(interpret(no), false, `${JSON.stringify(no)} should mean no`);
  }
});

test('confirm returns true when the answer is yes', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from(['y\n']),
    output: sink(),
    isTTY: true,
  });
  assert.equal(answer, true);
});

test('confirm returns false when the answer is empty', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from(['\n']),
    output: sink(),
    isTTY: true,
  });
  assert.equal(answer, false);
});

test('confirm returns null without a TTY instead of blocking', async () => {
  const answer = await confirm('Update 2 skill(s)?', {
    input: Readable.from([]),
    output: sink(),
    isTTY: false,
  });
  assert.equal(answer, null);
});
