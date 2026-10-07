import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect, Exit, Scope } from 'effect';
import { captureAgentOutput, rotateAgentLog, startAgentLogRotation } from '../src/log.ts';

const fixture = async (t: { after: (cleanup: () => Promise<void>) => void }) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return join(root, 'agent.log');
};

test('rotation leaves a log below one MiB alone', async (t) => {
  const path = await fixture(t);
  const content = 'a'.repeat(1_048_575);
  await fs.writeFile(path, content);
  await rotateAgentLog(path);
  assert.equal(await fs.readFile(path, 'utf8'), content);
  assert.deepEqual(await fs.readdir(join(path, '..')), ['agent.log']);
});

test('rotation archives a log at exactly one MiB', async (t) => {
  const path = await fixture(t);
  const content = 'a'.repeat(1_048_576);
  await fs.writeFile(path, content);
  await rotateAgentLog(path);
  assert.equal(await fs.readFile(path, 'utf8'), '');
  assert.equal(await fs.readFile(path + '.1', 'utf8'), content);
});

test('rotation keeps the latest three archives in order', async (t) => {
  const path = await fixture(t);
  for (const marker of ['a', 'b', 'c', 'd']) {
    await fs.writeFile(path, marker.repeat(1_048_577));
    await rotateAgentLog(path);
  }
  assert.deepEqual(await fs.readdir(join(path, '..')), ['agent.log', 'agent.log.1', 'agent.log.2', 'agent.log.3']);
  for (const [suffix, marker] of [['1', 'd'], ['2', 'c'], ['3', 'b']]) {
    assert.equal(await fs.readFile(path + '.' + suffix, 'utf8'), marker!.repeat(1_048_577));
  }
});

test('an open append descriptor continues writing into the active log', async (t) => {
  const path = await fixture(t);
  const content = 'a'.repeat(1_048_576);
  await fs.writeFile(path, content);
  const writer = await fs.open(path, 'a');
  try {
    const before = await writer.stat();
    await rotateAgentLog(path);
    await writer.write('after rotation\n');
    assert.equal((await fs.stat(path)).ino, before.ino);
    assert.equal(await fs.readFile(path, 'utf8'), 'after rotation\n');
    assert.equal(await fs.readFile(path + '.1', 'utf8'), content);
  } finally {
    await writer.close();
  }
});

test('an absent log needs no rotation', async (t) => {
  const path = await fixture(t);
  await rotateAgentLog(path);
  assert.deepEqual(await fs.readdir(join(path, '..')), []);
});

test('failed archive copying preserves the active log and every existing archive', async (t) => {
  const path = await fixture(t);
  const content = 'a'.repeat(1_048_576);
  await fs.writeFile(path, content);
  for (const suffix of ['1', '2', '3']) await fs.writeFile(path + '.' + suffix, 'archive ' + suffix);
  t.mock.method(fs, 'copyFile', async (_source: string, destination: string) => {
    await fs.writeFile(destination, 'partial copy');
    throw new Error('copy failed');
  });
  await assert.rejects(rotateAgentLog(path), /copy failed/);
  assert.equal(await fs.readFile(path, 'utf8'), content);
  for (const suffix of ['1', '2', '3']) assert.equal(await fs.readFile(path + '.' + suffix, 'utf8'), 'archive ' + suffix);
  assert.deepEqual(await fs.readdir(join(path, '..')), ['agent.log', 'agent.log.1', 'agent.log.2', 'agent.log.3']);
});

test('scoped rotation checks immediately and periodically, then stops on close', async (t) => {
  const path = await fixture(t);
  await fs.writeFile(path, 'a'.repeat(1_048_576));
  const scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(startAgentLogRotation(path, { intervalMs: 5 }).pipe(Scope.provide(scope)));
    assert.equal(await fs.readFile(path, 'utf8'), '');
    await fs.writeFile(path, 'b'.repeat(1_048_576));
    for (let i = 0; i < 200 && (await fs.stat(path)).size > 0; i++) await delay(5);
    assert.equal(await fs.readFile(path + '.1', 'utf8'), 'b'.repeat(1_048_576));
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
  await fs.writeFile(path, 'c'.repeat(1_048_576));
  await delay(25);
  assert.equal((await fs.stat(path)).size, 1_048_576);
});

