import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect } from 'effect';
import { createCosmosFixture } from './support/cosmos.ts';
import { removeOwnedImageContainer, withOwnedImageContainer } from './support/image.ts';
import type { DeviceSessionDocument } from '../src/documents.ts';

const image = process.env.NORTUSCC_SERVICE_IMAGE;
const execute = promisify(execFile);
const docker = async (...args: string[]) => (await execute('docker', args, { timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim();
const isolated = ['--platform', 'linux/amd64', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=0.25', '--memory=512m', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-e', 'HOME=/tmp/home'];
const envArgs = (env: Record<string, string>) => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const production = { NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'image_fixture', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://example.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata' };

test('actual image contains only hosted production sources and dependencies and runs non-root Node 24', { skip: !image }, async () => {
  const inspected = JSON.parse(await docker('image', 'inspect', image!))[0];
  assert.equal(inspected.Architecture, 'amd64'); assert.equal(inspected.Os, 'linux');
  assert.equal(inspected.Config.User, 'node');
  assert.deepEqual(inspected.Config.Entrypoint, ['node', 'apps/service/src/main.ts']);
  const result = await withOwnedImageContainer(docker, name => docker('run', '--rm', '--name', name, ...isolated, '--network=none', '--entrypoint=node', image!, '-e', `
    const fs = require('node:fs');
    console.log(JSON.stringify({ uid: process.getuid(), version: process.version,
      apps: fs.readdirSync('/app/apps'), packages: fs.readdirSync('/app/packages'),
      service: fs.readdirSync('/app/apps/service'), protocol: fs.readdirSync('/app/packages/hosted-protocol'),
      workspaces: fs.readdirSync('/app/node_modules/@nortuscc'),
      dev: ['typescript', '@types/node'].filter(p => fs.existsSync('/app/node_modules/' + p)),
      dependency: require.resolve('@azure/cosmos'),
      extra: ['.git', '.claude', 'claude', 'codex', 'docs', 'test', 'package-lock.json'].filter(p => fs.existsSync('/app/' + p)) }));`));
  const value = JSON.parse(result);
  assert.notEqual(value.uid, 0); assert.match(value.version, /^v24\./);
  assert.deepEqual(value.apps, ['service']); assert.deepEqual(value.packages, ['hosted-protocol']);
  assert.deepEqual(value.service.sort(), ['package.json', 'src']); assert.deepEqual(value.protocol.sort(), ['package.json', 'src']);
  assert.deepEqual(value.workspaces.sort(), ['hosted-protocol', 'service']); assert.deepEqual(value.dev, []); assert.deepEqual(value.extra, []);
});

test('actual production image rejects federation, emulator keys and unknown settings with constant redacted logs', { skip: !image }, async () => {
  for (const invalid of [{ AZURE_FEDERATED_TOKEN_FILE: '/private/IMAGE_PRIVATE_TOKEN' }, { NORTUSCC_SERVICE_EMULATOR_KEY: 'IMAGE_PRIVATE_KEY' }, { NORTUSCC_SERVICE_UNKNOWN: 'IMAGE_PRIVATE_VALUE' }] as Record<string, string>[]) {
    try { await withOwnedImageContainer(docker, name => docker('run', '--rm', '--name', name, ...isolated, '--network=none', ...envArgs({ ...production, ...invalid }), image!)); assert.fail('invalid configuration started'); }
    catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(failure.code, 1); assert.equal(failure.stdout, '');
      assert.equal(failure.stderr.trim(), 'startup_failed');
    }
  }
});

test('actual PID1 startup recovers bound claims before readiness, recovers after a stopped gap and exits on SIGTERM', { skip: !image, timeout: 180000 }, async (t) => {
  const emulator = process.env.NORTUSCC_SERVICE_IMAGE_EMULATOR_CONTAINER;
  assert.ok(emulator && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(emulator), 'explicit owned emulator container is required');
  const origin = process.env.NORTUSCC_SERVICE_IMAGE_ORIGIN;
  assert.ok(origin && /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(origin), 'explicit loopback service origin is required');
  const backend = await createCosmosFixture();
  const name = `nortuscc-image-${randomUUID()}`;
  t.after(() => removeOwnedImageContainer(docker, name).then(backend.dispose));
  const seed = async (suffix: string, expiresIn = -60000) => {
    const now = Date.now(); const key = `device:image-${suffix}`; const accountId = `image-${suffix}`; const machineId = `orphan-${suffix}`;
    const session: DeviceSessionDocument = { type: 'deviceSession', version: 1, id: key, pendingId: `image-${suffix}`, deviceCode: 'IMAGE_PRIVATE_DEVICE',
      description: { name: 'Image fixture', os: 'linux', agents: ['codex'] }, createdAt: now - 120000, expiresAt: now + expiresIn, interval: 5, nextPollAt: now - 60000,
      state: 'claimed', claim: { claimId: 'image-claim', accountId, machineId, tokenHash: 'IMAGE_PRIVATE_HASH', claimedAt: now - 90000 } };
    assert.equal(await Effect.runPromise(backend.store.commitPartition('identities', key, null, [{ type: 'upsert', document: session }])), true);
    assert.equal(await Effect.runPromise(backend.store.commitPartition('accounts', accountId, null, [
      { type: 'upsert', document: { type: 'account', version: 1, id: 'account', accountId, githubId: 1, login: 'image-fixture', seq: 0, defaultPolicy: 'notify', createdAt: new Date(now).toISOString(), state: 'active', setups: [] } },
      { type: 'upsert', document: { type: 'machine', version: 1, id: `machine:${machineId}`, accountId, machineId, tokenHash: 'IMAGE_PRIVATE_HASH', name: 'Orphan', os: 'linux', agents: ['codex'], policy: 'notify', reportStatus: false, createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString() } },
      { type: 'upsert', document: { type: 'deviceReservation', version: 1, id: key, accountId, sessionId: key } },
    ])), true);
    const raw = await backend.database.container('identities').item(key, key).read(); assert.equal(raw.resource?.ttl, -1);
    return async () => {
      assert.equal((await backend.database.container('identities').item(key, key).read()).statusCode, 404);
      const account = await Effect.runPromise(backend.store.readPartition('accounts', accountId));
      assert.ok(account.documents.some(d => d.type === 'issuanceFence' && d.machineId === machineId));
      assert.ok(!account.documents.some(d => d.type === 'deviceReservation' || d.type === 'machine'));
    };
  };
  const recovered = await seed('startup');
  await docker('run', '-d', '--name', name, ...isolated, '--network', `container:${emulator}`, ...envArgs({
    ...production, NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'http://127.0.0.1:8081/', NORTUSCC_SERVICE_COSMOS_DATABASE: backend.database.id,
    NORTUSCC_SERVICE_LOCAL_EMULATOR: 'true', NORTUSCC_SERVICE_EMULATOR_KEY: process.env.NORTUSCC_COSMOS_EMULATOR_KEY!,
    NORTUSCC_SERVICE_HOST: '0.0.0.0', NORTUSCC_SERVICE_PORT: '8090',
  }), image!);
  const ready = async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { const response: Response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) }); if (response.status === 200) { assert.deepEqual(await response.json(), { status: 'ok' }); return; } } catch {}
      await delay(200);
    }
    assert.fail('image did not become ready');
  };
  await ready(); await recovered();
  const pid = await docker('exec', name, 'node', '-e', "console.log(require('node:fs').readFileSync('/proc/1/cmdline', 'utf8'))");
  // Docker Desktop's amd64 emulation injects these Node flags on an arm64 host.
  assert.match(pid.replaceAll('\0', ' ').trim(), /^node(?: --no-opt -r \/proc\/\.reset)? apps\/service\/src\/main\.ts$/);
  assert.match(await docker('exec', name, 'node', '-e', "console.log(require('node:fs').readlinkSync('/proc/1/exe'))"), /^\/(?:usr\/local\/bin\/node|run\/rosetta\/rosetta)$/);
  for (const path of ['/v1/health', '/readyz']) {
    const response: Response = await fetch(`${origin}${path}`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' });
    assert.equal((await fetch(`${origin}${path}?extra=1`)).status, 400);
    assert.equal((await fetch(`${origin}${path}`, { method: 'POST' })).status, path === '/readyz' ? 400 : 401);
  }
  let stops = 0;
  const stop = async () => {
    const start = Date.now(); await docker('stop', '--time=15', name);
    assert.ok(Date.now() - start < 15000); assert.equal(await docker('inspect', '--format={{.State.ExitCode}}', name), '0');
    const logs = await execute('docker', ['logs', name]); assert.doesNotMatch(logs.stdout + logs.stderr, /IMAGE_PRIVATE|image-claim|tokenHash/);
    assert.equal(logs.stdout, '');
    assert.equal(logs.stderr.split('\n').filter(line => line === 'shutdown_succeeded').length, ++stops);
    assert.ok(logs.stderr.trim().split('\n').every(line => ['startup_succeeded', 'recovery_succeeded', 'shutdown_succeeded'].includes(line)));
    await assert.rejects(fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) }));
  };
  await stop();
  const recoveredAfterGap = await seed('stopped', 1000);
  await delay(1500);
  await docker('start', name); await ready(); await recoveredAfterGap(); await stop();
});
