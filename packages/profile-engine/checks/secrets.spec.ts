import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeSecretName, looksLikeSecretValue, nestedSecretComplaints } from '../src/secrets.ts';

test('credential-shaped field names are secrets', () => {
  for (const name of ['token', 'Secrets', 'api_key', 'apiKeys', 'access_key', 'PASSWORD', 'passwords', 'passphrase', 'credentials']) {
    assert.equal(looksLikeSecretName(name), true, name);
  }
  for (const name of ['theme', 'tokenizer', 'effortLevel', 'tui', 'worktree', 'keyboard']) assert.equal(looksLikeSecretName(name), false, name);
});

test('credential-shaped values are secrets wherever they appear', () => {
  for (const value of ['sk-abcd1234', 'x ghp_12345678 y', 'AKIA12345678', 'xoxb-12345678', '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.equal(looksLikeSecretValue(value), true, value);
  }
  for (const value of ['auto', 'high', 'fullscreen', 'node_modules', '.cache']) assert.equal(looksLikeSecretValue(value), false, value);
});

test('nested values are walked, naming the path of each complaint', () => {
  assert.deepEqual(nestedSecretComplaints({ a: { token: 'x' }, list: ['ok', 'sk-abcdef12'] }, ''), [
    "settings key 'a.token' looks like a secret; this file is committed",
    "settings key 'list[1]' contains what looks like a secret value",
  ]);
  assert.deepEqual(nestedSecretComplaints({ theme: 'auto', n: 1, b: null }, ''), []);
});
