import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { createServer, request as httpRequest } from 'node:http';
import { Effect } from 'effect';
import { startServiceRuntime } from '../src/runtime.ts';
import { parseServiceEnvironment } from '../src/config.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { ServiceFailure } from '../src/errors.ts';
import { fakeGitHub } from './support/fake-github.ts';
const config = { ...parseServiceEnvironment({ NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'client', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://example.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata' }), port: 0 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); } assert.fail('condition did not become true'); }
const options = () => ({ config, store: { ...makeMemoryStore(), sweepExpiredDevices: () => Effect.void }, github: fakeGitHub().service, validate: () => Effect.void, dispose: async () => {}, now: Date.now, diagnostic: () => {}, event: () => {} });
const url = (runtime: Awaited<ReturnType<typeof startServiceRuntime>>, path: string) => `http://127.0.0.1:${runtime.address.port}${path}`;
test('runtime validates then sweeps before serving strict readiness and unchanged storage-free v1 health', async () => {
  const order: string[] = []; let disposed = 0;
  const runtime = await startServiceRuntime({ ...options(), validate: () => Effect.sync(() => { order.push('validate'); }), store: { ...makeMemoryStore(), sweepExpiredDevices: () => Effect.sync(() => { order.push('sweep'); }) }, dispose: async () => { disposed++; } });
  try {
    assert.deepEqual(order, ['validate', 'sweep']);
    for (const path of ['/readyz', '/v1/health']) { const response = await fetch(url(runtime, path)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'ok' }); }
    for (const [method, path, body] of [['GET', '/readyz?x', undefined], ['POST', '/readyz', undefined], ['GET', '/readyz?', undefined], ['POST', '/readyz', '{}']] as const) assert.equal((await fetch(url(runtime, path), { method, ...(body ? { body } : {}) })).status, 400);
    const withBody = await new Promise<number>((resolve, reject) => { const request = httpRequest(url(runtime, '/readyz'), { method: 'GET', headers: { 'content-length': '2' } }, (response) => { response.resume(); response.once('end', () => resolve(response.statusCode!)); }); request.on('error', reject); request.end('{}'); });
    assert.equal(withBody, 400);
    assert.ok(runtime.server.headersTimeout > 0); assert.ok(runtime.server.requestTimeout > 0); assert.ok(runtime.server.keepAliveTimeout > 0);
  } finally { await runtime.stop(); await runtime.stop(); } assert.equal(disposed, 1);
});
test('validation, startup sweep failure, timeout, cancellation and bind failure dispose without a listener', async () => {
  for (const stage of ['validate', 'sweep', 'timeout', 'cancel'] as const) {
    let disposed = 0; let aborted = false; const signal = new AbortController();
    const stalled = () => Effect.promise((signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted = true; }); }));
    const start = startServiceRuntime({ ...options(), config: { ...config, sweepTimeoutSeconds: 0.02 }, signal: signal.signal,
      validate: stage === 'validate' ? () => Effect.fail(new ServiceFailure({ code: 'unavailable' })) : stage === 'cancel' ? stalled : () => Effect.void,
      store: { ...makeMemoryStore(), sweepExpiredDevices: stage === 'sweep' ? () => Effect.fail(new ServiceFailure({ code: 'unavailable' })) : stage === 'timeout' ? stalled : () => Effect.void }, dispose: async () => { disposed++; } });
    if (stage === 'cancel') setTimeout(() => signal.abort(), 5);
    await assert.rejects(start, /Service startup failed/); assert.equal(disposed, 1); if (stage === 'timeout' || stage === 'cancel') assert.equal(aborted, true);
  }
  const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  let disposed = 0;
  try { await assert.rejects(startServiceRuntime({ ...options(), config: { ...config, port: (occupied.address() as import('node:net').AddressInfo).port }, dispose: async () => { disposed++; } })); assert.equal(disposed, 1); }
  finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
});
test('serial periodic sweeps mark readiness unavailable after timeout/failure and restore it after success', async () => {
  let calls = 0; let active = 0; let maximum = 0; let fail = true; const events: string[] = [];
  const runtime = await startServiceRuntime({ ...options(), config: { ...config, sweepIntervalSeconds: 0.01, sweepTimeoutSeconds: 0.04 }, event: (event) => events.push(event),
    store: { ...makeMemoryStore(), sweepExpiredDevices: () => Effect.gen(function* () {
      calls++; active++; maximum = Math.max(maximum, active);
      if (calls === 1) return; yield* Effect.sleep(20); if (fail) return yield* Effect.fail(new ServiceFailure({ code: 'unavailable' }));
    }).pipe(Effect.ensuring(Effect.sync(() => { active--; }))) },
  });
  try {
    await until(() => events.includes('recovery_failed')); assert.equal((await fetch(url(runtime, '/readyz'))).status, 503); assert.equal((await fetch(url(runtime, '/v1/health'))).status, 200);
    fail = false; await until(() => events.includes('recovery_succeeded')); assert.equal((await fetch(url(runtime, '/readyz'))).status, 200); assert.equal(maximum, 1);
  } finally { await runtime.stop(); } assert.equal(active, 0);
});
test('stop aborts and joins a cancellable sweep, inflight handler and stalled upload before disposal exactly once', async () => {
  let sweeps = 0; let sweepAborted = false; let handlerAborted = false; let handlerStarted = false; let disposed = 0;
  const runtime = await startServiceRuntime({ ...options(), config: { ...config, sweepIntervalSeconds: 0.01, shutdownGraceSeconds: 0.02 },
    github: { ...fakeGitHub().service, requestDevice: () => Effect.promise((signal) => new Promise(() => { handlerStarted = true; signal.addEventListener('abort', () => { handlerAborted = true; }); })) },
    store: { ...makeMemoryStore(), sweepExpiredDevices: () => ++sweeps === 1 ? Effect.void : Effect.promise((signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { sweepAborted = true; }); })) },
    dispose: async () => { assert.equal(handlerAborted, true); assert.equal(sweepAborted, true); disposed++; },
  });
  const request = fetch(url(runtime, '/v1/auth/device/start'), { method: 'POST', body: JSON.stringify({ name: 'Machine', os: 'linux', agents: ['codex'] }) }).catch(() => undefined);
  const socket = createConnection(runtime.address.port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve)); socket.write('POST /v1/auth/device/start HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999\r\n\r\n{');
  await until(() => handlerStarted && sweeps > 1);
  await Promise.all([runtime.stop(), runtime.stop()]); await request; assert.equal(disposed, 1); assert.equal(runtime.server.listening, false); assert.equal(socket.destroyed, true);
});
test('stop drains a handler that finishes inside grace before disposing', async () => {
  let started = false; let release: (() => void) | undefined; let aborted = false;
  const runtime = await startServiceRuntime({ ...options(), github: { ...fakeGitHub().service, requestDevice: () => Effect.promise(async (signal) => { started = true; signal.addEventListener('abort', () => { aborted = true; }); await new Promise<void>((resolve) => { release = resolve; }); return { deviceCode: 'code', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900 }; }) } });
  const response = fetch(url(runtime, '/v1/auth/device/start'), { method: 'POST', body: JSON.stringify({ name: 'Machine', os: 'linux', agents: ['codex'] }) });
  await until(() => started); const stopping = runtime.stop(); release!(); assert.equal((await response).status, 200); await stopping; assert.equal(aborted, false);
});

