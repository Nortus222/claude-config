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
test('executable starts on the Node 24 baseline without import.meta.main, from root or workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-compat-'));
  try {
    for (const [cwd, entry] of [[new URL('../../../', import.meta.url), 'apps/service/src/main.ts'], [new URL('../', import.meta.url), 'src/main.ts']] as const) {
      await assert.rejects(promisify(execFile)(process.execPath, ['--import', new URL('./support/main-compat-loader.mjs', import.meta.url).href, entry], {
        cwd, env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 3000,
      }), (error: unknown) => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'startup_failed\n'); return true;
      });
    }
    const imported = await promisify(execFile)(process.execPath, ['--import', new URL('./support/main-compat-loader.mjs', import.meta.url).href,
      '--input-type=module', '--eval', `await import(${JSON.stringify(new URL('../src/main.ts', import.meta.url).href)}); console.log('imported');`], {
      cwd: new URL('../../../', import.meta.url), env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 3000,
    });
    assert.equal(imported.stdout, 'imported\n'); assert.equal(imported.stderr, '');
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('invalid executable configuration exits nonzero with constant redacted failure before resource construction', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['apps/service/src/main.ts'], { cwd: new URL('../../../', import.meta.url), env: { HOME: home, PATH: '/usr/bin:/bin', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'http://PRIVATE_ENDPOINT' }, timeout: 3000 }), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }; assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'startup_failed\n'); return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('executable isolates malformed SDK logging environment before any SDK initialization', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-log-config-'));
  try {
    await assert.rejects(promisify(execFile)(process.execPath, ['apps/service/src/main.ts'], {
      cwd: new URL('../../../', import.meta.url), timeout: 3000,
      env: { HOME: home, PATH: '/usr/bin:/bin', AZURE_LOG_LEVEL: 'PRIVATE_LOG_VALUE', TYPESPEC_RUNTIME_LOG_LEVEL: 'PRIVATE_TYPESPEC_VALUE', AZURE_COSMOSDB_DIAGNOSTICS_LEVEL: 'PRIVATE_COSMOS_VALUE', DEBUG: '*', NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'http://PRIVATE_ENDPOINT' },
    }), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'startup_failed\n'); return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('executable suppresses enabled SDK endpoint and upstream-body logs through an inert real Cosmos request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-log-sdk-'));
  try {
    for (const logging of [{ AZURE_LOG_LEVEL: 'warning', TYPESPEC_RUNTIME_LOG_LEVEL: 'warning' }, { DEBUG: '*' }, { DEBUG: 'azure:*,typeSpecRuntime:*' },
      { AZURE_LOG_LEVEL: 'verbose', TYPESPEC_RUNTIME_LOG_LEVEL: 'verbose', AZURE_COSMOSDB_DIAGNOSTICS_LEVEL: 'debug-unsafe', DEBUG: '*' }]) {
      await assert.rejects(promisify(execFile)(process.execPath, ['--import', new URL('./support/main-inert-sdk-loader.mjs', import.meta.url).href, 'apps/service/src/main.ts'], {
        cwd: new URL('../../../', import.meta.url), timeout: 3000,
        env: { HOME: home, PATH: '/usr/bin:/bin', ...environment, NORTUSCC_SERVICE_COSMOS_ENDPOINT: 'http://127.0.0.1:9/', NORTUSCC_SERVICE_LOCAL_EMULATOR: 'true', NORTUSCC_SERVICE_EMULATOR_KEY: 'inert-key', ...logging },
      }), (error: unknown) => {
        const result = error as { code: number; stdout: string; stderr: string };
        assert.equal(result.code, 1); assert.equal(result.stdout, 'inert_cosmos_request\n'); assert.equal(result.stderr, 'startup_failed\nshutdown_succeeded\n'); return true;
      });
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('importing main leaves caller logging, environment and signal ownership unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'service-main-import-'));
  try {
    const main = JSON.stringify(new URL('../src/main.ts', import.meta.url).href);
    const imported = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      const before = { ...process.env };
      const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      await import(${main});
      assert.deepEqual({ ...process.env }, before);
      assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], signals);
      console.log('imported');
    `], { cwd: new URL('../../../', import.meta.url), timeout: 3000, env: { HOME: home, PATH: '/usr/bin:/bin', AZURE_LOG_LEVEL: 'PRIVATE_LOG_VALUE', TYPESPEC_RUNTIME_LOG_LEVEL: 'PRIVATE_TYPESPEC_VALUE', AZURE_COSMOSDB_DIAGNOSTICS_LEVEL: 'PRIVATE_COSMOS_VALUE', DEBUG: '*' } });
    assert.equal(imported.stdout, 'imported\n'); assert.equal(imported.stderr, '');
    const caller = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { createClientLogger, getLogLevel } from '@azure/logger';
      import { createClientLogger as typeSpecLogger, getLogLevel as typeSpecLevel } from '@typespec/ts-http-runtime';
      const before = { ...process.env };
      await import(${main});
      assert.deepEqual({ ...process.env }, before);
      assert.equal(getLogLevel(), 'warning'); assert.equal(typeSpecLevel(), 'warning');
      createClientLogger('embedding').warning('caller-owned Azure log');
      typeSpecLogger('embedding').warning('caller-owned TypeSpec log');
    `], { cwd: new URL('../../../', import.meta.url), timeout: 3000, env: { HOME: home, PATH: '/usr/bin:/bin', AZURE_LOG_LEVEL: 'warning', TYPESPEC_RUNTIME_LOG_LEVEL: 'warning', AZURE_COSMOSDB_DIAGNOSTICS_LEVEL: 'debug-unsafe' } });
    assert.equal(caller.stdout, '');
    assert.match(caller.stderr, /azure:embedding:warning caller-owned Azure log/);
    assert.match(caller.stderr, /typeSpecRuntime:embedding:warning caller-owned TypeSpec log/);
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

test('unsupported production federation is rejected before resources and signal handlers are constructed', async () => {
  for (const file of ['', '/inert/federated-token']) {
    const signals = new EventEmitter(); const events: string[] = []; let constructors = 0;
    await assert.rejects(launchService({ environment: { ...environment, AZURE_FEDERATED_TOKEN_FILE: file }, signals, now: Date.now, diagnostic: () => {}, event: (event) => events.push(event), resources: () => { constructors++; throw new Error('resources must not be constructed'); } }), /Service startup failed/);
    assert.equal(constructors, 0); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0); assert.deepEqual(events, ['startup_failed']);
  }
});
