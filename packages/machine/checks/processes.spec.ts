import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

// A POSIX shell script; the .cmd shim tests cover PATH lookup on Windows.
test('the path option replaces PATH for the child', { skip: process.platform === 'win32' }, async () => {
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

test('the env option is the child\'s whole environment', async () => {
  const exit = await Effect.runPromiseExit(
    Processes.use((p) => p.run({ cmd: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify([process.env.ONLY_HERE, process.env.HOME ?? null]))'], output: 'capture' }))
      .pipe(Effect.provide(nodeProcesses({ env: { ONLY_HERE: 'yes' } }))),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.deepEqual(Exit.isSuccess(exit) && JSON.parse(exit.value.stdout), ['yes', null]);
});

test('inherit: stderr sends an inherit command\'s output to stderr and gives it no stdin', () => {
  const processes = pathToFileURL(join(import.meta.dirname, '..', 'src', 'processes.ts')).href;
  const script = `
    import { Effect } from 'effect';
    import { Processes, nodeProcesses } from ${JSON.stringify(processes)};
    await Effect.runPromise(Processes.use((p) => p.run({
      cmd: process.execPath,
      args: ['-e', 'let got = ""; process.stdin.on("data", (c) => { got += c; }); process.stdin.on("end", () => console.log("noise stdin=" + JSON.stringify(got)));'],
      output: 'inherit',
    })).pipe(Effect.provide(nodeProcesses({ inherit: 'stderr' }))));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: join(import.meta.dirname, '..'), input: 'a protocol request\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /noise stdin=""/);
});

// An npm-style .cmd shim on PATH that hands its arguments to a node script.
const windowsShim = (name: string, script: string) => {
  const bin = mkdtempSync(join(tmpdir(), 'machine-shim-'));
  writeFileSync(join(bin, `${name}.js`), script);
  writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"${node}" "%~dp0${name}.js" %*\r\n`);
  return { bin, path: `${bin};${process.env.SystemRoot ?? 'C:\\Windows'}\\System32` };
};

test('a .cmd shim on PATH runs by bare name with its arguments verbatim', { skip: process.platform !== 'win32' }, async () => {
  const { path } = windowsShim('fakeshim', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const args = ['plain', 'with space', 'a"quote', 'amp&echo pwned', 'caret^', '%PATH%', 'bang!', 'pipe|more', 'trail\\','"', ''];
  const exit = await run(Processes.use((p) => p.run({ cmd: 'fakeshim', args, output: 'capture' })), path);
  assert.ok(Exit.isSuccess(exit), String(Exit.isFailure(exit) && exit.cause));
  assert.deepEqual(Exit.isSuccess(exit) && JSON.parse(exit.value.stdout), args);
});

test('a .cmd shim refuses a line break it cannot pass, naming the command', { skip: process.platform !== 'win32' }, async () => {
  const { path } = windowsShim('fakeshim', 'console.log("ran")');
  const exit = await run(Processes.use((p) => p.run({ cmd: 'fakeshim', args: ['one\ntwo'], output: 'capture' })), path);
  assert.ok(Exit.isFailure(exit) && String(exit.cause).includes('LaunchFailed') && String(exit.cause).includes('fakeshim'));
});

test('interrupting a .cmd shim run kills the program the shim started', { skip: process.platform !== 'win32' }, async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'machine-proc-')), 'pid');
  const { path } = windowsShim('sleepshim', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Processes.use((p) => p.run({ cmd: 'sleepshim', args: [], output: 'capture' })));
    for (let i = 0; i < 250 && !existsSync(pidFile); i++) yield* Effect.promise(() => sleep(20));
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(nodeProcesses({ path }))));
  await sleep(200);
  assert.equal(pidAlive(Number(readFileSync(pidFile, 'utf8'))), false);
});
