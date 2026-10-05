import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect, Exit, Fiber } from 'effect';
import { nodeProcesses, Processes } from '../src/index.ts';

const node = process.execPath;
const run = <A, E>(effect: Effect.Effect<A, E, Processes>, path?: string) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(nodeProcesses(path ? { path } : {}))));
const exec = (args: string[]) => Processes.use((p) => p.run({ cmd: node, args, output: 'capture' }));

test('captures stdout and the exit code', async () => {
  const exit = await run(exec(['-e', 'console.log("hi"); process.exit(3)']));
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(Exit.isSuccess(exit) && exit.value, { code: 3, stdout: 'hi\n' });
});

test('a command that cannot launch fails with LaunchFailed', async () => {
  const exit = await run(Processes.use((p) => p.run({ cmd: '/no/such/tool', args: [], output: 'capture' })));
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LaunchFailed'));
});

test('the path option replaces PATH for the child', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'machine-bin-'));
  writeFileSync(join(bin, 'faketool'), '#!/bin/sh\necho fake\n');
  chmodSync(join(bin, 'faketool'), 0o755);
  const exit = await run(Processes.use((p) => p.run({ cmd: 'faketool', args: [], output: 'capture' })), `${bin}:/usr/bin:/bin`);
  assert.ok(Exit.isSuccess(exit) && exit.value.stdout === 'fake\n');
});

test('interrupting a run kills the whole process group', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-proc-'));
  const pidFile = join(dir, 'grandchild');
  const script = `const c = require('node:child_process').spawn('sleep', ['30']);`
    + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(['-e', script]));
    while (!existsSync(pidFile)) yield* Effect.promise(() => sleep(20));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses())));
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await sleep(200);
  assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
});

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('interrupting kills a grandchild that outlives its exited leader in capture mode', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'machine-proc-'));
  const pidFile = join(dir, 'grandchild');
  const script = `const c = require('node:child_process').spawn('sleep', ['30'], { stdio: ['ignore', 'inherit', 'inherit'] });`
    + `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); process.exit(0);`;
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(['-e', script]));
    while (!existsSync(pidFile)) yield* Effect.promise(() => sleep(20));
    yield* Effect.promise(() => sleep(100));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses())));
  const grandchild = Number(readFileSync(pidFile, 'utf8'));
  await sleep(200);
  assert.equal(pidAlive(grandchild), false);
});

test('a child that ignores SIGTERM is killed by the SIGKILL escalation', { skip: process.platform === 'win32' }, async () => {
  const started = Date.now();
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(['-e', `process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);`]));
    yield* Effect.promise(() => sleep(500));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses())));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1400 && elapsed < 3000, `elapsed ${elapsed}`);
});

test('interrupting after the child already closed returns promptly', async () => {
  const started = Date.now();
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(exec(['-e', '0']));
    yield* Effect.promise(() => sleep(500));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses())));
  assert.ok(Date.now() - started < 1200);
});
