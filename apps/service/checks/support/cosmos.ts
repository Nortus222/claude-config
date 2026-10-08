import { randomUUID } from 'node:crypto';
import { Agent } from 'node:https';
import { CosmosClient, ConsistencyLevel } from '@azure/cosmos';
import { Effect } from 'effect';
import { makeCosmosStore, validateCosmosConfiguration, type CosmosStoreOptions } from '../../src/cosmos-store.ts';

export const emulatorConfigured = (): boolean => Boolean(process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT);

/** Fail closed before constructing a client: tests may access literal loopback endpoints only. */
export const requireEmulatorConfiguration = (): { endpoint: string; key: string } => {
  const value = process.env.NORTUSCC_COSMOS_EMULATOR_ENDPOINT;
  const key = process.env.NORTUSCC_COSMOS_EMULATOR_KEY;
  if (!value || !key) throw new Error('Local Cosmos emulator endpoint and key are required.');
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Cosmos tests require a literal loopback emulator endpoint.');
  }
  return { endpoint: endpoint.href, key };
};

export const createCosmosFixture = async (options: Omit<CosmosStoreOptions, 'database'> = {}) => {
  const config = requireEmulatorConfiguration();
  // Trust the local emulator certificate only; endpoint discovery cannot redirect to cloud hosts.
  const clients: Array<{ client: CosmosClient; agent: Agent }> = [];
  const openClient = () => {
    const agent = new Agent({ rejectUnauthorized: false });
    const client = new CosmosClient({ ...config, ...(config.endpoint.startsWith('https:') ? { agent } : {}), consistencyLevel: ConsistencyLevel.Strong,
      connectionPolicy: { enableEndpointDiscovery: false, requestTimeout: 15_000, retryOptions: { maxRetryAttemptCount: 0 } } });
    clients.push({ client, agent });
    return client;
  };
  const client = openClient();
  const id = `nortuscc-test-${randomUUID()}`;
  let owned = false;
  const database = client.database(id);
  const dispose = async () => {
    try { if (owned) { await database.delete(); owned = false; } }
    finally { for (const entry of clients) { entry.client.dispose(); entry.agent.destroy(); } }
  };
  try {
    await client.databases.create({ id });
    owned = true;
    for (const [name, path] of [['accounts', '/accountId'], ['setups', '/setupId'], ['identities', '/id']] as const) {
      await database.containers.create({ id: name, partitionKey: { paths: [path] }, ...(name === 'identities' ? { defaultTtl: -1 } : {}) });
    }
    // The local emulator advertises Eventual. This local exemption is not cloud consistency evidence.
    await Effect.runPromise(validateCosmosConfiguration(database, { localEmulator: true }));
    const restart = () => makeCosmosStore({ ...options, database: openClient().database(id) });
    return { database, store: makeCosmosStore({ ...options, database }), restart, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};
