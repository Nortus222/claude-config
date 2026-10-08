import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Fiber } from 'effect';
import { makeGitHub } from '../src/index.ts';
import { ServiceFailure } from '../src/errors.ts';

const startBody = { device_code: 'PRIVATE_DEVICE', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });
const fixture = (responses: (Response | (() => Promise<Response>))[], timeoutMs?: number) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const clock = { now: 10000 };
  const transport: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init: init! });
    const response = responses.shift(); assert.ok(response, 'no automatic retry or unexpected upstream request');
    return typeof response === 'function' ? response() : response;
  };
  return { requests, clock, github: makeGitHub({ clientId: 'publicClient', fetch: transport, now: () => clock.now, ...(timeoutMs === undefined ? {} : { timeoutMs }) }) };
};
const unavailable = async <A>(effect: Effect.Effect<A, ServiceFailure>, retryAfter = 1) => {
  const result = await Effect.runPromise(effect.pipe(Effect.result));
  assert.equal(result._tag, 'Failure');
  if (result._tag !== 'Failure') return;
  assert.ok(result.failure instanceof ServiceFailure);
  assert.equal(result.failure.code, 'unavailable'); assert.equal(result.failure.retryAfter, retryAfter);
  assert.equal(result.failure.message, 'Request failed.');
  assert.doesNotMatch(JSON.stringify(result.failure), /PRIVATE|scope_secret|upstream|incorrect/);
};

