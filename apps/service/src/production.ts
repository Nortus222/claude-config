import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { Socket } from 'node:net';
import type { CosmosClient, CosmosClientOptions } from '@azure/cosmos';
import type { ManagedIdentityCredentialClientIdOptions } from '@azure/identity';
import type { HttpClient } from '@azure/core-rest-pipeline';
import type { RuntimeConfig } from './config.ts';
import { makeCosmosStore, validateCosmosConfiguration } from './cosmos-store.ts';
import { makeGitHub } from './github-http.ts';

type TokenCredential = NonNullable<CosmosClientOptions['aadCredentials']>;
type GetTokenOptions = Parameters<TokenCredential['getToken']>[1];
const credentialFailure = () => new Error('Credential acquisition failed.');

export interface ProductionFactories {
  readonly credential: (options: ManagedIdentityCredentialClientIdOptions) => TokenCredential;
  readonly client: (options: CosmosClientOptions) => CosmosClient;
  readonly agent?: () => NonNullable<CosmosClientOptions['agent']>;
  /** The transport must honor request cancellation and settle when its HTTP work ends. */
  readonly identityTransport: HttpClient;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}
const closeAgent = (agent: HttpAgent) => {
  const sockets = new Set<Socket>([...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].flat().filter((socket): socket is Socket => socket !== undefined));
  const closed = [...sockets].map((socket) => socket.closed ? Promise.resolve() : new Promise<void>((resolve) => socket.once('close', () => resolve())));
  agent.destroy();
  return Promise.all(closed);
};
/** Own one credential and the physical Cosmos and identity HTTP work behind it. */
export function makeProductionResources(config: RuntimeConfig, factories: ProductionFactories) {
  let agent: NonNullable<CosmosClientOptions['agent']> | undefined;
  const identityHttpAgent = new HttpAgent({ keepAlive: true });
  const identityHttpsAgent = new HttpsAgent({ keepAlive: true });
  const lifetime = new AbortController();
  const acquisition = new AsyncLocalStorage<AbortController>();
  const acquisitions = new Set<Promise<unknown>>();
  const transports = new Set<Promise<unknown>>();
  const track = <A>(promise: Promise<A>, owned: Set<Promise<unknown>>): Promise<A> => {
    owned.add(promise); void promise.then(() => owned.delete(promise), () => owned.delete(promise)); return promise;
  };
  let client: CosmosClient | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    lifetime.abort();
    const sockets = [closeAgent(identityHttpAgent), closeAgent(identityHttpsAgent)];
    let failed = false;
    try { client?.dispose(); } catch { failed = true; }
    try { agent?.destroy(); } catch { failed = true; }
    // Aborted acquisition contexts reject later retries before the transport can start them.
    await Promise.allSettled([...acquisitions, ...transports]);
    await Promise.all(sockets);
    acquisition.disable();
    if (failed) throw new Error('Service resource disposal failed.');
  })();
  const httpClient: HttpClient = { sendRequest: async (request) => {
    // Identity 4.13.3's MSAL path replaces getToken's signal. Carry ownership through its async calls.
    const context = acquisition.getStore();
    if (!context || context.signal.aborted || lifetime.signal.aborted) throw credentialFailure();
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true }); request.abortSignal?.addEventListener('abort', abort, { once: true });
    if (request.abortSignal?.aborted) controller.abort();
    try {
      controller.signal.throwIfAborted();
      return await track(Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return factories.identityTransport.sendRequest({ ...request, abortSignal: controller.signal,
          timeout: Math.min(request.timeout > 0 ? request.timeout : 10000, 10000), agent: new URL(request.url).protocol === 'http:' ? identityHttpAgent : identityHttpsAgent });
      }), transports);
    } catch { throw credentialFailure(); }
    finally { context.signal.removeEventListener('abort', abort); request.abortSignal?.removeEventListener('abort', abort); }
  } };
  try {
    agent = factories.agent?.() ?? (config.cosmosEndpoint.startsWith('http:') ? new HttpAgent({ keepAlive: true }) : new HttpsAgent({ keepAlive: true }));
    const credential = config.localEmulator ? undefined : factories.credential({ ...(config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {}), httpClient, retryOptions: { maxRetries: 0 } });
    const boundedCredential: TokenCredential | undefined = credential && {
      getToken: (scopes, options?: GetTokenOptions) => new Promise((resolve, reject) => {
        const controller = new AbortController();
        const failed = () => { controller.abort(); reject(credentialFailure()); };
        const finish = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', failed); options?.abortSignal?.removeEventListener('abort', failed); };
        const timer = setTimeout(failed, 10000);
        lifetime.signal.addEventListener('abort', failed, { once: true }); options?.abortSignal?.addEventListener('abort', failed, { once: true });
        if (lifetime.signal.aborted || options?.abortSignal?.aborted) { failed(); finish(); return; }
        const work = acquisition.run(controller, () => Promise.resolve().then(() => {
          controller.signal.throwIfAborted(); return credential.getToken(scopes, { ...options, abortSignal: controller.signal });
        }));
        track(work, acquisitions).then((token) => { finish(); resolve(token); }, () => { failed(); finish(); });
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
