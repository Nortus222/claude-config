import assert from 'node:assert/strict';
import { CosmosClient } from '@azure/cosmos';
import { Effect } from 'effect';
import { makeProductionResources } from '../../src/production.ts';
import { parseServiceEnvironment } from '../../src/config.ts';
import { startServiceRuntime, type RuntimeEvent } from '../../src/runtime.ts';
import { createCosmosFixture, requireEmulatorConfiguration } from './cosmos.ts';
import type { FixtureHosting } from './service.ts';
import type { fakeGitHub } from './fake-github.ts';

export type GitHubRequest = { readonly url: string; readonly method: string };
/** Record only public endpoint/method data; every OAuth response comes from the existing inert fake. */
const recordingGitHubFetch = (github: ReturnType<typeof fakeGitHub>, observations: GitHubRequest[]): typeof fetch => async (input, init) => {
  const url = String(input); const headers = new Headers(init?.headers);
  observations.push({ url, method: init?.method ?? 'GET' });
  assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
  assert.equal(headers.get('user-agent'), 'nortuscc-hosted-service');
  let body: unknown;
  if (url === 'https://api.github.com/user') {
    assert.equal(init?.method, 'GET'); assert.equal(headers.get('authorization'), `Bearer ${github.state.exchange.type === 'success' ? github.state.exchange.token : ''}`);
    assert.equal(headers.get('x-github-api-version'), '2026-03-10');
    body = await Effect.runPromise(github.service.user('PRIVATE_OAUTH_TOKEN'), { signal: init!.signal! });
  } else {
    assert.equal(init?.method, 'POST');
    const fields = new URLSearchParams(String(init?.body));
    assert.equal(fields.get('client_id'), 'local_runtime_test'); assert.equal(fields.has('scope'), false); assert.equal(fields.has('client_secret'), false);
    if (url === 'https://github.com/login/device/code') {
      assert.deepEqual([...fields.keys()], ['client_id']);
      const device = await Effect.runPromise(github.service.requestDevice(), { signal: init!.signal! });
      body = { device_code: device.deviceCode, user_code: device.userCode, verification_uri: device.verificationUri, interval: device.interval, expires_in: Math.min(900, device.expiresIn) };
    } else {
      assert.equal(url, 'https://github.com/login/oauth/access_token'); assert.equal(fields.get('device_code'), 'PRIVATE_DEVICE_CODE');
      assert.equal(fields.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      assert.deepEqual([...fields.keys()].sort(), ['client_id', 'device_code', 'grant_type']);
      const exchange = await Effect.runPromise(github.service.exchange('PRIVATE_DEVICE_CODE'), { signal: init!.signal! });
      body = exchange.type === 'success' ? { access_token: exchange.token, token_type: 'bearer', scope: '' }
        : { error: ({ pending: 'authorization_pending', 'slow-down': 'slow_down', expired: 'expired_token', denied: 'access_denied' } as const)[exchange.type], ...('interval' in exchange ? { interval: exchange.interval } : {}) };
    }
  }
  return Response.json(body);
};

/** Provision one unique local database; production resources and runtime own each serving SDK generation. */
export async function createRuntimeCosmosFixture({ now }: { now: () => number }) {
  const emulator = requireEmulatorConfiguration();
  const parsed = parseServiceEnvironment({ NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'local_runtime_test',
    NORTUSCC_SERVICE_COSMOS_ENDPOINT: emulator.endpoint, NORTUSCC_SERVICE_COSMOS_DATABASE: 'runtimefixture',
    NORTUSCC_SERVICE_LOCAL_EMULATOR: 'true', NORTUSCC_SERVICE_EMULATOR_KEY: emulator.key });
  const provision = await createCosmosFixture({ now, pageSize: 7 });
  const config = { ...parsed, cosmosDatabase: provision.database.id };
  const githubRequests: GitHubRequest[] = []; const events: RuntimeEvent[] = [];
  const entries: Array<{ resources: ReturnType<typeof makeProductionResources>; dispose: () => Promise<void> }> = [];
  let disposed = 0;
  const open = () => {
    let attachedGitHub: ReturnType<typeof fakeGitHub> | undefined;
    const resources = makeProductionResources(config, { now,
      credential: () => { throw new Error('Integration tests must never construct a credential.'); },
      identityTransport: { sendRequest: async () => { throw new Error('Emulator mode must not acquire identity.'); } },
      client: (options) => new CosmosClient(options),
      fetch: async (input, init) => {
        assert.ok(attachedGitHub, 'GitHub transport is attached before listening');
        return recordingGitHubFetch(attachedGitHub, githubRequests)(input, init);
      },
    });
    let disposal: Promise<void> | undefined;
    const entry = { resources, attach: (github: ReturnType<typeof fakeGitHub>) => { attachedGitHub = github; }, dispose: () => disposal ??= resources.dispose().then(() => { disposed++; }) };
    entries.push(entry); return entry;
  };
  let current: ReturnType<typeof open>;
  try { current = open(); } catch (error) { await provision.dispose(); throw error; }
  const hosting: FixtureHosting = async ({ store, clock, github, diagnostics, options, port }) => {
    const entry = current;
    entry.attach(github);
    const runtime = await startServiceRuntime({ config: { ...config, port, openSignup: options.openSignup ?? true,
      allowlistedLogins: options.allowlistedLogins ?? [], pollAfter: options.pollAfter ?? 900, sweepIntervalSeconds: 1, sweepTimeoutSeconds: 3 },
      store: { ...entry.resources.store, ...store }, github: entry.resources.github,
      now: () => clock.now, validate: entry.resources.validate, dispose: entry.dispose,
      diagnostic: (record) => { diagnostics.push(record); options.diagnostic?.(record); }, event: (event) => events.push(event),
    });
    // Prevent an idle fetch connection from surviving a same-port runtime replacement.
    runtime.server.prependListener('request', (_request, response) => response.setHeader('connection', 'close'));
    return { server: runtime.server, close: runtime.stop };
  };
  let disposal: Promise<void> | undefined;
  return { database: provision.database, store: current.resources.store, hosting, events, githubRequests,
    restart: () => { current = open(); return current.resources.store; },
    clientsCreated: () => entries.length, clientsDisposed: () => disposed,
    dispose: () => disposal ??= (async () => {
      try { await Promise.all(entries.map((entry) => entry.dispose())); }
      finally { await provision.dispose(); }
    })(),
  };
}
