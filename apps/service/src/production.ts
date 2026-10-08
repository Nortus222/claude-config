import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { CosmosClient, CosmosClientOptions } from '@azure/cosmos';
import type { RuntimeConfig } from './config.ts';
import { makeCosmosStore, validateCosmosConfiguration } from './cosmos-store.ts';
import { makeGitHub } from './github-http.ts';

type TokenCredential = NonNullable<CosmosClientOptions['aadCredentials']>;
type GetTokenOptions = Parameters<TokenCredential['getToken']>[1];

export interface ProductionFactories {
  readonly credential: (options?: { readonly clientId: string }) => TokenCredential;
  readonly client: (options: CosmosClientOptions) => CosmosClient;
  readonly agent?: () => NonNullable<CosmosClientOptions['agent']>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}
/** Own a single identity, client and HTTP agent. Resource constructors are always explicit. */
export function makeProductionResources(config: RuntimeConfig, factories: ProductionFactories) {
  let agent: NonNullable<CosmosClientOptions['agent']> | undefined;
  const lifetime = new AbortController();
  let client: CosmosClient | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true; lifetime.abort();
    try { client?.dispose(); } finally { agent?.destroy(); }
  };
  try {
    agent = factories.agent?.() ?? (config.cosmosEndpoint.startsWith('http:') ? new HttpAgent({ keepAlive: true }) : new HttpsAgent({ keepAlive: true }));
    const credential = config.localEmulator ? undefined : factories.credential(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : undefined);
    const boundedCredential: TokenCredential | undefined = credential && {
      getToken: (scopes, options?: GetTokenOptions) => new Promise((resolve, reject) => {
        const controller = new AbortController();
        const failed = () => { controller.abort(); finish(); reject(new Error('Credential acquisition failed.')); };
        const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', failed); options?.abortSignal?.removeEventListener('abort', failed); };
        const timer = setTimeout(failed, 10000);
        lifetime.signal.addEventListener('abort', failed, { once: true }); options?.abortSignal?.addEventListener('abort', failed, { once: true });
        if (lifetime.signal.aborted || options?.abortSignal?.aborted) { failed(); return; }
        Promise.resolve().then(() => { if (controller.signal.aborted) throw new Error(); return credential.getToken(scopes, { ...options, abortSignal: controller.signal }); }).then(
          (token) => { finish(); resolve(token); }, failed,
        );
      }),
    };
    client = factories.client({ endpoint: config.cosmosEndpoint, ...(config.localEmulator ? { key: config.emulatorKey! } : { aadCredentials: boundedCredential! }),
      agent, consistencyLevel: 'Strong', connectionPolicy: { requestTimeout: 10000, enableEndpointDiscovery: false,
        enableBackgroundEndpointRefreshing: false, useMultipleWriteLocations: false, retryOptions: { maxRetryAttemptCount: 0, maxWaitTimeInSeconds: 0 } } });
    const database = client.database(config.cosmosDatabase);
    return { store: makeCosmosStore({ database, now: factories.now }), github: makeGitHub({ clientId: config.githubClientId, fetch: factories.fetch, now: factories.now }),
      validate: () => validateCosmosConfiguration(database, { localEmulator: config.localEmulator }), dispose };
  } catch {
    // Constructor errors may contain connection details; only a constant failure escapes.
    void dispose().catch(() => {});
    throw new Error('Service resource creation failed.');
  }
}
