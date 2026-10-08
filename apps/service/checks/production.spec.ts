import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CosmosClient, CosmosClientOptions } from '@azure/cosmos';
import { makeProductionResources } from '../src/production.ts';
import { parseServiceEnvironment } from '../src/config.ts';
type TokenCredential = NonNullable<CosmosClientOptions['aadCredentials']>;
const config = parseServiceEnvironment({ NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'client', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://example.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata' });
const forbiddenFetch: typeof fetch = async () => { throw new Error('No network'); };
test('production selects exactly one managed identity and owns deterministic Cosmos options and disposal', async () => {
  for (const managedIdentityClientId of [undefined, '00000000-0000-4000-8000-000000000001']) {
    let identities = 0, clients = 0, disposed = 0, destroyed = 0; let captured: CosmosClientOptions | undefined;
    const resources = makeProductionResources({ ...config, ...(managedIdentityClientId ? { managedIdentityClientId } : {}) }, {
      credential: (options) => { identities++; assert.deepEqual(options, managedIdentityClientId ? { clientId: managedIdentityClientId } : undefined); return { getToken: async () => { throw new Error('No credentials'); } }; },
      agent: () => ({ maxFreeSockets: 1, maxSockets: 2, sockets: {}, requests: {}, destroy: () => { destroyed++; } }),
      client: (options) => { clients++; captured = options; return { database: (id: string) => { assert.equal(id, 'metadata'); return {}; }, dispose: () => { disposed++; } } as unknown as CosmosClient; }, fetch: forbiddenFetch, now: () => 123,
    });
    assert.equal(identities, 1); assert.equal(clients, 1); assert.equal(captured!.consistencyLevel, 'Strong'); assert.equal(captured!.key, undefined); assert.equal(captured!.connectionString, undefined);
    assert.deepEqual(captured!.connectionPolicy, { requestTimeout: 10000, enableEndpointDiscovery: false, enableBackgroundEndpointRefreshing: false, useMultipleWriteLocations: false, retryOptions: { maxRetryAttemptCount: 0, maxWaitTimeInSeconds: 0 } });
    assert.ok(captured!.aadCredentials); await resources.dispose(); await resources.dispose(); assert.equal(disposed, 1); assert.equal(destroyed, 1);
  }
});
test('emulator never constructs credential and construction failure destroys acquired agent', async () => {
  let destroyed = 0;
  const factories = { credential: (): TokenCredential => { throw new Error('credential discovery forbidden'); }, agent: () => ({ maxFreeSockets: 1, maxSockets: 2, sockets: {}, requests: {}, destroy: () => { destroyed++; } }), fetch: forbiddenFetch, now: () => 0 };
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
    credential: () => ({ getToken: (scopes, options) => { assert.deepEqual(scopes, ['scope']); assert.equal(options?.tenantId, 'tenant'); signals.push(options!.abortSignal as AbortSignal); return new Promise(() => {}); } }),
    client: (options) => { captured = options; return { database: () => ({}), dispose: () => {} } as unknown as CosmosClient; }, fetch: forbiddenFetch, now: () => 0,
  });
  const cancelled = new AbortController(); const first = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant', abortSignal: cancelled.signal });
  await Promise.resolve(); cancelled.abort(); await assert.rejects(first, /Credential acquisition failed/); assert.equal(signals[0].aborted, true);
  const timed = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant' }); await Promise.resolve(); t.mock.timers.tick(10000); await assert.rejects(timed, /Credential acquisition failed/); assert.equal(signals[1].aborted, true);
  const disposal = captured!.aadCredentials!.getToken(['scope'], { tenantId: 'tenant' }); await Promise.resolve(); await resources.dispose(); await assert.rejects(disposal, /Credential acquisition failed/); assert.equal(signals[2].aborted, true);
});
