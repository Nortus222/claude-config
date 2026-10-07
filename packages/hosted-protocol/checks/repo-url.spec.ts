import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRepoUrl, RepoUrlSchema } from '../src/repo-url.ts';
import { decodeHosted } from '../src/decode.ts';

test('repository normalization preserves remote identity and local Git fixtures', () => {
  for (const url of ['https://github.com/Owner/Repo.git/', 'ssh://git@github.com:2222/Owner/Repo.git', 'git@github.com:Owner/Repo.git', 'github.com/Owner/Repo']) assert.equal(normalizeRepoUrl(url), 'github.com/owner/repo');
  assert.equal(normalizeRepoUrl('  /Tmp/Repo.git/  '), '/Tmp/Repo');
  assert.equal(normalizeRepoUrl('file:///Tmp/My%20Repo.git'), '/Tmp/My Repo');
  assert.equal(normalizeRepoUrl('C:\\Work\\Repo.git'), 'C:\\Work\\Repo');
  assert.equal(normalizeRepoUrl('https://[bad'), null);
  assert.equal(normalizeRepoUrl('https://user:password@host/Repo?token=secret'), 'host/repo');
});

test('hosted repository references are remote, credential-free and never rewritten', () => {
  for (const url of ['https://github.com/Owner/Repo.git', 'ssh://git@github.com:2222/Owner/Repo.git', 'ssh://github.com/owner/repo', 'git@github.com:owner/repo.git', 'github.com/owner/repo']) assert.equal(decodeHosted(RepoUrlSchema, url), url);
  for (const url of ['', '/tmp/Repo', './repo', '../repo', '~/repo', 'C:\\Repo', 'file:///tmp/repo', 'http://host/repo',
    'https://user:secret@host/repo', 'https://git@host/repo', 'https://@host/repo', 'ssh://user@host/repo', 'ssh://git:secret@host/repo', 'ssh://git:@host/repo',
    'user@host:owner/repo', 'https://host/repo?token=secret', 'https://host/repo#fragment', 'https://host/a/../repo',
    'https://host/a/%2e%2e/repo', 'https://host/a/%2e/repo', 'https://host/a/%2E%2E%2Frepo', 'https://host/repo\\other',
    'https://host', 'host', 'host/', 'host//repo', 'host/../repo', 'github.com/owner/repo?token=secret',
    ' https://host/repo', 'https://host/repo ', 'https://[bad/repo', 'https://host/repo%ZZ']) assert.throws(() => decodeHosted(RepoUrlSchema, url), Error, url);
});
