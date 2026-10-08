import { Effect } from 'effect';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import * as api from '../../src/index.ts';
import { fakeGitHub } from './fake-github.ts';
import type { Store } from '../../src/store.ts';
import type { ServiceOptions } from '../../src/service.ts';

export type FixtureOptions = { store?: Store['Service']; clock?: { now: number }; openSignup?: boolean; allowlistedLogins?: readonly string[]; pollAfter?: number; diagnostic?: ServiceOptions['diagnostic']; metadata?: ServiceOptions['metadata'] };

export async function fixture(options: FixtureOptions = {}) {
  if (!('makeService' in api)) throw new Error('makeService must be exported');
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 7) };
  const diagnostics: unknown[] = [];
  const github = fakeGitHub();
  let store = options.store ?? api.makeMemoryStore();
  const makeHandler = () => Effect.runPromise(api.makeService({ now: () => clock.now,
    config: { openSignup: options.openSignup ?? true, allowlistedLogins: options.allowlistedLogins ?? [], pollAfter: options.pollAfter ?? 900 },
    diagnostic: (entry) => { diagnostics.push(entry); options.diagnostic?.(entry); }, ...(options.metadata ? { metadata: options.metadata } : {}),
  }).pipe(Effect.provideService(api.Store, store), Effect.provideService(api.GitHub, github.service)));
  const makeServer = async () => {
    const server = api.createServiceServer(await makeHandler());
    // A retained port must not let fetch reuse an idle connection from the previous listener.
    server.prependListener('request', (_request, response) => response.setHeader('connection', 'close'));
    return server;
  };
  let server = await makeServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: unknown, token?: string) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = (body: Buffer, path = '/v1/auth/device/start', method = 'POST', headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) => {
      let text = ''; response.on('data', (chunk) => text += chunk); response.on('end', () => resolve({ status: response.statusCode!, body: text }));
    }); request.on('error', reject); request.end(body);
  });
  const start = async (name = 'Machine') => { const response = await call('POST', '/v1/auth/device/start', { name, os: 'linux', agents: ['codex'] }); return { response, body: await response.json() }; };
  const login = async (name = 'Machine') => { const pending = await start(name); clock.now += 5000; const response = await call('POST', '/v1/auth/device/poll', { pendingId: pending.body.pendingId }); return { response, body: await response.json() }; };
  const close = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
  });
  const restart = async (nextStore: Store['Service']) => {
    await close();
    store = nextStore;
    server = await makeServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  };
  return { clock, diagnostics, github, get store() { return store; }, call, raw, start, login, restart, close };
}
