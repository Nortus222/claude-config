import { registerHooks } from 'node:module';

const main = new URL('../../src/main.ts', import.meta.url).href;
const cosmos = import.meta.resolve('@azure/cosmos');
const pipeline = import.meta.resolve('@azure/core-rest-pipeline');
const inertCosmos = new URL('./inert-cosmos.mjs', import.meta.url).href;
const inertIdentity = new URL('./inert-identity.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === main && specifier === '@azure/cosmos') return { url: inertCosmos, shortCircuit: true };
    if (context.parentURL === main && specifier === '@azure/identity') return { url: inertIdentity, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === inertIdentity) return { format: 'module', shortCircuit: true,
      source: `export class ManagedIdentityCredential { constructor() { throw new Error('Credential construction forbidden.'); } }` };
    if (url === inertCosmos) return { format: 'module', shortCircuit: true, source: `
      import { CosmosClient as RealCosmosClient } from ${JSON.stringify(cosmos)};
      import { createHttpHeaders } from ${JSON.stringify(pipeline)};
      export class CosmosClient extends RealCosmosClient {
        constructor(options) {
          super({ ...options, httpClient: { sendRequest: async (request) => {
            process.stdout.write('inert_cosmos_request\\n');
            return { request, status: 400, headers: createHttpHeaders(),
              bodyAsText: JSON.stringify({ message: 'PRIVATE_UPSTREAM_BODY PRIVATE_CREDENTIAL' }) };
          } } });
        }
      }
    ` };
    return nextLoad(url, context);
  },
});
