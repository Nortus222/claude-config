import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  decodeHosted, normalizeRepoUrl as hostedRepoUrl, parseItemId as hostedItemId,
  POLICIES as hostedPolicies, PolicySchema, RepoUrlSchema, RevisionPublicationSchema,
} from '@nortuscc/hosted-protocol';
import {
  desiredOfDocuments, diffItems, itemIdOf, itemValues, normalizeRepoUrl, originUrl, parseItemId,
} from '@nortuscc/sync';
import { normalizeRepoUrl as agentRepoUrl, POLICIES } from '../src/index.ts';
import { BASE, json, runSync, tempSetup, withDocuments } from '../../sync/checks/support/repo.ts';

test('existing local exports use the shared identity and policy definitions', () => {
  assert.equal(parseItemId, hostedItemId);
  assert.equal(normalizeRepoUrl, hostedRepoUrl);
  assert.equal(agentRepoUrl, hostedRepoUrl);
  assert.equal(POLICIES, hostedPolicies);
  for (const policy of POLICIES) assert.equal(decodeHosted(PolicySchema, policy), policy);
});

test('engine-resolved observed keys and document changes retain hosted item identities', () => {
  const after = withDocuments(BASE, {
    'claude/settings.keys.json': json({ theme: 'auto', effortLevel: 'max' }),
    'claude/CLAUDE.md': '# changed rules\n',
    'skills-manifest.txt': '[mattpocock/skills]\ntdd\ndiagnose\n\n[anthropics/skills]\npdf\n',
    'integrations.json': json({ version: 1, integrations: [] }),
  });
  const desired = desiredOfDocuments(BASE);
  const changes = diffItems(itemValues(BASE), itemValues(after));
  const publication = decodeHosted(RevisionPublicationSchema, {
    number: 1, commitSha: 'a'.repeat(40), tag: 'v1', changelog: '', requiredEnv: [],
    items: changes.map(({ itemId, kind, after }) => ({ id: itemId, kind, change: after === undefined ? 'removed' : 'changed' })),
  });
  const observedKeys = [
    'config:claude:settings.json#effortLevel', 'config:claude:CLAUDE.md',
    'skill:pdf', 'integration:hk', 'integration:sp',
  ];
  assert.deepEqual(publication.items.map((item) => item.id).sort(), observedKeys.map((key) => itemIdOf(key, desired)).sort());
  for (const item of publication.items) assert.equal(parseItemId(item.id)?.kind, item.kind);
  assert.equal(itemIdOf('skill:undeclared', desired), undefined);
  assert.equal(itemIdOf('config:claude:settings.json', desired), undefined);
});

test('local Git fixture origins stay comparable without becoming hosted repository URLs', async () => {
  const fixture = tempSetup();
  try {
    const origin = await runSync(originUrl(fixture.checkout));
    assert.equal(origin, fixture.origin);
    assert.equal(normalizeRepoUrl(origin!), normalizeRepoUrl(pathToFileURL(fixture.origin).href));
    assert.equal(normalizeRepoUrl(origin!), fixture.origin.replace(/\.git$/, ''));
    assert.throws(() => decodeHosted(RepoUrlSchema, origin), /Invalid hosted payload/);
    const remote = decodeHosted(RepoUrlSchema, 'git@github.com:Nortus222/Claude-Config.git');
    assert.equal(agentRepoUrl(remote), normalizeRepoUrl('https://github.com/Nortus222/Claude-Config/'));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
