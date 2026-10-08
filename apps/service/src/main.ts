import { CosmosClient } from '@azure/cosmos';
import { ManagedIdentityCredential } from '@azure/identity';
import { createDefaultHttpClient } from '@azure/core-rest-pipeline';
import { parseServiceEnvironment, type RuntimeConfig } from './config.ts';
import { makeProductionResources } from './production.ts';
import { startServiceRuntime, type RuntimeOptions, type RuntimeEvent, type ServiceRuntime } from './runtime.ts';
import type { DiagnosticSink } from './diagnostics.ts';

export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
export interface LaunchOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly resources: (config: RuntimeConfig) => ReturnType<typeof makeProductionResources>;
  readonly signals: SignalSource;
  readonly now: () => number;
  readonly diagnostic: DiagnosticSink;
  readonly event: (event: RuntimeEvent) => void;
  readonly shutdownFailure?: () => void;
  readonly start?: (options: RuntimeOptions) => Promise<ServiceRuntime>;
}
/** Compose injected resources and install only the signal handlers this launch owns. */
export async function launchService(options: LaunchOptions) {
  let startupFailureEmitted = false;
  const event = (value: RuntimeEvent) => {
    if (value === 'startup_failed') startupFailureEmitted = true;
    try { options.event(value); } catch { /* Diagnostics cannot change lifecycle. */ }
  };
  let remove = () => {};
  try {
    const config = parseServiceEnvironment(options.environment);
    const controller = new AbortController();
    let runtime: ServiceRuntime | undefined;
    let stopping: Promise<void> | undefined;
    let starting: Promise<ServiceRuntime>;
    const stop = () => stopping ??= (async () => {
      controller.abort();
      try { await starting.catch(() => undefined); await runtime?.stop(); } finally { remove(); }
    })();
    const interrupt = () => { void stop().catch(() => { options.shutdownFailure?.(); }); };
    remove = () => { options.signals.removeListener('SIGINT', interrupt); options.signals.removeListener('SIGTERM', interrupt); };
    options.signals.on('SIGINT', interrupt); options.signals.on('SIGTERM', interrupt);
    starting = Promise.resolve().then(() => (options.start ?? startServiceRuntime)({ config, ...options.resources(config), now: options.now,
      diagnostic: options.diagnostic, event, signal: controller.signal })).then((value) => { runtime = value; return value; });
    runtime = await starting;
    return { runtime, stop };
  } catch {
    remove(); if (!startupFailureEmitted) event('startup_failed');
    throw new Error('Service startup failed.');
  }
}

if (import.meta.main) {
  try {
    await launchService({ environment: process.env, signals: process, now: Date.now, diagnostic: () => {},
      event: (event) => { process.stderr.write(`${event}\n`); }, shutdownFailure: () => { process.exitCode = 1; },
      resources: (config) => makeProductionResources(config, {
        credential: (options) => new ManagedIdentityCredential(options),
        identityTransport: createDefaultHttpClient(),
        client: (options) => new CosmosClient(options), fetch: globalThis.fetch, now: Date.now,
      }),
    });
  } catch { process.exitCode = 1; }
}
