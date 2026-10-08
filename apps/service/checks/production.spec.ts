import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { CosmosClient, CosmosClientOptions } from '@azure/cosmos';
import { createDefaultHttpClient, createPipelineRequest, type HttpClient } from '@azure/core-rest-pipeline';
import { makeProductionResources } from '../src/production.ts';
import { parseServiceEnvironment } from '../src/config.ts';
type TokenCredential = NonNullable<CosmosClientOptions['aadCredentials']>;
const config = parseServiceEnvironment({ NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'client', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://example.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata' });
const forbiddenTransport: HttpClient = { sendRequest: async () => { throw new Error('No identity network'); } };
const forbiddenFetch: typeof fetch = async () => { throw new Error('No network'); };
test('production selects exactly one managed identity and owns deterministic Cosmos options and disposal', async () => {
  for (const managedIdentityClientId of [undefined, '00000000-0000-4000-8000-000000000001']) {
    let identities = 0, clients = 0, disposed = 0, destroyed = 0; let captured: CosmosClientOptions | undefined;
    const resources = makeProductionResources({ ...config, ...(managedIdentityClientId ? { managedIdentityClientId } : {}) }, {
      credential: (options) => { identities++; assert.equal(options?.clientId, managedIdentityClientId); assert.ok(options?.httpClient); assert.deepEqual(options?.retryOptions, { maxRetries: 0 }); return { getToken: async () => { throw new Error('No credentials'); } }; },
      agent: () => ({ maxFreeSockets: 1, maxSockets: 2, sockets: {}, requests: {}, destroy: () => { destroyed++; } }),
      client: (options) => { clients++; captured = options; return { database: (id: string) => { assert.equal(id, 'metadata'); return {}; }, dispose: () => { disposed++; } } as unknown as CosmosClient; }, identityTransport: forbiddenTransport, fetch: forbiddenFetch, now: () => 123,
    });
    assert.equal(identities, 1); assert.equal(clients, 1); assert.equal(captured!.consistencyLevel, 'Strong'); assert.equal(captured!.key, undefined); assert.equal(captured!.connectionString, undefined);
    assert.deepEqual(captured!.connectionPolicy, { requestTimeout: 10000, enableEndpointDiscovery: false, enableBackgroundEndpointRefreshing: false, useMultipleWriteLocations: false, retryOptions: { maxRetryAttemptCount: 0, maxWaitTimeInSeconds: 0 } });
    assert.ok(captured!.aadCredentials); await resources.dispose(); await resources.dispose(); assert.equal(disposed, 1); assert.equal(destroyed, 1);
  }
});
test('emulator never constructs credential and construction failure destroys acquired agent', async () => {
  let destroyed = 0;
  const factories = { credential: (): TokenCredential => { throw new Error('credential discovery forbidden'); }, agent: () => ({ maxFreeSockets: 1, maxSockets: 2, sockets: {}, requests: {}, destroy: () => { destroyed++; } }), identityTransport: forbiddenTransport, fetch: forbiddenFetch, now: () => 0 };
  const local = { ...config, localEmulator: true, cosmosEndpoint: 'http://127.0.0.1:18081/', emulatorKey: 'dummy' };
  const resources = makeProductionResources(local, { ...factories, client: (options) => { assert.equal(options.aadCredentials, undefined); assert.equal(options.key, 'dummy'); return { database: () => ({}), dispose: () => {} } as unknown as CosmosClient; } });
  await resources.dispose(); assert.equal(destroyed, 1);
  assert.throws(() => makeProductionResources(config, { ...factories, credential: () => ({ getToken: async () => null }), client: () => { throw new Error('SDK construction'); } })); assert.equal(destroyed, 2);
  assert.throws(() => makeProductionResources(config, { ...factories, agent: () => { throw new Error('private agent details'); }, client: () => { throw new Error(); } }), /^Error: Service resource creation failed\.$/);
});
test('credential forwards scopes/options, aborts on caller cancellation and ten second timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captured: CosmosClientOptions | undefined; const signals: AbortSignal[] = [];
  const resources = makeProductionResources(config, {
    credential: () => ({ getToken: (scopes, options) => { assert.deepEqual(scopes, ['scope']); assert.equal(options?.tenantId, 'tenant'); signals.push(options!.abortSignal as AbortSignal); return new Promise((_, reject) => { options!.abortSignal!.addEventListener('abort', () => reject(new Error('cancelled'))); }); } }),
    client: (options) => { captured = options; return { database: () => ({}), dispose: () => {} } as unknown as CosmosClient; }, identityTransport: forbiddenTransport, fetch: forbiddenFetch, now: () => 0,
  });
  const cancelled = new AbortController(); const first = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant', abortSignal: cancelled.signal });
  await Promise.resolve(); cancelled.abort(); await assert.rejects(first, /Credential acquisition failed/); assert.equal(signals[0].aborted, true);
  const timed = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant' }); await Promise.resolve(); t.mock.timers.tick(10000); await assert.rejects(timed, /Credential acquisition failed/); assert.equal(signals[1].aborted, true);
  const disposal = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant' }); await Promise.resolve(); await resources.dispose(); await assert.rejects(disposal, /Credential acquisition failed/); assert.equal(signals[2].aborted, true);
});

for (const cancellation of ['timeout', 'caller', 'dispose', 'dispose-failure'] as const) test(`identity transport ${cancellation} aborts physical work, blocks later retries and joins disposal`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captured: CosmosClientOptions | undefined; let started = 0; let aborted = false; let release!: () => void; let retryAttempts = 0;
  const request = () => createPipelineRequest({ url: 'http://127.0.0.1:9/inert', method: 'GET', abortSignal: new AbortController().signal });
  const resources = makeProductionResources(config, {
    credential: (options) => ({ getToken: async () => {
      // Model the pinned MSAL path: getToken options are ignored and transport uses its own signal.
      try { await options!.httpClient!.sendRequest(request()); }
      catch { retryAttempts++; await options!.httpClient!.sendRequest(request()); }
      return null;
    } }),
    identityTransport: { sendRequest: (physical) => { started++; return new Promise((_, reject) => {
      physical.abortSignal!.addEventListener('abort', () => { aborted = true; });
      release = () => reject(new Error('physical request closed'));
    }); } },
    client: (options) => { captured = options; return { database: () => ({}), dispose: () => { if (cancellation === 'dispose-failure') throw new Error('private SDK disposal error'); } } as unknown as CosmosClient; }, fetch: forbiddenFetch, now: () => 0,
  });
  const caller = new AbortController();
  const acquiring = captured!.aadCredentials!.getToken('scope', { abortSignal: caller.signal });
  const rejected = assert.rejects(acquiring, /Credential acquisition failed/);
  for (let i = 0; i < 10 && !started; i++) await Promise.resolve();
  assert.equal(started, 1);
  let disposed = false;
  let disposal: Promise<void> | undefined;
  if (cancellation === 'timeout') t.mock.timers.tick(10000);
  else if (cancellation === 'caller') caller.abort();
  else disposal = resources.dispose();
  await rejected; assert.equal(aborted, true);
  disposal ??= resources.dispose();
  void disposal.then(() => { disposed = true; }, () => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false, 'disposal must join physical cleanup');
  release(); if (cancellation === 'dispose-failure') await assert.rejects(disposal, /Service resource disposal failed/); else await disposal; assert.equal(disposed, true); assert.equal(retryAttempts, 1); assert.equal(started, 1, 'late SDK retry must not reach physical transport');
  await assert.rejects(captured!.aadCredentials!.getToken('scope'), /Credential acquisition failed/); assert.equal(started, 1);
});

test('owned default identity transport aborts a stalled loopback socket and joins its closure', async () => {
  const server = createServer(); const sockets = new Set<Socket>(); let received = false; let captured: CosmosClientOptions | undefined;
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('request', () => { received = true; });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-identity`;
  const resources = makeProductionResources(config, {
    credential: (options) => ({ getToken: async () => { await options.httpClient!.sendRequest(createPipelineRequest({ url: endpoint, method: 'GET', allowInsecureConnection: true })); return null; } }),
    identityTransport: createDefaultHttpClient(),
    client: (options) => { captured = options; return { database: () => ({}), dispose: () => {} } as unknown as CosmosClient; }, fetch: forbiddenFetch, now: Date.now,
  });
  try {
    const caller = new AbortController(); const acquiring = captured!.aadCredentials!.getToken('scope', { abortSignal: caller.signal });
    const rejected = assert.rejects(acquiring, /Credential acquisition failed/);
    for (let i = 0; i < 200 && !received; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(received, true); caller.abort(); await rejected; await resources.dispose();
    for (let i = 0; i < 200 && sockets.size; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(sockets.size, 0);
  } finally { await resources.dispose(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