test('production GitHub uses fixed endpoints, no scopes or secret and projects only verified fields', async () => {
  const f = fixture([json({ ...startBody, private: 'PRIVATE' }), json({ access_token: 'PRIVATE_TOKEN', token_type: 'bearer', scope: '', refresh_token: 'PRIVATE_REFRESH' }), json({ id: 42, login: 'Ihor', email: 'PRIVATE' })]);
  const device = await Effect.runPromise(f.github.requestDevice());
  assert.deepEqual(device, { deviceCode: 'PRIVATE_DEVICE', userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900, expiresAt: 910000 });
  const exchange = await Effect.runPromise(f.github.exchange(device.deviceCode));
  assert.deepEqual(exchange, { type: 'success', token: 'PRIVATE_TOKEN' });
  assert.deepEqual(await Effect.runPromise(f.github.user('PRIVATE_TOKEN')), { id: 42, login: 'Ihor' });
  assert.deepEqual(f.requests.map((r) => r.url), ['https://github.com/login/device/code', 'https://github.com/login/oauth/access_token', 'https://api.github.com/user']);
  assert.equal(f.requests[0].init.method, 'POST'); assert.equal(f.requests[1].init.method, 'POST'); assert.equal(f.requests[2].init.method, 'GET');
  assert.equal(String(f.requests[0].init.body), 'client_id=publicClient');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(f.requests[1].init.body))), { client_id: 'publicClient', device_code: 'PRIVATE_DEVICE', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  for (const { init } of f.requests) { assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal); assert.doesNotMatch(String(init.body), /scope|client_secret/); }
  const deviceHeaders = new Headers(f.requests[0].init.headers);
  assert.equal(deviceHeaders.get('accept'), 'application/json'); assert.equal(deviceHeaders.get('content-type'), 'application/x-www-form-urlencoded');
  const headers = new Headers(f.requests[2].init.headers);
  assert.equal(headers.get('authorization'), 'Bearer PRIVATE_TOKEN'); assert.equal(headers.get('accept'), 'application/vnd.github+json');
  assert.equal(headers.get('x-github-api-version'), '2026-03-10'); assert.equal(headers.get('user-agent'), 'nortuscc-hosted-service');
});
for (const [error, expected] of [['authorization_pending', 'pending'], ['slow_down', 'slow-down'], ['expired_token', 'expired'], ['token_expired', 'expired'], ['access_denied', 'denied']] as const) {
  test(`GitHub OAuth ${error} preserves the internal outcome`, async () => {
    const f = fixture([json({ error, error_description: 'PRIVATE' })]);
    assert.deepEqual(await Effect.runPromise(f.github.exchange('PRIVATE_DEVICE')), { type: expected });
  });
}
test('GitHub slow_down carries a larger interval', async () => {
  const f = fixture([json({ error: 'slow_down', interval: 20 })]);
  assert.deepEqual(await Effect.runPromise(f.github.exchange('PRIVATE_DEVICE')), { type: 'slow-down', interval: 20 });
});
for (const error of ['incorrect_device_code', 'incorrect_client_credentials', 'unsupported_grant_type', 'device_flow_disabled', 'unknown']) {
  test(`GitHub OAuth ${error} fails closed`, async () => { const f = fixture([json({ error, error_description: 'PRIVATE' })]); await unavailable(f.github.exchange('PRIVATE_DEVICE')); assert.equal(f.requests.length, 1); });
}
for (const status of [301, 302, 401, 403, 429, 500, 503]) {
  test(`GitHub HTTP ${status} is redacted with bounded retry`, async () => {
    const f = fixture([json({ message: 'PRIVATE' }, status)]);
    await unavailable(f.github.user('PRIVATE_TOKEN'), status === 403 || status === 429 ? 60 : 1);
  });
}
test('GitHub honors later primary reset and shares its bounded cooldown without retry', async () => {
  const f = fixture([json({ message: 'PRIVATE' }, 429, { 'retry-after': '20', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '200' }), json(startBody)]);
  await unavailable(f.github.user('PRIVATE_TOKEN'), 190);
  f.clock.now += 1000; await unavailable(f.github.requestDevice(), 189); assert.equal(f.requests.length, 1);
  f.clock.now = 200000; await Effect.runPromise(f.github.requestDevice()); assert.equal(f.requests.length, 2);
});
for (const [headers, delay] of [
  [{ 'retry-after': '20' }, 20], [{ 'retry-after': '999999999999999999999' }, 60],
  [{ 'retry-after': '7200' }, 3600], [{ 'retry-after': '-1' }, 60], [{ 'retry-after': 'bad' }, 60],
  [{ 'retry-after': 'Thu, 01 Jan 1970 00:01:10 GMT' }, 60],
  [{ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7210' }, 3600],
] as const) {
  test(`GitHub rate delay validates ${JSON.stringify(headers)}`, async () => { const f = fixture([json({}, 429, headers)]); await unavailable(f.github.user('PRIVATE_TOKEN'), delay); });
}
for (const bad of [{ ...startBody, device_code: '' }, { ...startBody, device_code: 'x'.repeat(2049) }, { ...startBody, interval: 0 }, { ...startBody, interval: 3601 }, { ...startBody, expires_in: 901 }, { ...startBody, expires_in: 1.5 }, { ...startBody, user_code: 'bad\nPRIVATE' }, { ...startBody, verification_uri: 'https://evil.test/login/device' }, null, []]) {
  test(`GitHub malformed device response fails closed ${JSON.stringify(bad).slice(0, 65)}`, async () => { const f = fixture([json(bad)]); await unavailable(f.github.requestDevice()); });
}
for (const bad of [{ access_token: 'PRIVATE', token_type: 'basic', scope: '' }, { access_token: 'PRIVATE', token_type: 'bearer', scope: 'scope_secret' }, { access_token: 'PRIVATE', token_type: 'bearer' }, { access_token: '', token_type: 'bearer', scope: '' }, { access_token: 'PRIVATE\n', token_type: 'bearer', scope: '' }, { error: 'slow_down', interval: 0 }, { error: 'slow_down', interval: 3601 }, { error: 'slow_down', interval: 1.5 }]) {
  test(`GitHub rejects unsafe credentials and intervals ${JSON.stringify(bad).slice(0, 60)}`, async () => { const f = fixture([json(bad)]); await unavailable(f.github.exchange('PRIVATE_DEVICE')); });
}
for (const user of [{ id: 0, login: 'Ihor' }, { id: 1.5, login: 'Ihor' }, { id: Number.MAX_SAFE_INTEGER + 1, login: 'Ihor' }, { id: 42, login: '-bad' }, { id: 42, login: 'bad--name' }, { id: 42, login: 'bad_name' }, { id: 42, login: 'a'.repeat(40) }, { id: 42, login: 'PRIVATE\n' }]) {
  test(`GitHub unsafe user identity is rejected ${JSON.stringify(user)}`, async () => { const f = fixture([json(user)]); await unavailable(f.github.user('PRIVATE_TOKEN')); });
}
test('request initiation fixes the absolute expiry even after slow transport', async () => {
  let now = 10000;
  const github = makeGitHub({ clientId: 'publicClient', now: () => now, fetch: async () => { now += 2500; return json({ ...startBody, expires_in: 12 }); } });
  assert.equal((await Effect.runPromise(github.requestDevice())).expiresAt, 22000);
});
test('transport failures and invalid JSON/UTF8 never expose their cause', async () => {
  for (const response of [() => Promise.reject(new Error('PRIVATE upstream')), new Response('PRIVATE not json'), new Response(new Uint8Array([0xc3, 0x28]))]) {
    const f = fixture([response]); await unavailable(f.github.requestDevice());
  }
});
test('oversized streaming response is cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; } });
  const f = fixture([new Response(body)]); await unavailable(f.github.requestDevice()); assert.equal(cancelled, true);
});
test('body timeout aborts transport and cancels stalled read', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const f = fixture([new Response(body)], 20); await unavailable(f.github.requestDevice());
  assert.equal(f.requests[0].init.signal!.aborted, true); assert.equal(cancelled, true);
});
test('transport timeout settles even if transport ignores cancellation', async () => {
  const f = fixture([() => new Promise<Response>(() => {})], 20); await unavailable(f.github.requestDevice()); assert.equal(f.requests[0].init.signal!.aborted, true);
});
test('Effect interruption aborts request and stalled body', async () => {
  let cancelled = false;
  const f = fixture([new Response(new ReadableStream({ cancel() { cancelled = true; } }))]);
  const fiber = Effect.runFork(f.github.requestDevice());
  while (!f.requests.length) await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Effect.runPromise(Fiber.interrupt(fiber));
  assert.equal(f.requests[0].init.signal!.aborted, true); assert.equal(cancelled, true);
});
test('unsafe input tokens and device codes fail without transport', async () => {
  const f = fixture([]); await unavailable(f.github.user('PRIVATE\n')); await unavailable(f.github.exchange('')); assert.equal(f.requests.length, 0);
});

