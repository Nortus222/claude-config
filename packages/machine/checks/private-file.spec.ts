import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lstat, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Fiber, Layer } from 'effect';
import { privateFile, Processes } from '../src/index.ts';

test('private-file interruption waits for helper cleanup and removes its staging file', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'machine-private-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'agent', 'machine-token');
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let cleaning!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => { cleaning = resolve; });
  let releaseHelper!: () => void;
  let finishCleanup!: () => void;
  const processes = Layer.succeed(Processes, { run: (command) => {
    const input = JSON.parse(command.input!);
    if (input.action === 'protect' && input.path.endsWith('.tmp')) return Effect.callback((resume) => {
      releaseHelper = () => resume(Effect.succeed({ code: 0, stdout: '', stderr: '' }));
      ready();
      return Effect.callback<void>((complete) => {
        finishCleanup = () => complete(Effect.void);
        cleaning();
      });
    });
    return Effect.succeed({ code: 0, stdout: '', stderr: '' });
  } });
  const fiber = Effect.runFork(privateFile(path, { platform: 'win32', processes }).write('private-token'));
  await started;
  let interrupted = false;
  const stopping = Effect.runPromise(Fiber.interrupt(fiber)).then(() => { interrupted = true; });
  await cleanupStarted;
  assert.equal(interrupted, false);
  finishCleanup();
  await stopping;
  releaseHelper();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(directory, 'agent')), []);
});

test('private-file write twice over the same protected directory succeeds on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'machine-private-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = privateFile(join(directory, 'agent', 'machine-token'));
  await Effect.runPromise(file.write('first'));
  await Effect.runPromise(file.write('second'));
  assert.equal(await Effect.runPromise(file.read()), 'second');
});

test('a Windows write protects each path once and re-checks only before replacing the file', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'machine-private-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'agent');
  const path = join(folder, 'machine-token');
  const calls: string[] = [];
  const processes = Layer.succeed(Processes, { run: (command) => Effect.sync(() => {
    const input = JSON.parse(command.input!);
    calls.push(`${input.action} ${input.path === folder ? 'directory' : input.path === path ? 'file' : 'staging'}`);
    return { code: 0, stdout: '', stderr: '' };
  }) });
  const file = privateFile(path, { platform: 'win32', processes });
  await Effect.runPromise(file.write('first'));
  // Protecting verifies the result, so the directory is checked again only after the staging file is written.
  assert.deepEqual(calls, ['protect directory', 'protect staging', 'check directory']);
  calls.length = 0;
  await Effect.runPromise(file.write('second'));
  assert.deepEqual(calls, ['protect directory', 'check file', 'protect staging', 'check directory', 'check file']);
});
