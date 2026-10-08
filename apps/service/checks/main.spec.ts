import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { launchService } from '../src/main.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { fakeGitHub } from './support/fake-github.ts';
const environment = { NORTUSCC_SERVICE_GITHUB_CLIENT_ID: 'client', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'https://example.documents.azure.com/', NORTUSCC_SERVICE_COSMOS_DATABASE: 'metadata' };
test('invalid executable configuration exits nonzero with constant redacted failure before resource construction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['apps/service/src/main.ts'], { cwd: new URL('../../../', import.meta.url), env: { HOME: home, PATH: '/usr/bin:/bin', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'http://PRIVATE_ENDPOINT' }, timeout: 3000 }), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }; assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'startup_failed\n'); return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('launcher owns signal handlers, cancels startup and removes handlers after startup failure', async () => {
  const signals = new EventEmitter(); let disposed = 0; let aborted = false; const events: string[] = [];
  const starting = launchService({ environment, signals, now: Date.now, diagnostic: () => {}, event: (event) => events.push(event), resources: () => ({ store: { ...makeMemoryStore(), sweepExpiredDevices: () => Effect.void }, github: fakeGitHub().service, validate: () => Effect.promise((signal) => new Promise<void>(() => { signal.addEventListener('abort', () => { aborted = true; }); signals.emit('SIGTERM'); })), dispose: async () => { disposed++; } }) });
  await assert.rejects(starting, /Service startup failed/); assert.equal(aborted, true); assert.equal(disposed, 1); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(events.filter((event) => event === 'startup_failed').length, 1);
});
test('launcher routes SIGINT and SIGTERM to the same idempotent stop and removes handlers', async () => {
  const signals = new EventEmitter(); let disposed = 0;
  const launched = await launchService({ environment: { ...environment, NORTUSCC_SERVICE_PORT: '8080' }, signals, now: Date.now, diagnostic: () => {}, event: () => {}, resources: () => ({ store: { ...makeMemoryStore(), sweepExpiredDevices: () => Effect.void }, github: fakeGitHub().service, validate: () => Effect.void, dispose: async () => { disposed++; } }),
    start: (options) => import('../src/runtime.ts').then(({ startServiceRuntime }) => startServiceRuntime({ ...options, config: { ...options.config, port: 0 } })),
  });
  signals.emit('SIGINT'); signals.emit('SIGTERM'); await launched.stop(); assert.equal(disposed, 1); assert.equal(launched.runtime.server.listening, false); assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});