test('late transport response is cancelled after a timed out request', async () => {
  let release!: (response: Response) => void;
  let cancelled = false;
  const f = fixture([() => new Promise<Response>((resolve) => { release = resolve; })], 20);
  await unavailable(f.github.requestDevice());
  release(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
test('a redirected success and an error-bearing user never verify identity', async () => {
  const redirected = json({ id: 42, login: 'Ihor' });
  Object.defineProperty(redirected, 'redirected', { value: true });
  for (const response of [redirected, json({ id: 42, login: 'Ihor', error: 'PRIVATE' })]) {
    const f = fixture([response]); await unavailable(f.github.user('PRIVATE_TOKEN'));
  }
});

test('public client IDs allow underscore without widening transport configuration', async () => {
  let received = '';
  const github = makeGitHub({ clientId: 'public_client', now: () => 10000, fetch: async (_url, init) => { received = String(init?.body); return json(startBody); } });
  await Effect.runPromise(github.requestDevice()); assert.equal(received, 'client_id=public_client');
});
test('malformed client IDs and timeout bounds fail before transport construction', () => {
  const transport: typeof fetch = async () => { assert.fail('no upstream call'); };
  for (const clientId of ['', 'x'.repeat(101), 'bad id', 'bad\nPRIVATE', 'https://github.com']) {
    assert.throws(() => makeGitHub({ clientId, now: () => 10000, fetch: transport }), (error) => error instanceof ServiceFailure && error.code === 'unavailable');
  }
  for (const timeoutMs of [0, -1, 1.5, 10001]) {
    assert.throws(() => makeGitHub({ clientId: 'publicClient', now: () => 10000, fetch: transport, timeoutMs }), (error) => error instanceof ServiceFailure && error.code === 'unavailable');
  }
});

for (const [name, response] of [
  ['OAuth application error', json({ error: 'incorrect_client_credentials', error_description: 'PRIVATE' }, 200, { 'retry-after': '20' })],
  ['scoped credential', json({ access_token: 'PRIVATE', token_type: 'bearer', scope: 'scope_secret' }, 200, { 'retry-after': '20' })],
  ['malformed JSON', new Response('PRIVATE invalid json', { headers: { 'retry-after': '20' } })],
  ['non-object JSON', json(null, 200, { 'retry-after': '20' })],
  ['invalid UTF8', new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'retry-after': '20' } })],
] as const) {
  test(`HTTP 200 ${name} preserves Retry-After without a throttle cooldown or retry`, async () => {
    const f = fixture([response, json(startBody)]);
    await unavailable(f.github.exchange('PRIVATE_DEVICE'), 20);
    assert.equal(f.requests.length, 1);
    await Effect.runPromise(f.github.requestDevice());
    assert.equal(f.requests.length, 2, 'non-throttle failure does not create cooldown');
  });
}
