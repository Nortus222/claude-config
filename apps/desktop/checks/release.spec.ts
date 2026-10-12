import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertContext, releaseOverlay, prepareRelease, verifyChecks, publishRelease } from '../scripts/release.ts';

const sha = 'a'.repeat(40);
const publicKey = Buffer.from(`untrusted comment: test only\n${Buffer.concat([Buffer.from('Ed'), Buffer.alloc(40, 1)]).toString('base64')}\n`).toString('base64');
const context = { event: 'workflow_dispatch', ref: 'refs/heads/main', repository: 'Nortus222/claude-config', captured: sha, reviewed: sha, head: sha, main: sha, version: '0.2.0', versions: ['0.2.0', '0.2.0', '0.2.0'] };

test('publication command requires explicit opt-in before inspecting source or making requests', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-publish-guard-'));
  try {
    const script = fileURLToPath(new URL('../scripts/release.ts', import.meta.url));
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      const result = spawnSync(process.execPath, [script, 'publish'], {
        cwd: home, encoding: 'utf8', timeout: 10_000,
        env: { HOME: home, ...(value === undefined ? {} : { DESKTOP_PUBLISH: value }) },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /publication must be explicitly enabled/);
    }
    const source = join(home, 'source');
    const hooks = join(home, 'empty-hooks');
    const env = {
      HOME: home, PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    await mkdir(join(source, 'apps/desktop/src-tauri'), { recursive: true });
    await mkdir(hooks);
    await writeFile(join(source, 'apps/desktop/package.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFile(join(source, 'apps/desktop/src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.2.0' }));
    await writeFile(join(source, 'apps/desktop/src-tauri/Cargo.toml'), 'version = "0.2.0"\n');
    for (const args of [
      ['init', '--template=', '--initial-branch=main'],
      ['add', '.'],
      ['-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'],
      ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
    ]) {
      const result = spawnSync('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgSign=false', ...args], {
        cwd: source, env, encoding: 'utf8', timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
    const optedIn = spawnSync(process.execPath, [script, 'publish'], {
      cwd: source, encoding: 'utf8', timeout: 10_000,
      env: { ...env, DESKTOP_PUBLISH: 'true' },
    });
    assert.equal(optedIn.status, 1);
    assert.match(optedIn.stderr, /dispatch must name the exact reviewed main SHA/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('manual release workflow defaults to validation and grants publication only to an opted-in job', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
  const [header, jobs] = workflow.split('\njobs:\n');
  assert.match(header!, /\n      publish:\n(?:        [^\n]+\n)*        default: false\n/);
  assert.match(header!, /\n      publish:\n(?:        [^\n]+\n)*        type: boolean\n/);
  const [preparation, publication] = jobs!.split('\n  publish:\n');
  assert.ok(!preparation!.includes('DESKTOP_PUBLISH'));
  assert.ok(!preparation!.includes('contents: write'));
  assert.match(publication!, /if: .*inputs\.publish == true/);
  assert.ok(publication!.includes('DESKTOP_PUBLISH: ${{ inputs.publish }}'));
});

test('release requires exact reviewed main source and synchronized stable versions', () => {
  assert.doesNotThrow(() => assertContext(context));
  for (const value of [ { event: 'push' }, { ref: 'refs/heads/feature' }, { repository: 'fork/repo' }, { reviewed: 'b'.repeat(40) }, { main: 'b'.repeat(40) }, { version: '0.2.0-beta.1' }, { versions: ['0.1.0'] } ]) assert.throws(() => assertContext({ ...context, ...value }));
});
test('release overlay requires a minisign public key and enables signed versions on the fixed stable channel', () => {
  const overlay = releaseOverlay(publicKey);
  assert.equal(overlay.plugins.updater.requireSignedVersion, true);
  assert.deepEqual(overlay.plugins.updater.endpoints, ['https://github.com/Nortus222/claude-config/releases/download/desktop-stable-channel/latest.json']);
  assert.equal(overlay.plugins.updater.pubkey, publicKey);
  for (const key of ['', 'placeholder', Buffer.from('untrusted comment: key\nnot-key').toString('base64'), publicKey + '\n']) assert.throws(() => releaseOverlay(key));
});
test('all required workflows must complete successfully on the exact reviewed SHA', async () => {
  const transport: typeof fetch = async () => new Response(JSON.stringify({ total_count: 4, workflow_runs: ['macos.yml','linux.yml','windows.yml','cosmos.yml'].map(path => ({ path: `.github/workflows/${path}`, head_sha: sha, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', id: 1 })) }));
  await verifyChecks(sha, 'test-token', transport);
  await assert.rejects(verifyChecks(sha, '', async () => new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }))));
  await assert.rejects(verifyChecks(sha, '', async () => new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ path: '.github/workflows/macos.yml', head_sha: sha, status: 'completed', conclusion: 'failure' }] }))));
});

async function fixture(run: (dir: string, input: Parameters<typeof prepareRelease>[0]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-release-'));
  try {
    const archive = join(dir, 'Nortuscc.app.tar.gz'); const dmg = join(dir, 'Nortuscc_0.2.0_aarch64.dmg'); const signature = archive + '.sig';
    await writeFile(archive, 'signed artifact'); await writeFile(dmg, 'signed dmg'); await writeFile(signature, 'test signature');
    const bytes = await readFile(archive);
    await run(dir, { version: '0.2.0', commit: sha, publicKey, archive, dmg, signature, architecture: 'darwin-aarch64', artifactUrl: 'https://github.com/Nortus222/claude-config/releases/download/desktop-v0.2.0/Nortuscc.app.tar.gz', expectedHash: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length, notes: 'Plain release notes', verifySignature: async () => {} });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('preparation binds metadata to immutable versioned artifacts and rejects identity, hash, size and signature failures', async () => fixture(async (_dir, input) => {
  const result = await prepareRelease(input);
  assert.equal(result.tag, 'desktop-v0.2.0'); assert.equal(result.latest.version, '0.2.0');
  assert.deepEqual(Object.keys(result.latest.platforms), ['darwin-aarch64']);
  for (const value of [{ version: '0.3.0' }, { version: '0.2.0-beta' }, { architecture: 'darwin-x86_64' }, { artifactUrl: input.artifactUrl.replace('https:', 'http:') }, { artifactUrl: input.artifactUrl + '?x=1' }, { expectedHash: 'f'.repeat(64) }, { expectedSize: input.expectedSize + 1 }, { verifySignature: async () => { throw new Error('bad signature or signed version'); } }]) await assert.rejects(prepareRelease({ ...input, ...value }));
  await writeFile(input.archive, 'corrupted artifact'); await assert.rejects(prepareRelease(input));
}));
test('publication refuses an existing versioned release without overwriting assets', async () => fixture(async (_dir, input) => {
  const prepared = await prepareRelease(input); const calls: string[] = [];
  await assert.rejects(publishRelease(prepared, 'test-token', async (url, init) => { calls.push(`${init?.method ?? 'GET'} ${url}`); return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }));
  assert.equal(calls.length, 1); assert.ok(calls[0]?.includes('desktop-v0.2.0'));
}));
test('publisher creates versioned artifacts first and only latest.json on the separate stable release', async () => fixture(async (_dir, input) => {
  const prepared = await prepareRelease(input); const calls: { url: string; method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = String(url); const method = init?.method ?? 'GET'; calls.push({ url: path, method, body: init?.body });
    if (path.includes('/tags/')) return new Response('{}', { status: 404 });
    if (path.endsWith('/releases') && method === 'POST') { const body = JSON.parse(String(init?.body)); assert.equal(body.make_latest, 'false'); return new Response(JSON.stringify({ id: body.tag_name === prepared.tag ? 1 : 2 })); }
    return new Response('{}');
  };
  await publishRelease(prepared, 'test-token', transport);
  const uploads = calls.filter(call => call.url.includes('uploads.github.com'));
  assert.equal(uploads.length, 4); assert.ok(uploads[3]?.url.includes('/2/assets?name=latest.json'));
}));

test('publication rejects transferred artifact corruption before any mutation', async () => fixture(async (_dir, input) => {
  const prepared = await prepareRelease(input); await writeFile(input.dmg, 'corrupt dmg');
  const methods: string[] = [];
  await assert.rejects(publishRelease(prepared, '', async (_url, init) => { methods.push(init?.method ?? 'GET'); return new Response('{}', { status: 404 }); }));
  assert.ok(methods.every(method => method === 'GET'));
}));
test('stable metadata cannot move backwards or accept unstable versions', async () => fixture(async (_dir, input) => {
  const prepared = await prepareRelease(input);
  for (const version of ['0.2.0', '0.3.0', '0.2.0-beta']) {
    const methods: string[] = [];
    await assert.rejects(publishRelease(prepared, '', async (url, init) => {
      const path = String(url); methods.push(init?.method ?? 'GET');
      if (path === 'https://github.com/Nortus222/claude-config/releases/download/desktop-stable-channel/latest.json') return new Response(JSON.stringify({ version }));
      if (path.includes('desktop-stable-channel')) return new Response(JSON.stringify({ id: 2, draft: false, prerelease: false, assets: [{ id: 9, name: 'latest.json' }] }));
      return new Response('{}', { status: 404 });
    }));
    assert.ok(methods.every(method => method === 'GET'));
  }
}));
