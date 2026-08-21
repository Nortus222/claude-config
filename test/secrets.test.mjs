import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeSecretName, looksLikeSecretValue } from '../src/secrets.mjs';

test('a field named like a credential is caught whatever its case or plural', () => {
  for (const name of ['token', 'Secret', 'passwords', 'apiKey', 'api_key', 'ACCESS_KEY', 'passphrase', 'credentials']) {
    assert.ok(looksLikeSecretName(name), `${name} should read as a credential name`);
  }
});

test('an ordinary field name is not a credential', () => {
  for (const name of ['effortLevel', 'theme', 'tui', 'worktree', 'tokenizer', 'keyboard']) {
    assert.equal(looksLikeSecretName(name), false, `${name} should not read as a credential name`);
  }
});

test('a credential-shaped value is caught wherever it appears', () => {
  assert.ok(looksLikeSecretValue('sk-abcd1234'));
  assert.ok(looksLikeSecretValue('ghp_abcdefgh12345678'));
  assert.ok(looksLikeSecretValue('AKIA0123456789AB'));
  assert.ok(looksLikeSecretValue('xoxb-abcdefgh-1234'));
  assert.ok(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----'));
});

test('ordinary text is not a credential value', () => {
  for (const text of ['high', 'fullscreen', 'auto', 'node_modules', '.cache']) {
    assert.equal(looksLikeSecretValue(text), false, `${text} should not read as a credential value`);
  }
});
