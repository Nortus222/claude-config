import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Fiber } from 'effect';
import { HostedFailure, HostedTransport, httpTransport } from '../src/index.ts';

const request = (base: string, fetch: typeof globalThis.fetch, options: { timeoutMs?: number } = {}) =>
  (input: Parameters<typeof HostedTransport.Service.request>[0]) =>
    Effect.runPromise(HostedTransport.use((transport) => transport.request(input)).pipe(Effect.provide(httpTransport(base, { fetch, ...options }))));
const failure = (code: string) => (error: unknown) => error instanceof HostedFailure && error.code === code
  && !JSON.stringify(error).includes('private-token') && !String(error).includes('private-token');
const fake = (body: unknown, status = 200, headers?: HeadersInit): typeof fetch => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

test('sends JSON, bearer token and ETag beneath an explicit HTTPS service root', async () => {
  let sent: RequestInit | undefined;
  let url = '';
  const run = request('https://service.example/v1', async (input, init) => {
    url = String(input); sent = init;
    return new Response('{"ok":true}', { headers: { ETag: '"seq-1"' } });
  });
  assert.deepEqual(await run({ method: 'POST', path: '/decisions', token: 'private-token', body: { a: 'é' }, etag: '"seq-0"' }),
    { status: 200, body: { ok: true }, etag: '"seq-1"' });
  assert.equal(url, 'https://service.example/v1/decisions');
  assert.equal(sent?.redirect, 'manual');
  assert.equal(sent?.credentials, 'omit');
  assert.equal(new Headers(sent?.headers).get('authorization'), 'Bearer private-token');
  assert.equal(new Headers(sent?.headers).get('if-none-match'), '"seq-0"');
  assert.equal(sent?.body, '{"a":"é"}');
});

for (const base of ['http://service.example', 'https://user:private-token@service.example', 'https://service.example/#fragment', 'https://service.example/?secret=private-token']) {
  test(`refuses unsafe service URL ${base.replace('private-token', 'redacted')}`, async () => {
    await assert.rejects(request(base, fake({}))({ method: 'GET', path: '/sync' }), failure('invalid_url'));
  });
}
for (const path of ['//evil.example/sync', 'https://evil.example', '/../escape', '/%2e%2e/escape', '/sync#fragment', '/\\evil.example']) {
  test(`refuses unsafe request path ${path}`, async () => {
    await assert.rejects(request('https://service.example/v1', fake({}))({ method: 'GET', path }), failure('invalid_request'));
  });
}
for (const status of [301, 302, 303, 307, 308]) {
  test(`refuses HTTP ${status} without following Location`, async () => {
    await assert.rejects(request('https://service.example', fake(undefined, status, { Location: 'https://evil.example' }))({ method: 'GET', path: '/sync', token: 'private-token' }), failure('redirect'));
  });
}
for (const status of [204, 304]) {
  test(`HTTP ${status} succeeds without trying to read JSON`, async () => {
    assert.deepEqual(await request('https://service.example', fake(undefined, status, { ETag: '"1"', 'Retry-After': '10' }))({ method: 'GET', path: '/sync' }),
      { status, etag: '"1"', retryAfter: 10 });
  });
}
test('network and malformed JSON failures discard diagnostics', async () => {
  await assert.rejects(request('https://service.example', async () => { throw new Error('private-token in request'); })({ method: 'GET', path: '/sync' }), failure('network'));
  await assert.rejects(request('https://service.example', async () => new Response('private-token'))({ method: 'GET', path: '/sync' }), failure('invalid_response'));
});
test('strict error decoding preserves safe status/code/retryAfter and discards message', async () => {
  await assert.rejects(request('https://service.example', fake({ error: 'rate_limited', message: 'private-token' }, 429, { 'Retry-After': '12' }))({ method: 'GET', path: '/sync' }),
    (error: unknown) => failure('rate_limited')(error) && (error as HostedFailure).status === 429 && (error as HostedFailure).retryAfter === 12);
  await assert.rejects(request('https://service.example', fake({ error: 'unauthenticated', message: 'private-token', extra: {} }, 401))({ method: 'GET', path: '/sync' }), failure('invalid_response'));
  await assert.rejects(request('https://service.example', fake({ error: 'unauthenticated', message: 'private-token' }, 500))({ method: 'GET', path: '/sync' }), failure('invalid_response'));
});
test('rejects oversized UTF-8 request body before network access', async () => {
  await assert.rejects(request('https://service.example', async () => { assert.fail('must not fetch'); })({ method: 'PUT', path: '/decisions', body: { text: 'é'.repeat(65536) } }), failure('payload_too_large'));
});
test('timeout aborts fetch and returns a generic failure even if fetch never settles', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(request('https://service.example', async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }, { timeoutMs: 10 })({ method: 'GET', path: '/sync' }), failure('timeout'));
  assert.equal(signal?.aborted, true);
});
test('fiber interruption aborts the pending fetch and clears its timeout', async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  let signal: AbortSignal | undefined;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const layer = httpTransport('https://service.example', { fetch: async (_url, init) => {
    signal = init?.signal ?? undefined; ready();
    return new Promise<Response>(() => {});
  } });
  const fiber = Effect.runFork(HostedTransport.use((transport) => transport.request({ method: 'GET', path: '/sync' })).pipe(Effect.provide(layer)));
  await started;
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(signal?.aborted, true);
  assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === timers.mock.calls[0]?.result));
});

test('refuses duplicate query keys before sending a request', async () => {
  await assert.rejects(request('https://service.example', async () => { assert.fail('must not fetch'); })({ method: 'GET', path: '/sync?since=1&since=2' }), failure('invalid_request'));
});
test('HTTP-date Retry-After becomes a safe delay in seconds', async () => {
  const date = new Date(Date.now() + 120_000).toUTCString();
  const result = await request('https://service.example', fake(undefined, 304, { 'Retry-After': date }))({ method: 'GET', path: '/sync' });
  assert.ok(result.retryAfter !== undefined && result.retryAfter >= 119 && result.retryAfter <= 120);
});

test('refuses a fetch adapter that reports a followed redirect even for 204', async () => {
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, 'redirected', { value: true });
  await assert.rejects(request('https://service.example', async () => response)({ method: 'GET', path: '/sync' }), failure('redirect'));
});
test('timeout remains timeout when fetch rejects immediately on abort', async () => {
  await assert.rejects(request('https://service.example', async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('private-token')), { once: true });
  }), { timeoutMs: 10 })({ method: 'GET', path: '/sync' }), failure('timeout'));
});
