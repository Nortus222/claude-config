import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.ts';

test('strips userinfo from URLs', () => {
  assert.equal(
    redact('fatal: https://ada:s3cret@github.com/a/b.git not found'),
    'fatal: https://github.com/a/b.git not found',
  );
  assert.equal(redact('ssh://git@host.example/x.git'), 'ssh://host.example/x.git');
});

test('masks credential query values, including inside quotes', () => {
  assert.equal(
    redact('https://h/x?token=abc&ref=main&access_token=def'),
    'https://h/x?token=***&ref=main&access_token=***',
  );
  assert.equal(
    redact("fatal: '/nope/x?password=hunter2' does not appear to be a git repository"),
    "fatal: '/nope/x?password=***' does not appear to be a git repository",
  );
});

test('leaves ordinary text alone', () => {
  const text = 'git@github.com:a/b.git, ada@example.com and https://github.com/a/b.git';
  assert.equal(redact(text), text);
});

test('strips userinfo containing @ or quotes', () => {
  assert.equal(redact('https://user:p@ss@host/x'), 'https://host/x');
  assert.equal(redact("https://u:it's@host/x"), 'https://host/x');
});
