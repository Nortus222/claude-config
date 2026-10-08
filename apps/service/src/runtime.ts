import type { Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect } from 'effect';
import type { RuntimeConfig } from './config.ts';
import type { CosmosStore } from './cosmos-store.ts';
import { GitHub } from './github.ts';
import { Store } from './store.ts';
import { makeService } from './service.ts';
import { createServiceServer, type RequestOwner } from './http.ts';
import type { DiagnosticSink } from './diagnostics.ts';
import { ServiceFailure } from './errors.ts';

export type RuntimeEvent = 'startup_succeeded' | 'startup_failed' | 'recovery_failed' | 'recovery_succeeded' | 'shutdown_succeeded' | 'shutdown_failed';
export interface RuntimeOptions {
  readonly config: RuntimeConfig;
  readonly store: CosmosStore;
  readonly github: GitHub['Service'];
  readonly validate: () => Effect.Effect<void, ServiceFailure>;
  readonly dispose: () => Promise<void>;
  readonly now: () => number;
  readonly diagnostic: DiagnosticSink;
  readonly event: (event: RuntimeEvent) => void;
  readonly signal?: AbortSignal;
}
export interface ServiceRuntime { readonly server: Server; readonly address: AddressInfo; readonly stop: () => Promise<void> }

/** Validate and recover before listening, then own requests, serial recovery and resource shutdown. */
export async function startServiceRuntime(options: RuntimeOptions): Promise<ServiceRuntime> {
  const { config } = options;
  const lifetime = new AbortController();
  let started = false;
  const externalAbort = () => { lifetime.abort(); if (started) void stop().catch(() => {}); };
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) lifetime.abort();
  const event = (value: RuntimeEvent) => { try { options.event(value); } catch { /* Diagnostics cannot alter lifecycle. */ } };
  let disposed = false;
  const dispose = async () => { if (!disposed) { disposed = true; await options.dispose(); } };
  const bounded = async (work: () => Effect.Effect<void, ServiceFailure>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    if (lifetime.signal.aborted) controller.abort();
    const timer = setTimeout(abort, config.sweepTimeoutSeconds * 1000);
    try { await Effect.runPromise(Effect.suspend(work), { signal: controller.signal }); }
    finally { clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); }
  };
  let server: Server | undefined;
  let loop: Promise<void> = Promise.resolve();
  const sockets = new Set<Socket>();
  const requests = new Set<RequestOwner & { readonly done: Promise<void> }>();
  let ready = false;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    ready = false;
    const closed = server ? new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeIdleConnections(); }) : Promise.resolve();
    lifetime.abort();
    options.signal?.removeEventListener('abort', externalAbort);
    await loop;
    const handlers = Promise.all([...requests].map((request) => request.done));
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([handlers, new Promise<void>((resolve) => { grace = setTimeout(resolve, config.shutdownGraceSeconds * 1000); })]);
    clearTimeout(grace);
    for (const request of requests) request.abort();
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    await Promise.all([...requests].map((request) => request.done));
    await closed;
    try { await dispose(); event('shutdown_succeeded'); } catch { event('shutdown_failed'); throw new Error('Service shutdown failed.'); }
  })();
  try {
    await bounded(options.validate);
    await bounded(options.store.sweepExpiredDevices);
    lifetime.signal.throwIfAborted();
    const core = await Effect.runPromise(makeService({ now: options.now, config, diagnostic: options.diagnostic }).pipe(
      Effect.provideService(Store, options.store), Effect.provideService(GitHub, options.github),
    ));
    const handler: typeof core = (request) => request.path.split('?')[0] !== '/readyz' ? core(request)
      : request.path !== '/readyz' || request.method !== 'GET' || request.body !== undefined
        ? Effect.fail(new ServiceFailure({ code: 'invalid' }))
        : ready && !lifetime.signal.aborted ? Effect.succeed({ status: 200, body: { status: 'ok' } }) : Effect.fail(new ServiceFailure({ code: 'unavailable' }));
    server = createServiceServer(handler, { beginRequest: () => {
      const controller = new AbortController(); let complete!: () => void;
      const done = new Promise<void>((resolve) => { complete = resolve; });
      const request = { signal: controller.signal, abort: () => controller.abort(), done, complete: () => { requests.delete(request); complete(); } };
      requests.add(request); return request;
    } });
    server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => lifetime.abort(), config.sweepTimeoutSeconds * 1000);
      const failed = () => { cleanup(); reject(new Error('Service startup failed.')); };
      const listening = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); server!.removeListener('error', failed); lifetime.signal.removeEventListener('abort', failed); };
      server!.once('error', failed); lifetime.signal.addEventListener('abort', failed, { once: true });
      if (lifetime.signal.aborted) { failed(); return; }
      server!.listen({ port: config.port, host: config.host, signal: lifetime.signal }, listening);
    });
    lifetime.signal.throwIfAborted();
    ready = true;
    loop = (async () => {
      while (!lifetime.signal.aborted) {
        try { await delay(config.sweepIntervalSeconds * 1000, undefined, { signal: lifetime.signal }); } catch { break; }
        if (lifetime.signal.aborted) break;
        try { await bounded(options.store.sweepExpiredDevices); if (!lifetime.signal.aborted) { const recovered = !ready; ready = true; if (recovered) event('recovery_succeeded'); } }
        catch { if (!lifetime.signal.aborted) { ready = false; event('recovery_failed'); } }
      }
    })();
    started = true;
    const address = server.address() as AddressInfo;
    event('startup_succeeded');
    return { server, address, stop };
  } catch {
    event('startup_failed');
    await stop().catch(() => {});
    throw new Error('Service startup failed.');
  }
}
