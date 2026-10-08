import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServiceEnvironment } from '../src/config.ts';
const prefix = 'NORTUSCC_SERVICE_';
const base = { [`${prefix}GITHUB_CLIENT_ID`]: 'Iv1_abc123', [`${prefix}COSMOS_ENDPOINT`]: 'https://example.documents.azure.com/', [`${prefix}COSMOS_DATABASE`]: 'metadata' };
test('configuration defaults closed and ignores unrelated environment', () => {
  assert.deepEqual(parseServiceEnvironment({ ...base, HOME: '/inert', AZURE_CLIENT_SECRET: 'ignored' }), {
    githubClientId: 'Iv1_abc123', cosmosEndpoint: 'https://example.documents.azure.com/', cosmosDatabase: 'metadata',
    host: '127.0.0.1', port: 8080, openSignup: false, allowlistedLogins: [], pollAfter: 900,
    sweepIntervalSeconds: 60, sweepTimeoutSeconds: 60, shutdownGraceSeconds: 10, localEmulator: false,
  });
});
test('configuration fails closed on missing, unsafe, unknown and noncanonical values', () => {
  for (const [key, values] of Object.entries({
    GITHUB_CLIENT_ID: ['', ' id', 'a-b', 'x'.repeat(101)],
    COSMOS_ENDPOINT: ['http://remote', 'https://127.0.0.1', 'https://localhost', 'https://api.localhost./', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:127.255.255.255]/', 'https://user@remote', 'https://remote/db', 'https://remote?x', 'https://remote#x'],
    COSMOS_DATABASE: ['', '.', '../db', 'a/b', 'x'.repeat(101)],
    MANAGED_IDENTITY_CLIENT_ID: ['', 'not-uuid'], HOST: ['localhost', 'evil'], PORT: ['0', '65536', '+1', '01', '1.0', ' 1'],
    OPEN_SIGNUP: ['TRUE', '', '1'], ALLOWLIST: [' a', 'a,', '-a', 'a--b', 'a_a', 'a,a'],
    POLL_AFTER_SECONDS: ['0', '86401'], SWEEP_INTERVAL_SECONDS: ['0', '3601'], SWEEP_TIMEOUT_SECONDS: ['0', '301'], SHUTDOWN_GRACE_SECONDS: ['0', '61'],
    LOCAL_EMULATOR: ['yes'], EMULATOR_KEY: ['secret'], TYPO: ['anything'],
  })) for (const value of values) assert.throws(() => parseServiceEnvironment({ ...base, [`${prefix}${key}`]: value }), /Invalid service configuration/);
  for (const key of Object.keys(base)) { const env = { ...base }; delete env[key as keyof typeof env]; assert.throws(() => parseServiceEnvironment(env)); }
});
test('explicit managed identity and bounded policy values are accepted', () => {
  const config = parseServiceEnvironment({ ...base, [`${prefix}MANAGED_IDENTITY_CLIENT_ID`]: '00000000-0000-4000-8000-000000000001', [`${prefix}HOST`]: '::1', [`${prefix}OPEN_SIGNUP`]: 'true', [`${prefix}ALLOWLIST`]: 'Ihor,test-user', [`${prefix}PORT`]: '65535' });
  assert.equal(config.managedIdentityClientId, '00000000-0000-4000-8000-000000000001'); assert.deepEqual(config.allowlistedLogins, ['Ihor', 'test-user']); assert.equal(config.openSignup, true);
});
test('emulator mode only permits literal loopback roots, requires key and rejects managed identity', () => {
  for (const endpoint of ['http://127.0.0.1:18081/', 'https://[::1]:8081/']) {
    const config = parseServiceEnvironment({ ...base, [`${prefix}LOCAL_EMULATOR`]: 'true', [`${prefix}COSMOS_ENDPOINT`]: endpoint, [`${prefix}EMULATOR_KEY`]: 'dummy' }); assert.equal(config.localEmulator, true); assert.equal(config.emulatorKey, 'dummy');
  }
  for (const endpoint of ['http://localhost:8081/', 'http://127.1/', 'http://2130706433/', 'http://127.0.0.1.evil/', 'http://127.0.0.1/db', 'https://example.documents.azure.com/']) assert.throws(() => parseServiceEnvironment({ ...base, [`${prefix}LOCAL_EMULATOR`]: 'true', [`${prefix}COSMOS_ENDPOINT`]: endpoint, [`${prefix}EMULATOR_KEY`]: 'dummy' }));
  assert.throws(() => parseServiceEnvironment({ ...base, [`${prefix}LOCAL_EMULATOR`]: 'true', [`${prefix}COSMOS_ENDPOINT`]: 'http://127.0.0.1/' }));
  assert.throws(() => parseServiceEnvironment({ ...base, [`${prefix}LOCAL_EMULATOR`]: 'true', [`${prefix}COSMOS_ENDPOINT`]: 'http://127.0.0.1/', [`${prefix}EMULATOR_KEY`]: 'dummy', [`${prefix}MANAGED_IDENTITY_CLIENT_ID`]: '00000000-0000-4000-8000-000000000001' }));
});

test('production rejects unsupported workload federation before resource discovery, while explicit emulator ignores it', () => {
  for (const file of ['', '/inert/federated-token']) assert.throws(() => parseServiceEnvironment({ ...base, AZURE_FEDERATED_TOKEN_FILE: file }), /Invalid service configuration/);
  const local = parseServiceEnvironment({ ...base, [`${prefix}LOCAL_EMULATOR`]: 'true', [`${prefix}COSMOS_ENDPOINT`]: 'http://127.0.0.1:18081/', [`${prefix}EMULATOR_KEY`]: 'dummy', AZURE_FEDERATED_TOKEN_FILE: '/inert/federated-token' });
  assert.equal(local.localEmulator, true); assert.equal(local.emulatorKey, 'dummy'); assert.equal(local.managedIdentityClientId, undefined);
  assert.equal(parseServiceEnvironment({ ...base, AZURE_TENANT_ID: 'ignored' }).openSignup, false);
});
