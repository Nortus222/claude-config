import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertReleaseContext, assertProtectedEnvironment, verifyPublicImage, readBounded } from '../infra/release.ts';

const sha = 'a'.repeat(40);
const context = { event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'Nortus222/claude-config', captured: sha, reviewed: sha, head: sha };
const protectedEnvironment = { protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User', reviewer: { id: 1 } }] }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
const policies = { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] };
test('only the captured reviewed main commit can release', () => {
  assert.doesNotThrow(() => assertReleaseContext(context));
  for (const patch of [{ event: 'push' }, { ref: 'refs/tags/main' }, { repository: 'fork/config' }, { reviewed: 'b'.repeat(40) }, { head: 'b'.repeat(40) }, { captured: `${sha}\n` }, { reviewed: '$(id)' }]) assert.throws(() => assertReleaseContext({ ...context, ...patch }));
});
test('environment needs reviewers and exactly main branch, never wildcard/tag/all branches', () => {
  assert.doesNotThrow(() => assertProtectedEnvironment(protectedEnvironment, policies));
  for (const value of [{}, { ...protectedEnvironment, protection_rules: [] }, { ...protectedEnvironment, protection_rules: [{ type: 'required_reviewers', reviewers: [] }] }, { ...protectedEnvironment, deployment_branch_policy: null }, { ...protectedEnvironment, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }]) assert.throws(() => assertProtectedEnvironment(value, policies));
  for (const value of [{ total_count: 0, branch_policies: [] }, { total_count: 2, branch_policies: policies.branch_policies }, { total_count: 1, branch_policies: [{ name: '*', type: 'branch' }] }, { total_count: 1, branch_policies: [{ name: 'main', type: 'tag' }] }]) assert.throws(() => assertProtectedEnvironment(protectedEnvironment, value));
});
const digest = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
function fixture(revision = sha, architecture = 'amd64') {
  const config = JSON.stringify({ os: 'linux', architecture, config: { Labels: { 'org.opencontainers.image.source': 'https://github.com/Nortus222/claude-config', 'org.opencontainers.image.revision': revision } } });
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: digest(config) } });
  const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ digest: digest(manifest), platform: { os: 'linux', architecture: 'amd64' } }] });
  const requests: { url: string; auth: string | null }[] = [];
  const transport: typeof fetch = async (url, options) => {
    const address = String(url); const auth = new Headers(options?.headers).get('authorization'); requests.push({ url: address, auth });
    assert.equal(options?.redirect, address.includes('/blobs/') ? 'manual' : 'error'); assert.ok(options?.signal);
    const body = address.includes('/token?') ? JSON.stringify({ token: 'anonymous-token' }) : address.endsWith(digest(index)) ? index : address.endsWith(digest(manifest)) ? manifest : address.endsWith(digest(config)) ? config : null;
    return new Response(body, { status: body === null ? 404 : 200 });
  };
  return { image: `ghcr.io/nortus222/claude-config-service@${digest(index)}`, requests, transport, config, configDigest: digest(config) };
}
test('anonymous digest verification checks hashed amd64 config source and exact revision', async () => {
  const f = fixture(); await verifyPublicImage(f.image, sha, f.transport);
  assert.equal(f.requests.length, 4); assert.equal(f.requests[0]?.auth, null);
  assert.ok(f.requests.slice(1).every(x => x.auth === 'Bearer anonymous-token'));
  for (const f of [fixture('b'.repeat(40)), fixture(sha, 'arm64')]) await assert.rejects(verifyPublicImage(f.image, sha, f.transport));
  await assert.rejects(verifyPublicImage('ghcr.io/foreign/image:latest', sha, fixture().transport));
  await assert.rejects(verifyPublicImage(f.image, sha, async () => new Response(null, { status: 404 })));
  await assert.rejects(verifyPublicImage(f.image, sha, async () => new Response('{}')));
});
test('transport bounds bodies including missing content-length and rejects redirects/status', async () => {
  await assert.rejects(readBounded('https://ghcr.io/test', {}, async () => new Response('x'.repeat(1_048_577))));
  await assert.rejects(readBounded('https://ghcr.io/test', {}, async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } })));
  assert.equal(await readBounded('https://ghcr.io/test', {}, async () => new Response('ok')), 'ok');
});
test('environment API failures fail closed before approval jobs', async () => {
  const { verifyEnvironment } = await import('../infra/release.ts');
  for (const status of [404, 403, 500]) await assert.rejects(verifyEnvironment('hosted-image', 'runner-token', async () => new Response(null, { status })));
  let requests = 0;
  await verifyEnvironment('hosted-image', 'runner-token', async (_url, options) => { assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer runner-token'); return new Response(JSON.stringify(++requests === 1 ? protectedEnvironment : policies)); });
  assert.equal(requests, 2);
});
test('GHCR blob follows one known HTTPS CDN redirect without sending its anonymous bearer token', async () => {
  const f = fixture(); let cdn = 0;
  const configTransport: typeof fetch = async (url, options) => {
    if (String(url).includes('/blobs/')) return new Response(null, { status: 307, headers: { location: 'https://pkg-containers.githubusercontent.com/ghcr1/blob?signature=public' } });
    if (String(url).startsWith('https://pkg-containers.githubusercontent.com/')) {
      cdn++; assert.equal(new Headers(options?.headers).get('authorization'), null); assert.equal(options?.redirect, 'error'); assert.ok(options?.signal);
      return new Response(f.config);
    }
    return f.transport(url, options);
  };
  await verifyPublicImage(f.image, sha, configTransport); assert.equal(cdn, 1);
  for (const location of ['http://pkg-containers.githubusercontent.com/blob', 'https://evil.invalid/blob', 'https://user@pkg-containers.githubusercontent.com/blob', 'https://pkg-containers.githubusercontent.com:444/blob']) {
    await assert.rejects(verifyPublicImage(f.image, sha, async (url, options) => String(url).includes('/blobs/') ? new Response(null, { status: 307, headers: { location } }) : f.transport(url, options)));
  }
});
test('rollback verifies separately reviewed image ancestor using only literal Git arguments', async () => {
  const { checkImageCommit } = await import('../infra/release.ts');
  const prior = 'b'.repeat(40); const calls: string[][] = [];
  const captured: string[][] = [];
  await checkImageCommit(prior, sha, async args => { captured.push([...args]); });
  assert.deepEqual(captured, [['merge-base', '--is-ancestor', prior, sha]]);
  await assert.rejects(checkImageCommit(prior, sha, async () => { throw new Error('not ancestor'); }));
  for (const value of ['$(id)', '--help', `${prior}\n`, 'latest']) await assert.rejects(checkImageCommit(value, sha, async args => { calls.push([...args]); }));
  assert.equal(calls.length, 0);
});

test('both release environments require self-review prevention in direct rules and read-only API metadata', async () => {
  const { verifyEnvironment } = await import('../infra/release.ts');
  const rule = protectedEnvironment.protection_rules[0]!;
  for (const prevent_self_review of [false, undefined]) {
    const environment = { ...protectedEnvironment, protection_rules: [{ ...rule, prevent_self_review }] };
    assert.throws(() => assertProtectedEnvironment(environment, policies));
    for (const name of ['hosted-image', 'hosted-production']) {
      let requests = 0;
      await assert.rejects(verifyEnvironment(name, 'runner-token', async (_url, options) => {
        assert.equal(options?.method ?? 'GET', 'GET'); requests++;
        return new Response(JSON.stringify(requests === 1 ? environment : policies));
      }));
      assert.equal(requests, 2);
    }
  }
  for (const name of ['hosted-image', 'hosted-production']) {
    let requests = 0;
    await verifyEnvironment(name, 'runner-token', async () => new Response(JSON.stringify(++requests === 1 ? protectedEnvironment : policies)));
    assert.equal(requests, 2);
  }
});