test('periodic timeout retains failed readiness, cancels the old sweep and allows later serial recovery', async () => {
  let calls = 0; let aborted = 0; let release = false; const events: string[] = [];
  const runtime = await startServiceRuntime({ ...options(), config: { ...config, sweepIntervalSeconds: 0.01, sweepTimeoutSeconds: 0.02 }, event: (event) => events.push(event),
    store: { ...makeMemoryStore(), sweepExpiredDevices: () => ++calls === 1 || release ? Effect.void : Effect.promise((signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted++; }); })) },
  });
  try { await until(() => events.includes('recovery_failed')); assert.equal(aborted, 1); assert.equal((await fetch(url(runtime, '/readyz'))).status, 503); release = true;
    await until(() => events.includes('recovery_succeeded')); assert.equal((await fetch(url(runtime, '/readyz'))).status, 200); }
  finally { await runtime.stop(); }
});
test('stalled partial upload without handlers closes within grace and stop leaves no work', async () => {
  let disposed = 0;
  const runtime = await startServiceRuntime({ ...options(), config: { ...config, shutdownGraceSeconds: 0.02 }, dispose: async () => { disposed++; } });
  const socket = createConnection(runtime.address.port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise<void>((resolve) => socket.once('connect', resolve)); socket.write('POST /readyz HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n{');
  await delay(5); await runtime.stop(); assert.equal(disposed, 1); assert.equal(runtime.server.listening, false);
  await until(() => socket.destroyed); assert.equal(socket.destroyed, true);
});

test('listener startup deadline and pre-callback SIGTERM cancellation clean up without binding', async (t) => {
  const { Server } = await import('node:http');
  const listen = t.mock.method(Server.prototype, 'listen', function (this: import('node:http').Server) { return this; });
  for (const cancel of [false, true]) {
    const signal = new AbortController(); let disposed = 0;
    const starting = startServiceRuntime({ ...options(), config: { ...config, sweepTimeoutSeconds: 0.02 }, signal: signal.signal, dispose: async () => { disposed++; } });
    while (listen.mock.callCount() < (cancel ? 2 : 1)) await delay(1);
    if (cancel) signal.abort();
    await assert.rejects(starting, /Service startup failed/); assert.equal(disposed, 1);
  }
});
test('external abort after startup owns the same complete shutdown as stop', async () => {
  const signal = new AbortController(); let disposed = 0;
  const runtime = await startServiceRuntime({ ...options(), signal: signal.signal, dispose: async () => { disposed++; } });
  signal.abort(); await until(() => disposed === 1); await runtime.stop(); assert.equal(runtime.server.listening, false); assert.equal(disposed, 1);
});