test('checks serialize and closing waits for the active check', async (t) => {
  const path = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let checks = 0;
  let active = 0;
  let maximum = 0;
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(startAgentLogRotation(path, {
    intervalMs: 5,
    rotate: async () => {
      checks++;
      active++;
      maximum = Math.max(maximum, active);
      if (checks === 2) {
        entered();
        await gate;
      }
      active--;
    },
  }).pipe(Scope.provide(scope)));
  try {
    await Promise.race([running, delay(1000)]);
    assert.ok(checks >= 2, 'the periodic check never started');
    await delay(25);
    let closed = false;
    const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => { closed = true; });
    await delay(10);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(maximum, 1);
    const finalChecks = checks;
    await delay(25);
    assert.equal(checks, finalChecks);
  } finally {
    release();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test('a rotation failure reports once per check and later checks still rotate', async (t) => {
  const path = await fixture(t);
  await fs.writeFile(path, 'a'.repeat(1_048_576));
  const errors: unknown[] = [];
  let checks = 0;
  const scope = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(startAgentLogRotation(path, {
      intervalMs: 5,
      rotate: async (logPath) => {
        if (checks++ === 0) throw new Error('copy failed');
        await rotateAgentLog(logPath);
      },
      report: (error) => { errors.push(error); },
    }).pipe(Scope.provide(scope)));
    assert.equal(errors.length, 1);
    for (let i = 0; i < 200 && (await fs.stat(path)).size > 0; i++) await delay(5);
    assert.equal(await fs.readFile(path, 'utf8'), '');
    assert.equal(errors.length, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

const output = () => {
  const chunks: string[] = [];
  const stream = new Writable({ write: (chunk, _encoding, done) => { chunks.push(chunk.toString()); done(); } });
  return { stream, chunks };
};

test('scoped output capture appends stdout and stderr, preserves callbacks and restores both writers', async (t) => {
  const path = await fixture(t);
  await fs.writeFile(path, 'existing\n');
  const stdout = output();
  const stderr = output();
  const originalOut = stdout.stream.write;
  const originalErr = stderr.stream.write;
  let intercepted!: typeof originalOut;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* captureAgentOutput(path, { stdout: stdout.stream, stderr: stderr.stream });
    intercepted = stdout.stream.write;
    yield* Effect.promise(async () => {
      await new Promise<void>((resolve, reject) => stdout.stream.write('stdout\n', (error) => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => stderr.stream.write('c3a9', 'hex', (error) => error ? reject(error) : resolve()));
      assert.equal(stdout.stream.write(Buffer.from(' buffer\n')), true);
    });
  })));
  assert.equal(await fs.readFile(path, 'utf8'), 'existing\nstdout\né buffer\n');
  assert.deepEqual(stdout.chunks, []);
  assert.deepEqual(stderr.chunks, []);
  assert.equal(stdout.stream.write, originalOut);
  assert.equal(stderr.stream.write, originalErr);
  stdout.stream.write('restored');
  assert.deepEqual(stdout.chunks, ['restored']);
  assert.throws(() => intercepted('closed'), /EBADF/);
});

test('captured output follows the active file through rotation', async (t) => {
  const path = await fixture(t);
  const stdout = output().stream;
  const stderr = output().stream;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* captureAgentOutput(path, { stdout, stderr });
    stdout.write('a'.repeat(1_048_576));
    yield* Effect.promise(() => rotateAgentLog(path));
    stderr.write('after rotation\n');
  })));
  assert.equal(await fs.readFile(path, 'utf8'), 'after rotation\n');
  assert.equal(await fs.readFile(path + '.1', 'utf8'), 'a'.repeat(1_048_576));
});

test('failed capture acquisition leaves the original writers in place', async (t) => {
  const path = await fixture(t);
  await fs.mkdir(path);
  const stdout = output().stream;
  const stderr = output().stream;
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const exit = await Effect.runPromiseExit(Effect.scoped(captureAgentOutput(path, { stdout, stderr })));
  assert.ok(Exit.isFailure(exit));
  assert.equal(stdout.write, originalOut);
  assert.equal(stderr.write, originalErr);
});
