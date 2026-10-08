import { registerAuthContract } from './support/auth-contract.ts';
import { memoryServiceStore } from './support/service-contract.ts';

import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { deviceStart, devicePoll } from '../src/auth.ts';
import { makeMemoryStore } from '../src/memory-store.ts';
import { makeGitHub } from '../src/github-http.ts';
import { fakeGitHub } from './support/fake-github.ts';

registerAuthContract('memory', memoryServiceStore);

const description = { name: 'Machine', os: 'linux', agents: ['codex'] };
test('device start floors remaining upstream deadline and never stores an expired response', async () => {
  const store = makeMemoryStore(); const github = fakeGitHub().service;
  let now = 10000;
  const production = makeGitHub({ clientId: 'publicClient', now: () => now, fetch: async () => {
    now += 2500;
    return new Response(JSON.stringify({ device_code: 'PRIVATE', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 12 }));
  } });
  const requestDevice = production.requestDevice;
  const start = await Effect.runPromise(deviceStart(store, { ...github, requestDevice }, description, () => now));
  const body = start.body as { expiresIn: number; pendingId: string };
  assert.equal(body.expiresIn, 9);
  const snapshot = await Effect.runPromise(store.readPartition('identities', `device:${body.pendingId}`));
  assert.ok(snapshot.documents[0].type === 'deviceSession');
  assert.ok(snapshot.documents[0].expiresAt <= 22000);
  assert.ok(snapshot.documents[0].expiresAt <= snapshot.documents[0].createdAt + 900000);
  let writes = 0;
  const expired = { ...store, commitPartition: (...args: Parameters<typeof store.commitPartition>) => { writes++; return store.commitPartition(...args); } };
  const result = await Effect.runPromise(deviceStart(expired, { ...github, requestDevice: () => Effect.succeed({ deviceCode: 'PRIVATE', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 12, expiresAt: now }) }, description, () => now).pipe(Effect.result));
  assert.equal(result._tag, 'Failure'); assert.equal(writes, 0);
});
test('upstream slowdown interval controls next poll without another exchange', async () => {
  const store = makeMemoryStore(); const github = fakeGitHub(); let now = 10000;
  const start = await Effect.runPromise(deviceStart(store, github.service, description, () => now));
  const body = start.body as { pendingId: string };
  let calls = 0;
  const service = { ...github.service, exchange: () => { calls++; return Effect.succeed({ type: 'slow-down' as const, interval: 20 }); } };
  const poll = () => Effect.runPromise(devicePoll(store, service, { pendingId: body.pendingId }, { openSignup: true, allowlistedLogins: [], pollAfter: 900 }, () => now));
  now += 5000; assert.deepEqual((await poll()).body, { interval: 20 });
  now += 19000; assert.deepEqual((await poll()).body, { interval: 20 }); assert.equal(calls, 1);
  now += 1000; assert.deepEqual((await poll()).body, { interval: 25 }); assert.equal(calls, 2);
});

test('absolute deadline never bypasses validation of an upstream duration', async () => {
  for (const expiresIn of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const github = fakeGitHub().service; const store = makeMemoryStore(); let writes = 0;
    const guarded = { ...store, commitPartition: (...args: Parameters<typeof store.commitPartition>) => { writes++; return store.commitPartition(...args); } };
    const result = await Effect.runPromise(deviceStart(guarded, { ...github, requestDevice: () => Effect.succeed({ deviceCode: 'PRIVATE', userCode: 'ABCD', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn, expiresAt: 22000 }) }, description, () => 10000).pipe(Effect.result));
    assert.equal(result._tag, 'Failure'); assert.equal(writes, 0);
  }
});
