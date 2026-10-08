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
